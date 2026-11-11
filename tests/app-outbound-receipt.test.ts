import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
import { OUTBOUND_RECEIPT_MAX_BYTES, parseOutboundReceipt } from '@/lib/apps/outbound/spec';
import { dispatchDueDeliveries, postOnce, readBodyPrefix, type DeliveryContext, type DueDelivery, type FinishPatch, type OutboundDeps } from '@/lib/apps/outbound/deliver';

/** 받는 쪽 접수 정보(2026-11-10, 0080) — 2xx 응답 몸 앞 4KB에서 {"receipt":{"reference","url"}}만 다듬어 남기고, 실행한 직원의 '보낸 결과'에 보인다 */

const streamOf = (text: string, chunk = 1024) => {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  const cancel = vi.fn(async () => undefined);
  return {
    cancel,
    getReader: () => ({
      read: async () => (at >= bytes.length ? { done: true } : { done: false, value: bytes.slice(at, (at += chunk)) }),
      cancel,
    }),
  };
};

describe('접수 정보 읽기(parseOutboundReceipt)', () => {
  it('번호·https 주소', () => {
    expect(parseOutboundReceipt(JSON.stringify({ receipt: { reference: '결재-2026-0042', url: 'https://gw.example.go.kr/doc/42' } })))
      .toEqual({ reference: '결재-2026-0042', url: 'https://gw.example.go.kr/doc/42' });
    expect(parseOutboundReceipt(JSON.stringify({ receipt: { reference: 42 } }))).toEqual({ reference: '42', url: null });
  });
  it('번호는 제어·서식 글자를 빼고 100자, 주소는 https·아이디 없음만', () => {
    const r = parseOutboundReceipt(JSON.stringify({ receipt: { reference: `  결재‮\n${'가'.repeat(200)}`, url: 'http://gw.example.go.kr/doc' } }));
    expect(r?.reference?.length).toBe(100);
    expect(r?.reference).not.toMatch(/[‮\n]/);
    expect(r?.url).toBeNull();
    expect(parseOutboundReceipt(JSON.stringify({ receipt: { url: 'https://u:p@gw.example.go.kr/' } }))).toBeNull();
    expect(parseOutboundReceipt(JSON.stringify({ receipt: { url: 'javascript:alert(1)' } }))).toBeNull();
    expect(parseOutboundReceipt(JSON.stringify({ receipt: { url: `https://x.kr/${'a'.repeat(600)}` } }))).toBeNull();
  });
  it('꼴이 다르면 null — JSON 아님·receipt 없음·빈 값·배열', () => {
    for (const text of ['', 'OK', '{"reference":"1"}', '{"receipt":null}', '{"receipt":[]}', '{"receipt":{"reference":"  "}}', '[]']) expect(parseOutboundReceipt(text)).toBeNull();
  });
});

describe('응답 몸 앞부분만(readBodyPrefix)', () => {
  it('상한에서 멈추고 나머지는 버린다', async () => {
    const body = streamOf('a'.repeat(OUTBOUND_RECEIPT_MAX_BYTES * 3));
    expect((await readBodyPrefix(body)).length).toBe(OUTBOUND_RECEIPT_MAX_BYTES);
    expect(body.cancel).toHaveBeenCalled();
  });
  it('읽을 수 없는 몸은 빈 글(버림)·읽다 실패해도 빈 글', async () => {
    const cancel = vi.fn(async () => undefined);
    expect(await readBodyPrefix({ cancel })).toBe('');
    expect(cancel).toHaveBeenCalled();
    expect(await readBodyPrefix(null)).toBe('');
    expect(await readBodyPrefix({ getReader: () => ({ read: async () => { throw new Error('reset'); }, cancel: async () => undefined }) })).toBe('');
  });
});

describe('한 번 보내기(postOnce)', () => {
  it('2xx면 접수 정보를 실어 돌려주고, 4xx는 몸을 읽지 않는다', async () => {
    const ok = await postOnce('https://hook.example.com', {}, '{}', async () => ({ status: 201, body: streamOf('{"receipt":{"reference":"A-1"}}') }));
    expect(ok).toEqual({ kind: 'sent', status: 201, receipt: { reference: 'A-1', url: null } });
    const plain = await postOnce('https://hook.example.com', {}, '{}', async () => ({ status: 200, body: streamOf('OK') }));
    expect(plain).toEqual({ kind: 'sent', status: 200 });
    const read = vi.fn();
    const cancel = vi.fn(async () => undefined);
    const bad = await postOnce('https://hook.example.com', {}, '{}', async () => ({ status: 400, body: { cancel, getReader: read as never } }));
    expect(bad.kind).toBe('give_up');
    expect(read).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalled();
  });
});

describe('실행기', () => {
  const row: DueDelivery = { id: 'd1', organization_id: 'o1', endpoint_id: 'e1', agent_id: 'a1', message_id: 'm1', status: 'pending', attempts: 0, claimed_at: null };
  const ctx: DeliveryContext = {
    endpoint: { url: 'https://hook.example.com/in', secret_encrypted: 'enc', organization_id: 'o1', revoked_at: null },
    message: { content: '결과', conversation_id: 'c1', created_at: '2026-11-10T00:00:00Z', role: 'assistant' }, agent: { id: 'a1', name: '앱' },
  };
  const run = async (outcome: Awaited<ReturnType<OutboundDeps['post']>>) => {
    const finished: FinishPatch[] = [];
    const d: OutboundDeps = {
      now: () => Date.parse('2026-11-10T01:00:00Z'), listDue: async () => [row], claim: async () => true, load: async () => ctx,
      finish: async (_id, patch) => { finished.push(patch); }, decrypt: () => 's', checkHost: async () => ({ ok: true }), post: async () => outcome, log: async () => {},
    };
    await dispatchDueDeliveries(d);
    return finished[0];
  };
  it('보냈고 접수 정보가 있으면 보낸 기록에 남긴다, 없으면 칸을 두지 않는다', async () => {
    expect(await run({ kind: 'sent', status: 200, receipt: { reference: 'A-1', url: 'https://gw/x' } })).toMatchObject({ status: 'sent', receipt_ref: 'A-1', receipt_url: 'https://gw/x' });
    const plain = await run({ kind: 'sent', status: 200 });
    expect(plain).not.toHaveProperty('receipt_ref');
    expect(plain).not.toHaveProperty('receipt_url');
  });
});

describe('연결', () => {
  it('직원 목록은 자기 기록·자기 기관·확인 기다림 빼고, 대화 링크는 자기 대화만, 화면·관리자 표에 접수 번호', () => {
    const lib = readFileSync('src/lib/apps/outbound/deliver.ts', 'utf8');
    const list = lib.slice(lib.indexOf('export async function listMyDeliveries'));
    expect(list).toContain(".eq('user_id', actor.userId).eq('organization_id', actor.organizationId).neq('status', 'awaiting_approval')");
    expect(list).toContain(".eq('conversation.user_id', actor.userId)");
    expect(list).not.toContain("'url'");
    expect(readFileSync('src/app/api/apps/outbound-deliveries/route.ts', 'utf8')).toContain('session.user.id');
    expect(readFileSync('src/app/apps/run/page.tsx', 'utf8')).toContain('<OutboundDeliveriesPanel agentId={agent.id}');
    const panel = readFileSync('src/components/apps/OutboundDeliveriesPanel.tsx', 'utf8');
    expect(panel).toContain('rel="noopener noreferrer"');
    expect(readFileSync('src/lib/apps/outbound/admin.ts', 'utf8')).toContain('receipt_ref');
    expect(readFileSync('supabase/migrations/0080_app_outbound_receipt.sql', 'utf8')).toContain("status = 'sent' OR (receipt_ref IS NULL AND receipt_url IS NULL)");
  });
});
