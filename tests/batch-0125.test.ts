import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findDiscardedWrites } from './helpers/discarded-writes';

/**
 * 2026-11-17 — 결과를 버리는 DB 쓰기를 원본 전체에서 막는다.
 * Supabase는 실패를 던지지 않고 `{ error }`로 돌려줘, `await supabaseAdmin.from(…).update(…)`를 문장으로 쓰면 실패가 사라진다.
 * 남겨도 되는 곳은 이유와 함께 아래에 적어야 통과한다(목록에 넣는 순간 그 판단이 코드로 남는다 — route-auth와 같은 방식).
 */

const ALLOWED: Record<string, string> = {
  'src/app/api/conversations/[id]/route.ts messages delete': '바로 뒤 conversations 삭제가 오류를 보고 500으로 답한다(메시지는 연쇄 삭제로도 지워짐)',
  'src/app/api/super/auth/login/route.ts users update': '로그인 시각 표시용 updated_at — 실패해도 로그인·보안에 영향 없음',
  'src/lib/apps/batches.ts app_batches delete': '줄을 넣지 못한 새 묶음 되돌리기 — 남아도 줄이 없어 실행기 settle이 곧 마침으로 바꾼다',
  'src/lib/apps/outbound/admin.ts app_outbound_deliveries update': '회수한 보낼 곳의 기록을 화면에 바로 그만둠으로 — 실행기가 보내기 직전에 보낼 곳을 다시 읽어 회수면 그만둔다',
  'src/lib/apps/run-as.ts conversations update': '대화 제목 꾸미기(예약·일괄 표시) — 실패해도 실행·기록은 그대로',
  'src/lib/assistant/stream.ts conversations update': '자동 대화 제목 — 실패해도 답·기록은 그대로',
  'src/lib/password-reset-mail.ts password_reset_requests delete': '하루 지난 줄 가끔 치우기 — 못 치워도 다음에 다시',
  'src/lib/sign-in-throttle.ts sign_in_failures delete': '하루 지난 실패 기록 가끔 치우기 — 세는 창은 30분이라 남아도 판정과 무관',
};

describe('결과를 버리는 DB 쓰기', () => {
  it('목록 밖에 없다(새로 쓰면 결과를 보거나 이유를 적어 목록에)', () => {
    const found = findDiscardedWrites().map((w) => `${w.file} ${w.table} ${w.op}`);
    const unexpected = found.filter((k) => !(k in ALLOWED));
    expect(unexpected).toEqual([]);
  });
  it('목록의 항목은 지금도 그 자리에 있다(고쳤으면 목록에서 빼기)', () => {
    const found = new Set(findDiscardedWrites().map((w) => `${w.file} ${w.table} ${w.op}`));
    expect(Object.keys(ALLOWED).filter((k) => !found.has(k))).toEqual([]);
    for (const reason of Object.values(ALLOWED)) expect(reason.length).toBeGreaterThan(10);
  });
  it('찾개가 실제로 잡는다 — 결과를 받으면 안 잡고 문장으로 버리면 잡는다', () => {
    const src = readFileSync('tests/helpers/discarded-writes.ts', 'utf8');
    expect(src).toContain('^\\s*await supabaseAdmin\\b');
    // 이번에 고친 곳은 이제 결과를 받는다
    for (const [file, needle] of [
      ['src/app/api/notices/[id]/read/route.ts', "const { error } = await supabaseAdmin.from('notice_reads')"],
      ['src/app/api/super/api-keys/system/route.ts', "const off = await supabaseAdmin.from('api_keys')"],
      ['src/app/api/agents/[id]/app-draft/route.ts', "const cleared = await supabaseAdmin.from('agents')"],
    ] as const) expect(readFileSync(file, 'utf8')).toContain(needle);
  });
});

const db = vi.hoisted(() => ({ errors: [] as Array<{ code: string } | null>, calls: 0, logs: [] as Array<{ level: string; message: string; details?: Record<string, unknown> }> }));
vi.mock('@/lib/supabaseAdmin', () => {
  const self: Record<string, unknown> = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => void) => { const e = db.errors[db.calls] ?? null; db.calls++; resolve({ data: null, error: e }); };
      return () => self;
    },
  });
  return { supabaseAdmin: { from: () => self, storage: { from: () => self } } };
});
vi.mock('@/lib/logger', () => ({ logSystem: vi.fn(async (p) => { db.logs.push(p); }) }));

import { PENDING_NOT_SKIPPED, skipPendingItems } from '@/lib/apps/batches';

beforeEach(() => { db.errors = []; db.calls = 0; db.logs = []; });

describe('끝낸 묶음의 기다리던 줄 건너뛰기', () => {
  it('바로 되면 한 번, 기록 없음', async () => {
    expect(await skipPendingItems('b1', '2026-11-17T00:00:00Z', '직원이 그만뒀습니다.')).toBe(true);
    expect(db.calls).toBe(1);
    expect(db.logs).toEqual([]);
  });
  it('한 번 실패하면 다시 해 보고 되면 기록 없음', async () => {
    db.errors = [{ code: '57014' }, null];
    expect(await skipPendingItems('b1', '2026-11-17T00:00:00Z', 'x')).toBe(true);
    expect(db.calls).toBe(2);
    expect(db.logs).toEqual([]);
  });
  it('두 번 다 실패하면 warning(묶음 id·코드만), 던지지 않음', async () => {
    db.errors = [{ code: '57014' }, { code: '57014' }];
    expect(await skipPendingItems('b1', '2026-11-17T00:00:00Z', 'x')).toBe(false);
    expect(db.logs).toEqual([{ level: 'warning', category: 'database', message: PENDING_NOT_SKIPPED, details: { batch_id: 'b1', code: '57014' } }]);
  });
  it('그만두기·실행기 멈춤·관리자 멈춤 세 곳이 이 함수를 쓴다', () => {
    const batches = readFileSync('src/lib/apps/batches.ts', 'utf8');
    expect(batches.match(/await skipPendingItems\(/g)?.length).toBe(2);
    expect(readFileSync('src/lib/apps/automation-admin.ts', 'utf8')).toContain('await skipPendingItems(id, now, stopReason)');
  });
});
