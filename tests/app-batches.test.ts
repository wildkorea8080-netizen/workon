import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
import { BATCH_MAX_ROWS, parseBatchTable, normalizeBatchName } from '@/lib/apps/batch-spec';
import { BATCH_START_WINDOW_MS, runDueBatchItems, type BatchDeps, type BatchItemRun, type ItemPatch } from '@/lib/apps/batches';
import { runAppAs, type RunAsIo, type RunAsOutcome } from '@/lib/apps/run-as';
import { previewBatch } from '@/components/apps/AppBatchPanel';
import type { AppDefinition } from '@/lib/apps/definition';

/** 입력형 앱 일괄 실행(0077) — 표 읽기·미리 보기·실행기·결과 가리키기 */

const fields = [{ key: 'topic', label: '주제' }, { key: 'detail', label: '세부 내용' }];
const definition: AppDefinition = { schemaVersion: 1, output: 'bullets', fields: [
  { key: 'topic', label: '주제', type: 'text', required: true },
  { key: 'detail', label: '세부 내용', type: 'textarea', required: false },
] };

describe('표 읽기', () => {
  it('엑셀에서 붙인 탭 표 — 머리글은 항목 이름이나 키(대소문자·공백 무시), 빈 줄은 건너뜀', () => {
    expect(parseBatchTable('주제\t세부  내용\n여비\t국내 출장\n\n복무\t\n', fields)).toEqual({ ok: true, rows: [{ topic: '여비', detail: '국내 출장' }, { topic: '복무', detail: '' }], expects: ['', ''] });
    expect(parseBatchTable('TOPIC\n여비', fields)).toEqual({ ok: true, rows: [{ topic: '여비' }], expects: [''] });
  });

  it('CSV — 따옴표 칸(쉼표·따옴표·줄바꿈)·BOM', () => {
    const csv = '﻿주제,세부 내용\r\n"여비, 일비","그는 ""급히"" 출장\n두 줄"\r\n복무,연가';
    expect(parseBatchTable(csv, fields)).toEqual({ ok: true, rows: [{ topic: '여비, 일비', detail: '그는 "급히" 출장\n두 줄' }, { topic: '복무', detail: '연가' }], expects: ['', ''] });
  });

  it('모르는 머리글·같은 항목 두 번·줄 없음·너무 많음·칸이 넘침은 오류', () => {
    expect(parseBatchTable('주제\t날짜\n여비\t1', fields)).toMatchObject({ ok: false, errors: [expect.stringContaining("'날짜'")] });
    expect(parseBatchTable('주제\ttopic\n여비\t여비', fields)).toMatchObject({ ok: false, errors: [expect.stringContaining('두 번')] });
    expect(parseBatchTable('주제\n', fields)).toMatchObject({ ok: false });
    expect(parseBatchTable('', fields)).toMatchObject({ ok: false });
    expect(parseBatchTable(`주제\n${Array.from({ length: BATCH_MAX_ROWS + 1 }, (_, i) => `q${i}`).join('\n')}`, fields)).toMatchObject({ ok: false, errors: [expect.stringContaining(`${BATCH_MAX_ROWS}줄`)] });
    // 첫 줄에 탭이 없으면 쉼표로 가른다
    expect(parseBatchTable('주제\n여비,넘침', fields)).toMatchObject({ ok: false, errors: [expect.stringContaining('2번째 줄')] });
    expect(parseBatchTable('주제\n여비\t넘침', fields)).toEqual({ ok: true, rows: [{ topic: '여비\t넘침' }], expects: [''] });
  });

  it('미리 보기 — 줄마다 앱 규칙(필수 항목)으로 검사하고 많으면 AI 호출 수를 더한다', () => {
    expect(previewBatch(definition, '주제\t세부 내용\n여비\t\n복무\t연가')).toEqual({ ok: true, rows: [{ topic: '여비', detail: '' }, { topic: '복무', detail: '연가' }], expects: ['', ''], maxCalls: 2 });
    expect(previewBatch(definition, '세부 내용\n연가')).toMatchObject({ ok: false, errors: [expect.stringMatching(/^1번째 줄:/)] });
  });

  it('이름 다듬기', () => {
    expect(normalizeBatchName('  11월‮ 민원  ')).toBe('11월 민원');
    expect(normalizeBatchName('')).toBeNull();
    expect(normalizeBatchName('x'.repeat(81))).toBeNull();
  });
});

describe('실행기', () => {
  const batch = { id: 'b1', organization_id: 'o1', department_id: 'd1', user_id: 'u1', agent_id: 'a1', app_version: 2, status: 'running' as const };
  const item = (position: number, over: Partial<BatchItemRun> = {}): BatchItemRun => ({ id: `i${position}`, batch_id: 'b1', position, inputs: { topic: `q${position}` }, status: 'pending', attempts: 0, claimed_at: null, batch, ...over });
  function deps(outcomes: RunAsOutcome[], items = [item(1), item(2), item(3)], over: Partial<BatchDeps> = {}) {
    const finished: Array<{ id: string; patch: ItemPatch }> = [];
    const stopped: Array<{ id: string; reason: string }> = [];
    const settled: string[] = [];
    let i = 0; let t = 0;
    const run = vi.fn(async () => outcomes[i++] ?? { kind: 'completed', conversationId: 'c', messageId: 'm' } as RunAsOutcome);
    const d: BatchDeps = {
      now: () => t, openItems: async () => items, claim: async () => true, run,
      finishItem: async (id, patch) => { finished.push({ id, patch }); },
      stop: async (id, reason) => { stopped.push({ id, reason }); },
      settle: async (id) => { settled.push(id); }, log: async () => {}, ...over,
    };
    return { d, finished, stopped, settled, run, advance: (ms: number) => { t += ms; } };
  }

  it('마친 줄은 대화·답변을 가리키고, 줄마다 묶음 마침을 확인한다', async () => {
    const t = deps([{ kind: 'completed', conversationId: 'c1', messageId: 'm1' }]);
    const out = await runDueBatchItems(t.d);
    expect(out).toMatchObject({ ran: 3, done: 3 });
    expect(t.finished.find((f) => f.id === 'i1')!.patch).toEqual({ status: 'done', attempts: 1, error: null, conversation_id: 'c1', message_id: 'm1' });
    expect(t.run).toHaveBeenCalledWith(expect.objectContaining({ id: 'i1' }), expect.any(Number));
    expect(t.settled).toEqual(['b1', 'b1', 'b1']);
  });

  it('앱 변경(409)·권한·계정·부서·한도는 묶음을 멈추고 남은 줄을 돌리지 않는다', async () => {
    const reasons: Array<[RunAsOutcome, RegExp]> = [
      [{ kind: 'rejected', status: 409, message: '바뀜' }, /앱 설정이 바뀌어/],
      [{ kind: 'rejected', status: 403, message: 'x' }, /더 쓸 수 없어/],
      [{ kind: 'rejected', status: 429, message: '이번 달 한도' }, /사용 한도.*이번 달 한도/],
      [{ kind: 'user_unavailable' }, /계정/],
      [{ kind: 'department_changed' }, /부서/],
    ];
    for (const [outcome, reason] of reasons) {
      const t = deps([outcome], [item(1), item(2)], { claim: async () => true });
      // 한 줄씩 차례로(나란히 도는 두 번째 줄이 먼저 멈춘 묶음을 보게)
      const out = await runDueBatchItems({ ...t.d, openItems: async () => [item(1)] });
      expect(out.stopped).toBe(1);
      expect(t.stopped[0].reason).toMatch(reason);
      expect(t.finished[0].patch).toMatchObject({ status: 'skipped' });
    }
  });

  it('줄의 입력 문제(400)는 그 줄만 실패, 모델 오류는 한 번 더(두 번째도 실패면 실패)', async () => {
    const bad = deps([{ kind: 'rejected', status: 400, message: '주제를 입력해 주세요.' }], [item(1)]);
    await runDueBatchItems(bad.d);
    expect(bad.finished[0].patch).toEqual({ status: 'failed', attempts: 1, error: '주제를 입력해 주세요.' });
    expect(bad.stopped).toHaveLength(0);
    const flaky = deps([{ kind: 'failed', error: 'overloaded', conversationId: 'c9' }], [item(1)]);
    await runDueBatchItems(flaky.d);
    expect(flaky.finished[0].patch).toMatchObject({ status: 'pending', attempts: 1, error: 'overloaded' });
    const twice = deps([{ kind: 'failed', error: 'overloaded', conversationId: null }], [item(1, { attempts: 1 })]);
    await runDueBatchItems(twice.d);
    expect(twice.finished[0].patch).toMatchObject({ status: 'failed', attempts: 2 });
    // 실행 자체가 던져도 실패로 센다
    const thrown = deps([], [item(1, { attempts: 1 })], { run: async () => { throw new Error('boom'); } });
    await runDueBatchItems(thrown.d);
    expect(thrown.finished[0].patch).toMatchObject({ status: 'failed', error: 'boom' });
  });

  it('차지 못 한 줄은 건너뛰고, 시작 창(90초)을 넘기면 새 줄을 시작하지 않는다, 목록 실패도 던지지 않는다', async () => {
    const none = deps([], [item(1)], { claim: async () => false });
    expect(await runDueBatchItems(none.d)).toMatchObject({ ran: 0 });
    const slow = deps([], [item(1), item(2), item(3), item(4)]);
    slow.d.run = async () => { slow.advance(BATCH_START_WINDOW_MS + 1); return { kind: 'completed', conversationId: 'c', messageId: 'm' }; };
    expect((await runDueBatchItems(slow.d)).ran).toBe(2); // 두 줄씩 나란히 — 각자 첫 줄만
    expect(await runDueBatchItems({ ...deps([]).d, openItems: async () => { throw new Error('db'); } })).toMatchObject({ ran: 0 });
  });
});

describe('결과 가리키기·연결', () => {
  it('runAppAs는 실행기의 done이 실어 준 답변 id를 돌려준다(없으면 칸 없음)', async () => {
    const io = (messageId?: string): RunAsIo => ({
      loadUser: async () => ({ id: 'u1', email: null, role: 'USER', department_id: 'd1', is_active: true, deleted_at: null }),
      prepare: async () => ({ ok: true, turn: {} as never }),
      stream: async (_turn, send) => {
        send({ event: 'meta', data: { conversation_id: 'c1', chunks: [] } });
        send({ event: 'done', data: { usage: { model: 'm', input_tokens: 1, output_tokens: 1 }, title: null, number_check: null, ...(messageId ? { message_id: messageId } : {}) } });
      },
      retitle: async () => {},
    });
    const input = { userId: 'u1', departmentId: 'd1', agentId: 'a1', appVersion: 1, inputs: {} };
    expect(await runAppAs(input, '[일괄] ', io('m1'))).toEqual({ kind: 'completed', conversationId: 'c1', messageId: 'm1' });
    expect(await runAppAs(input, '[일괄] ', io())).toEqual({ kind: 'completed', conversationId: 'c1' });
  });

  it('실행기는 예약 실행과 나란히, 화면·API는 만든 사람만', () => {
    expect(readFileSync('src/app/api/cron/app-schedules/route.ts', 'utf8')).toMatch(/Promise\.all\(\[[\s\S]*runDueBatchItems\(batchDeps\(\)\)[\s\S]*runDueSchedules/);
    const lib = readFileSync('src/lib/apps/batches.ts', 'utf8');
    expect(lib).toContain(".eq('id', id).eq('user_id', userId)");
    expect(lib).toContain("eq('conversation.user_id', userId)");
    expect(lib).toContain('if (!fileMode && definition.value.attachments?.required) return { ok: false, status: 400, message: BATCH_FILES_UNSUPPORTED };');
    expect(lib).toContain('canUseAgent(agent, actor)');
    for (const route of ['src/app/api/apps/batches/route.ts', 'src/app/api/apps/batches/[id]/route.ts', 'src/app/api/apps/batches/[id]/export/route.ts']) {
      expect(readFileSync(route, 'utf8')).toContain('session.user.id');
    }
    // 잎 파일 — 핵심어 규칙(keyword-match.ts, 그것도 아무것도 import하지 않음) 말고는 가져오지 않는다
    const spec = readFileSync('src/lib/apps/batch-spec.ts', 'utf8');
    expect(spec.match(/^import .*$/gm)).toEqual(["import { missingKeywords } from '@/lib/keyword-match';"]);
    expect(readFileSync('src/lib/keyword-match.ts', 'utf8')).not.toMatch(/^import /m);
    // 시험 판 실행 화면에는 일괄 실행을 두지 않는다(일괄 실행은 언제나 지금 판)
    expect(readFileSync('src/app/apps/run/page.tsx', 'utf8')).toContain('{!draftSavedAt && <AppBatchPanel');
  });
});
