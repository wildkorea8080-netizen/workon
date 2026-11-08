import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import { canonicalInputs, webhookCurlExample, WEBHOOK_MAX_BODY_BYTES } from '@/lib/apps/webhook-spec';
import {
  executeWebhook, generateWebhookToken, handleWebhookCall, parseWebhookFiles, WEBHOOK_FILES_FORMAT,
  type ClaimedWebhook, type ExecuteWebhookIo, type WebhookDeps, type WebhookFileIo,
} from '@/lib/apps/webhooks';
import type { RunAsInput, RunAsOutcome } from '@/lib/apps/run-as';
import type { AttachmentRow } from '@/lib/attachments/types';

/** 외부 연동이 보내는 파일(2026-11-08) — 꼴·크기 검사는 차지 전, 새 첨부로 올려 붙임, 못 읽으면 422·만든 첨부 정리, 요청 해시에 파일 */
const b64 = (s: string) => Buffer.from(s).toString('base64');
const token = generateWebhookToken();
const claimed: ClaimedWebhook = { id: 'w1', agent_id: 'a1', user_id: 'u1', department_id: 'd1', organization_id: 'o1', app_version: 3 };

describe('parseWebhookFiles', () => {
  it('없으면 빈 목록, 이름·base64를 풀어 둔다', () => {
    expect(parseWebhookFiles(undefined)).toEqual({ ok: true, files: [] });
    const parsed = parseWebhookFiles([{ name: '명단.csv', content_base64: b64('이름,부서\n홍길동,총무과') }]);
    expect(parsed.ok && parsed.files[0].bytes.toString()).toBe('이름,부서\n홍길동,총무과');
  });
  it('꼴·base64·형식·개수·빈 파일·합계 3MB를 거절한다', () => {
    expect(parseWebhookFiles('x')).toMatchObject({ ok: false, status: 400, message: WEBHOOK_FILES_FORMAT });
    expect(parseWebhookFiles([{ name: 'a.csv' }])).toMatchObject({ ok: false, status: 400 });
    expect(parseWebhookFiles([{ name: 'a.csv', content_base64: '###' }])).toMatchObject({ ok: false, status: 400 });
    expect(parseWebhookFiles([{ name: 'a.csv', content_base64: 'abc' }])).toMatchObject({ ok: false, status: 400 }); // 길이가 4의 배수가 아님
    expect(parseWebhookFiles([{ name: 'a.exe', content_base64: b64('x') }])).toMatchObject({ ok: false, message: expect.stringContaining('보낼 수 없는 파일 형식') });
    expect(parseWebhookFiles([{ name: 'a.csv', content_base64: '' }])).toMatchObject({ ok: false, message: expect.stringContaining('빈 파일') });
    const one = { name: 'a.txt', content_base64: b64('x') };
    expect(parseWebhookFiles([one, one, one, one])).toMatchObject({ ok: false, message: '파일은 한 번에 3개까지 보낼 수 있습니다.' });
    const big = { name: 'a.txt', content_base64: Buffer.alloc(1.6 * 1024 * 1024).toString('base64') };
    expect(parseWebhookFiles([big, big])).toMatchObject({ ok: false, status: 413 });
  });
});

function deps() {
  return {
    orgDisabled: vi.fn<WebhookDeps['orgDisabled']>(async () => false),
    claim: vi.fn<WebhookDeps['claim']>(async () => ({ ok: true as const, webhook: claimed, call_id: 'call1' })),
    execute: vi.fn<WebhookDeps['execute']>(async () => ({ kind: 'completed', conversationId: 'c1' })),
    finish: vi.fn<WebhookDeps['finish']>(async () => {}), recordCall: vi.fn<WebhookDeps['recordCall']>(async () => {}), log: vi.fn<WebhookDeps['log']>(async () => {}), now: vi.fn<WebhookDeps['now']>(() => Date.parse('2026-11-08T00:00:00Z')),
  } satisfies WebhookDeps;
}
const call = (d: WebhookDeps, body: unknown, key: string | null = null) => handleWebhookCall(d, { authorization: `Bearer ${token.token}`, bodyText: JSON.stringify(body), idempotencyKey: key });

describe('handleWebhookCall — 파일', () => {
  it('파일을 풀어 실행기에 넘긴다. 64KB 넘는 본문도 파일이면 받고, 입력만 64KB를 본다', async () => {
    const d = deps();
    const content = Buffer.alloc(100 * 1024, 7);
    expect((await call(d, { inputs: { title: '보고' }, files: [{ name: '자료.txt', content_base64: content.toString('base64') }] })).status).toBe(200);
    expect(d.execute).toHaveBeenCalledWith(claimed, { title: '보고' }, [{ name: '자료.txt', bytes: content }]);
    const big = deps();
    expect((await call(big, { inputs: { a: 'x'.repeat(WEBHOOK_MAX_BODY_BYTES) }, files: [{ name: 'a.txt', content_base64: b64('x') }] })).status).toBe(413);
    expect(big.claim).not.toHaveBeenCalled();
  });
  it('파일 꼴이 틀리면 차지(호출 횟수)를 쓰지 않고 400', async () => {
    const d = deps();
    expect((await call(d, { inputs: {}, files: [{ name: 'a.exe', content_base64: b64('x') }] })).status).toBe(400);
    expect(d.claim).not.toHaveBeenCalled();
  });
  it('Idempotency-Key 해시 — 파일이 없으면 예전과 같고, 파일 내용이 다르면 달라진다', async () => {
    const d = deps();
    await call(d, { inputs: { title: '보고' } }, 'k1');
    expect(d.claim.mock.calls[0][2]?.requestHash).toBe(createHash('sha256').update(canonicalInputs({ title: '보고' }), 'utf8').digest('hex'));
    await call(d, { inputs: { title: '보고' }, files: [{ name: 'a.txt', content_base64: b64('하나') }] }, 'k1');
    await call(d, { inputs: { title: '보고' }, files: [{ name: 'a.txt', content_base64: b64('둘') }] }, 'k1');
    const hashes = d.claim.mock.calls.map(c => c[2]?.requestHash);
    expect(new Set(hashes).size).toBe(3);
  });
});

describe('executeWebhook — 보낸 파일을 새 첨부로', () => {
  const att = (id: string, patch: Partial<AttachmentRow> = {}): AttachmentRow => ({ id, user_id: 'u1', conversation_id: null, file_name: 'x', size_bytes: 1, status: 'ready', summary: null, error: null, created_at: '', ...patch });
  const io = (attach: Awaited<ReturnType<WebhookFileIo['attach']>>[], outcome: RunAsOutcome = { kind: 'completed', conversationId: 'c1' }) => {
    const discarded: string[] = []; const actors: unknown[] = [];
    const files: WebhookFileIo = { attach: async (actor) => { actors.push(actor); return attach.shift()!; }, discard: async (_u, id) => { discarded.push(id); } };
    const value = {
      documentIdsOf: vi.fn(async () => []), documentsOf: vi.fn(async () => []), saveDocumentIds: vi.fn(async () => {}),
      run: vi.fn(async (_input: RunAsInput): Promise<RunAsOutcome> => outcome), files,
    } satisfies ExecuteWebhookIo;
    return { value, discarded, actors };
  };
  const f = (name: string) => ({ name, bytes: Buffer.from('x') });

  it('그 직원의 새 첨부로 올려 attachmentIds로 실행한다', async () => {
    const t = io([{ ok: true, attachment: att('n1') }, { ok: true, attachment: att('n2') }]);
    expect(await executeWebhook(claimed, { title: '보고' }, t.value, [f('a.csv'), f('b.csv')])).toEqual({ kind: 'completed', conversationId: 'c1' });
    expect(t.value.run).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', attachmentIds: ['n1', 'n2'] }));
    expect(t.actors[0]).toEqual({ userId: 'u1', departmentId: 'd1', organizationId: 'o1' });
    expect(t.discarded).toEqual([]);
  });
  it('읽지 못하면 422(이유) — 실행하지 않고 만든 첨부를 지운다 · 발급 거절은 그 상태 그대로', async () => {
    let t = io([{ ok: true, attachment: att('n1') }, { ok: true, attachment: att('n2', { status: 'failed', error: '암호가 걸린 파일' }) }]);
    expect(await executeWebhook(claimed, {}, t.value, [f('a.csv'), f('b.pdf')])).toEqual({ kind: 'rejected', status: 422, message: "보낸 파일 'b.pdf'을 읽지 못했습니다(암호가 걸린 파일)." });
    expect(t.value.run).not.toHaveBeenCalled();
    expect(t.discarded).toEqual(['n1', 'n2']);
    t = io([{ ok: false, status: 429, message: '보내지 않은 첨부가 너무 많습니다.' }]);
    expect(await executeWebhook(claimed, {}, t.value, [f('a.csv')])).toEqual({ kind: 'rejected', status: 429, message: '보내지 않은 첨부가 너무 많습니다.' });
  });
  it('실행이 시작 전에 거절되면 첨부를 지우고, 시작했으면(대화에 묶임) 두고, 파일이 없으면 attachmentIds를 싣지 않는다', async () => {
    let t = io([{ ok: true, attachment: att('n1') }], { kind: 'rejected', status: 400, message: '제목은 필수입니다' });
    await executeWebhook(claimed, {}, t.value, [f('a.csv')]);
    expect(t.discarded).toEqual(['n1']);
    t = io([{ ok: true, attachment: att('n1') }], { kind: 'failed', error: '모델 오류', conversationId: 'c9' });
    await executeWebhook(claimed, {}, t.value, [f('a.csv')]);
    expect(t.discarded).toEqual([]);
    t = io([]);
    await executeWebhook(claimed, {}, t.value);
    expect(t.value.run.mock.calls[0][0]).not.toHaveProperty('attachmentIds');
  });
});

describe('화면·연결 (원본)', () => {
  it('파일이 필요한 앱도 연동을 만들 수 있고, 호출 예시에 files가 든다', () => {
    const form = readFileSync('src/components/apps/AppWebhookForm.tsx', 'utf8');
    expect(form).not.toContain('외부 연동을 만들 수 없습니다');
    expect(form).toContain('webhookCurlExample(typeof window === \'undefined\' ? \'\' : window.location.origin, created.token, sampleInputs, acceptsFiles)');
    expect(webhookCurlExample('https://x.kr', 't', { a: '1' }, true)).toContain('"files":[{"name":"자료.xlsx"');
    expect(webhookCurlExample('https://x.kr', 't', { a: '1' })).not.toContain('files');
    expect(readFileSync('src/app/api/apps/webhook/route.ts', 'utf8')).toContain('declared > WEBHOOK_MAX_BODY_WITH_FILES_BYTES');
  });
});
