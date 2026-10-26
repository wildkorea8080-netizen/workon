import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import {
  REPLAY_BUDGET_MS,
  REPLAY_MAX_PAGES,
  REPLAY_MIN_INTERVAL_MS,
  replayNodaEvents,
  type ReplayDeps,
} from '@/lib/noda-events';
import { NodaError, type NodaEventPage } from '@/lib/noda';

/**
 * 놓친 웹훅 다시 받기 — NODA 일 장부(`GET /events`)를 웹훅과 같은 처리로 반영한다.
 * 1분에 한 번만, 짧게, 던지지 않고, 처리한 자리까지만 옮긴다.
 */

const T0 = Date.parse('2026-10-26T00:00:00Z');
const ev = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  event: 'document.ready',
  tenant: 'workon-a1',
  filename: 'f',
  ...extra,
});

function world(pages: NodaEventPage[], opts: { cursor?: string | null; claimed?: boolean } = {}) {
  let clock = T0;
  const saved: string[] = [];
  const applied: string[] = [];
  const sinces: (string | null | undefined)[] = [];
  const log = vi.fn(async () => {});
  const claim = vi.fn(async (_now: string, cutoff: string) => {
    expect(Date.parse(cutoff)).toBe(T0 - REPLAY_MIN_INTERVAL_MS);
    return opts.claimed === false ? undefined : { cursor: opts.cursor ?? null };
  });
  const save = vi.fn(async (c: string) => {
    saved.push(c);
  });
  const listEvents = vi.fn(async (o?: { since?: string | null }) => {
    sinces.push(o?.since);
    clock += 10;
    const p = pages.shift();
    if (!p) throw new Error('더 부르면 안 됨');
    return p;
  });
  const apply = vi.fn(async (e: Record<string, unknown>) => {
    applied.push(e.id as string);
  });
  const deps: ReplayDeps = {
    store: { claim, save },
    noda: { listEvents },
    apply,
    now: () => clock,
    log,
  };
  return {
    deps, saved, applied, sinces, log, claim, save, listEvents, apply,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const logged = (log: ReturnType<typeof vi.fn>) => log.mock.calls as unknown as [Record<string, unknown>][];

describe('replayNodaEvents', () => {
  it('1분 안에 다른 요청이 돌았으면(차지 못함) 장부를 부르지 않는다', async () => {
    const w = world([], { claimed: false });
    expect(await replayNodaEvents(w.deps)).toEqual({ status: 'skipped', processed: 0, gap: false });
    expect(w.listEvents).not.toHaveBeenCalled();
  });

  it('마지막 자리부터 받아 일마다 처리하고 자리를 옮긴다 — more면 이어 부른다', async () => {
    const w = world(
      [
        { events: [ev('101'), ev('102')], next: '102', more: true, gap: false },
        { events: [ev('103')], next: '103', more: false, gap: false },
      ],
      { cursor: '100' },
    );
    expect(await replayNodaEvents(w.deps)).toEqual({ status: 'done', processed: 3, gap: false });
    expect(w.sinces).toEqual(['100', '102']);
    expect(w.applied).toEqual(['101', '102', '103']);
    expect(w.saved).toEqual(['101', '102', '103']);
  });

  it('처음(자리 없음)이면 since 없이 부르고, 빈 쪽은 자리를 옮기지 않는다', async () => {
    const w = world([{ events: [], next: null, more: false, gap: false }]);
    expect(await replayNodaEvents(w.deps)).toMatchObject({ status: 'done', processed: 0 });
    expect(w.sinces).toEqual([null]);
    expect(w.saved).toEqual([]);
  });

  it('일 하나를 처리하다 던지면 거기서 멈추고 그 앞까지만 자리를 옮긴다(다음에 그 일부터)', async () => {
    const w = world([{ events: [ev('201'), ev('202'), ev('203')], next: '203', more: false, gap: false }], { cursor: '200' });
    w.apply.mockImplementation(async (e: Record<string, unknown>) => {
      if (e.id === '202') throw new Error('db down');
    });
    expect(await replayNodaEvents(w.deps)).toEqual({ status: 'partial', processed: 1, gap: false });
    expect(w.saved).toEqual(['201']);
    expect(logged(w.log)[0][0]).toMatchObject({ level: 'warning', details: { event_id: '202', event: 'document.ready' } });
    // 파일 이름은 운영 기록에 남기지 않는다
    expect(JSON.stringify(w.log.mock.calls)).not.toContain('"f"');
  });

  it('장부를 못 읽으면 자리는 그대로, 운영 기록에 요청 번호와 함께', async () => {
    const w = world([], { cursor: '300' });
    w.listEvents.mockRejectedValue(new NodaError('NODA 503', 'http', 503, null, 'rid-9'));
    expect(await replayNodaEvents(w.deps)).toEqual({ status: 'failed', processed: 0, gap: false });
    expect(w.saved).toEqual([]);
    expect(logged(w.log)[0][0]).toMatchObject({ details: { code: 'http', status: 503, request_id: 'rid-9' } });
  });

  it('gap이면 한 번 기록하고 이어 간다', async () => {
    const w = world([{ events: [ev('401')], next: '401', more: false, gap: true }], { cursor: '1' });
    expect(await replayNodaEvents(w.deps)).toEqual({ status: 'done', processed: 1, gap: true });
    expect(w.log).toHaveBeenCalledTimes(1);
    expect(w.saved).toEqual(['401']);
  });

  it('쪽 수 상한·시간 예산을 넘기면 partial로 멈춘다(남은 것은 다음에)', async () => {
    const many: NodaEventPage[] = Array.from({ length: REPLAY_MAX_PAGES + 2 }, (_, i) => ({
      events: [ev(String(500 + i))],
      next: String(500 + i),
      more: true,
      gap: false,
    }));
    const w = world(many);
    expect((await replayNodaEvents(w.deps)).status).toBe('partial');
    expect(w.listEvents).toHaveBeenCalledTimes(REPLAY_MAX_PAGES);

    const slow = world([{ events: [ev('601')], next: '601', more: true, gap: false }]);
    slow.apply.mockImplementation(async () => {
      slow.advance(REPLAY_BUDGET_MS);
    });
    expect((await replayNodaEvents(slow.deps)).status).toBe('partial');
    expect(slow.listEvents).toHaveBeenCalledTimes(1);
  });

  it('자리 차지·저장이 실패해도 던지지 않는다', async () => {
    const a = world([]);
    a.claim.mockRejectedValue(new Error('db'));
    expect((await replayNodaEvents(a.deps)).status).toBe('failed');
    const b = world([{ events: [ev('701')], next: '701', more: false, gap: false }]);
    b.save.mockRejectedValue(new Error('db'));
    expect(await replayNodaEvents(b.deps)).toMatchObject({ status: 'partial', processed: 1 });
  });
});

describe('다시 받기를 부르는 곳', () => {
  it('문서 목록·공통 자료실 목록이 맞추기 전에 부른다', () => {
    for (const f of ['src/app/api/documents/route.ts', 'src/app/api/super/common-documents/route.ts']) {
      const src = readFileSync(f, 'utf8');
      const get = src.slice(src.indexOf('export async function GET'));
      expect(get).toContain('await replayNodaEvents()');
      expect(get.indexOf('replayNodaEvents()')).toBeLessThan(get.indexOf('reconcileReading('));
    }
  });

  it('예약 작업 라우트는 CRON_SECRET으로만 열리고(없으면 503) vercel.json이 하루 한 번 부른다', () => {
    const src = readFileSync('src/app/api/cron/noda-events/route.ts', 'utf8');
    expect(src).toContain('CRON_SECRET');
    expect(src).toContain('timingSafeEqual');
    expect(src).toMatch(/status: 503/);
    expect(src).toMatch(/status: 401/);
    const vercel = JSON.parse(readFileSync('vercel.json', 'utf8'));
    expect(vercel.crons).toEqual([{ path: '/api/cron/noda-events', schedule: '0 18 * * *' }]);
  });
});
