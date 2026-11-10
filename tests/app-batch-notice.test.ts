import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
import { notifyBatchFinished, runDueBatchItems, type BatchDeps, type BatchItemRun, type BatchNoticeFacts, type BatchNoticeIo } from '@/lib/apps/batches';
import { batchFinishedMail } from '@/lib/mailer';
import type { RunAsOutcome } from '@/lib/apps/run-as';

/** 입력형 앱 일괄 실행의 마침 알림(2026-11-10) — 마치거나 멈춘 묶음마다 만든 직원에게 한 번, 입력·결과 글 없음 */

const batch = { id: 'b1', organization_id: 'o1', department_id: 'd1', user_id: 'u1', agent_id: 'a1', app_version: 2, status: 'running' as const };
const item = (position: number): BatchItemRun => ({ id: `i${position}`, batch_id: 'b1', position, inputs: { topic: `비밀 입력 ${position}` }, status: 'pending', attempts: 0, claimed_at: null, batch });

function deps(over: Partial<BatchDeps> = {}, outcomes: RunAsOutcome[] = []) {
  let i = 0;
  const logs: Array<{ message: string; details: Record<string, unknown> }> = [];
  const notifyFinished = vi.fn(async () => true);
  const d: BatchDeps = {
    now: () => 0, openItems: async () => [item(1), item(2)], claim: async () => true,
    run: async () => outcomes[i++] ?? ({ kind: 'completed', conversationId: 'c', messageId: 'm' } as RunAsOutcome),
    finishItem: async () => {}, stop: async () => true, settle: async () => false,
    log: async (message, details) => { logs.push({ message, details }); }, notifyFinished, ...over,
  };
  return { d, logs, notifyFinished };
}

describe('실행기', () => {
  it('묶음을 마친 호출(settle이 true)에서만 한 번 알린다', async () => {
    let n = 0;
    const t = deps({ settle: async () => (++n === 2) });
    expect(await runDueBatchItems(t.d)).toMatchObject({ done: 2, notified: 1 });
    expect(t.notifyFinished).toHaveBeenCalledTimes(1);
    expect(t.notifyFinished).toHaveBeenCalledWith('b1');
  });

  it('마치지 못했거나(그 사이 다른 호출이 마침·그만둠) 마치기가 실패하면 알리지 않는다', async () => {
    for (const settle of [async () => false, async () => undefined, async () => { throw new Error('db'); }] as Array<BatchDeps['settle']>) {
      const t = deps({ settle });
      await runDueBatchItems(t.d);
      expect(t.notifyFinished).not.toHaveBeenCalled();
    }
  });

  it('멈춘 묶음 — 이 호출이 멈췄을 때만 알린다', async () => {
    const stopOutcome: RunAsOutcome = { kind: 'rejected', status: 409, message: '바뀜' };
    const t = deps({}, [stopOutcome]);
    expect(await runDueBatchItems(t.d)).toMatchObject({ stopped: 1, notified: 1 });
    const u = deps({ stop: async () => false }, [stopOutcome]);
    await runDueBatchItems(u.d);
    expect(u.notifyFinished).not.toHaveBeenCalled();
  });

  it('알림이 던져도 실행기는 이어 가고 기록만 남긴다(보내지 않은 것은 세지 않음), 알림이 없어도 돈다', async () => {
    const t = deps({ settle: async () => true, notifyFinished: vi.fn(async () => { throw new Error('resend 500'); }) });
    expect(await runDueBatchItems(t.d)).toMatchObject({ done: 2, notified: 0 });
    expect(t.logs.some((l) => l.message.includes('마침 메일') && l.details.batch_id === 'b1')).toBe(true);
    const u = deps({ settle: async () => true, notifyFinished: vi.fn(async () => false) });
    expect(await runDueBatchItems(u.d)).toMatchObject({ notified: 0 });
    const v = deps({ settle: async () => true, notifyFinished: undefined });
    expect(await runDueBatchItems(v.d)).toMatchObject({ done: 2, notified: 0 });
  });
});

describe('메일 보내기', () => {
  const facts = (over: Partial<BatchNoticeFacts> = {}): BatchNoticeFacts => ({
    agentId: 'a1', appName: '민원 답변 앱', name: '11월 민원', status: 'done', stopReason: null, total: 3, finishedAt: '2026-11-10T03:00:00Z',
    done: 2, failed: 1, skipped: 0, awaitingApproval: 0, email: ' kim@example.go.kr ', ...over,
  });
  function io(f: BatchNoticeFacts | null, over: Partial<BatchNoticeIo> = {}) {
    const sent: Array<{ to: string; mail: { subject: string; html: string } }> = [];
    const load = vi.fn(async () => f);
    const value: BatchNoticeIo = { mailConfigured: () => true, load, send: async (to, mail) => { sent.push({ to, mail }); return { sent: true }; }, ...over };
    return { value, sent, load };
  }

  it('마친 묶음 — 만든 직원 주소로, 줄 수·실행 화면·결과 엑셀 링크', async () => {
    const t = io(facts());
    expect(await notifyBatchFinished('b1', t.value)).toBe(true);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].to).toBe('kim@example.go.kr');
    const { subject, html } = t.sent[0].mail;
    expect(subject).toContain('일괄 실행을 마쳤습니다 — 민원 답변 앱');
    expect(html).toContain('전체 3줄 · 마침 2 · 실패 1');
    expect(html).toContain('/apps/run?agent=a1');
    expect(html).toContain('/api/apps/batches/b1/export');
    expect(html).toContain('2026-11-10 12:00 (한국 시간)');
    expect(html).not.toContain('보내기 전 확인');
  });

  it('멈춘 묶음 — 멈춘 이유·건너뜀, 마친 줄이 없으면 엑셀 링크 없음, 보내기 전 확인을 기다리는 결과 수', async () => {
    const t = io(facts({ status: 'stopped', stopReason: '앱 설정이 바뀌어 멈췄습니다.', done: 0, failed: 0, skipped: 3 }));
    await notifyBatchFinished('b1', t.value);
    expect(t.sent[0].mail.subject).toContain('일괄 실행이 멈췄습니다');
    expect(t.sent[0].mail.html).toContain('앱 설정이 바뀌어 멈췄습니다.');
    expect(t.sent[0].mail.html).toContain('건너뜀 3');
    expect(t.sent[0].mail.html).not.toContain('/export');
    const u = io(facts({ awaitingApproval: 2 }));
    await notifyBatchFinished('b1', u.value);
    expect(u.sent[0].mail.html).toContain('2건이 확인을 기다립니다');
    expect(u.sent[0].mail.html).toContain('7일 안에');
  });

  it('메일이 설정되지 않았거나·묶음이 없거나·아직 실행 중·그만둔 묶음·주소 없음이면 보내지 않는다', async () => {
    const off = io(facts(), { mailConfigured: () => false });
    expect(await notifyBatchFinished('b1', off.value)).toBe(false);
    expect(off.load).not.toHaveBeenCalled();
    for (const f of [null, facts({ status: 'running' }), facts({ status: 'cancelled' }), facts({ email: null }), facts({ email: '  ' })]) {
      const t = io(f);
      expect(await notifyBatchFinished('b1', t.value)).toBe(false);
      expect(t.sent).toHaveLength(0);
    }
  });

  it('보내지 못하면 던진다(실행기가 기록), 읽기 실패도', async () => {
    await expect(notifyBatchFinished('b1', io(facts(), { send: async () => ({ sent: false, reason: 'send_failed', error: 'HTTP 500' }) }).value)).rejects.toThrow('HTTP 500');
    await expect(notifyBatchFinished('b1', io(facts(), { load: async () => { throw new Error('db'); } }).value)).rejects.toThrow('db');
  });

  it('글 — 묶음·앱 이름은 HTML로 해석되지 않고, 입력값·결과 글 칸이 없다', () => {
    const mail = batchFinishedMail({
      appName: '<b>앱</b>', batchName: '<script>alert(1)</script>', stopped: false, stopReason: null,
      total: 1, done: 1, failed: 0, skipped: 0, awaitingApproval: 0, finishedAt: new Date('2026-11-10T03:00:00Z'), runUrl: 'https://x.example/apps/run?agent=a"1',
    });
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.html).not.toContain('agent=a"1');
    expect(mail.html).toContain('입력값과 결과 글은 메일에 싣지 않습니다');
  });
});

describe('연결', () => {
  it('묶음 마치기·멈추기는 조건부 갱신의 결과로 알리고, 그만두기는 알리지 않는다, 확인 수는 그 직원의 기록만', () => {
    const lib = readFileSync('src/lib/apps/batches.ts', 'utf8');
    expect(lib).toContain(".update({ status: 'done', finished_at: nowIso }).eq('id', batchId).eq('status', 'running').select('id')");
    expect(lib).toContain(".update({ status: 'stopped', stop_reason: reason, finished_at: nowIso }).eq('id', batchId).eq('status', 'running').select('id')");
    expect(lib).toContain('notifyFinished: (batchId) => notifyBatchFinished(batchId)');
    expect(lib).toContain(".eq('user_id', b.user_id).eq('status', 'awaiting_approval').in('message_id', messageIds)");
    const cancel = lib.slice(lib.indexOf('export async function cancelBatch'), lib.indexOf('// ── 실행기'));
    expect(cancel).not.toContain('notify');
    expect(readFileSync('src/components/apps/AppBatchPanel.tsx', 'utf8')).toContain('메일로 한 번 알립니다');
  });
});
