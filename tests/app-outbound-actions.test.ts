import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import {
  OUTBOUND_ACTION_GONE, OUTBOUND_ACTION_REQUIRED, OUTBOUND_HEADERS, actionsOf, buildOutboundPayload, parseActions, parseCreateEndpoint, resolveAction,
} from '@/lib/apps/outbound/spec';
import { dispatchDueDeliveries, type DeliveryContext, type DueDelivery, type FinishPatch, type OutboundDeps } from '@/lib/apps/outbound/deliver';
import { validateAppDefinition } from '@/lib/apps/definition';

/** 보낼 곳별 받는 쪽 동작(2026-11-10, 0081) — 관리자가 키=이름을 정하고, 앱이 하나를 골라, 보내는 몸·머리글에 싣는다 */

describe('동작 읽기', () => {
  it('글(한 줄에 하나 키=이름 또는 키: 이름)·배열을 읽는다', () => {
    expect(parseActions('draft=기안 임시 저장\nboard: 게시판 등록\n')).toEqual({ ok: true, actions: [{ key: 'draft', label: '기안 임시 저장' }, { key: 'board', label: '게시판 등록' }] });
    expect(parseActions([{ key: 'a1', label: '하나' }])).toMatchObject({ ok: true, actions: [{ key: 'a1', label: '하나' }] });
    expect(parseActions(undefined)).toEqual({ ok: true, actions: [] });
    expect(parseActions('')).toEqual({ ok: true, actions: [] });
  });
  it('키 꼴·이름 없음·겹침·6개·제어 글자는 거절', () => {
    for (const bad of ['Draft=대문자', '1x=숫자로 시작', 'draft', 'draft=', 'a=하나\na=둘', 'a=1\nb=2\nc=3\nd=4\ne=5\nf=6', 'a=이름‮', 7]) {
      expect(parseActions(bad)).toMatchObject({ ok: false });
    }
  });
  it('DB 칸은 꼴이 틀린 원소를 버린다', () => {
    expect(actionsOf([{ key: 'draft', label: '기안' }, { key: 'BAD', label: 'x' }, null, 'x'])).toEqual([{ key: 'draft', label: '기안' }]);
    expect(actionsOf('x')).toEqual([]);
  });
  it('만들기 입력에 동작이 실린다', () => {
    expect(parseCreateEndpoint({ name: '전자결재', url: 'https://hook.example.com/in', actions: 'draft=기안 임시 저장' })).toMatchObject({ ok: true, value: { actions: [{ key: 'draft' }] } });
    expect(parseCreateEndpoint({ name: '전자결재', url: 'https://hook.example.com/in', actions: 'X=틀림' })).toMatchObject({ ok: false });
  });
});

describe('보낼 때 동작 고르기(resolveAction)', () => {
  const actions = [{ key: 'draft', label: '기안 임시 저장' }];
  it('보낼 곳이 동작을 정했으면 기록의 동작이 그중 하나여야 한다', () => {
    expect(resolveAction(actions, 'draft')).toEqual({ ok: true, action: actions[0] });
    expect(resolveAction(actions, null)).toEqual({ ok: false, message: OUTBOUND_ACTION_REQUIRED });
    expect(resolveAction(actions, 'board')).toEqual({ ok: false, message: OUTBOUND_ACTION_GONE });
  });
  it('정하지 않았으면 동작 없이, 기록에 동작이 남아 있으면 그만둔다', () => {
    expect(resolveAction([], null)).toEqual({ ok: true, action: null });
    expect(resolveAction([], 'draft')).toEqual({ ok: false, message: OUTBOUND_ACTION_GONE });
  });
});

describe('몸·실행기', () => {
  const base = { deliveryId: 'd1', sentAt: '2026-11-10T00:00:00Z', app: { id: 'a1', name: '앱' }, run: { messageId: 'm1', conversationId: 'c1', completedAt: '2026-11-10T00:00:00Z' }, text: '결과' };
  it('동작이 있으면 몸에 action, 없으면 칸 없음(옛 꼴)', () => {
    expect(JSON.parse(buildOutboundPayload({ ...base, action: { key: 'draft', label: '기안' } })).action).toEqual({ key: 'draft', label: '기안' });
    expect(JSON.parse(buildOutboundPayload(base))).not.toHaveProperty('action');
  });

  const row = (action: string | null): DueDelivery => ({ id: 'd1', organization_id: 'o1', endpoint_id: 'e1', agent_id: 'a1', message_id: 'm1', status: 'pending', attempts: 0, claimed_at: null, action });
  const ctx = (actions: unknown): DeliveryContext => ({
    endpoint: { url: 'https://hook.example.com/in', secret_encrypted: 'enc', organization_id: 'o1', revoked_at: null, actions },
    message: { content: '결과', conversation_id: 'c1', created_at: '2026-11-10T00:00:00Z', role: 'assistant' }, agent: { id: 'a1', name: '앱' },
  });
  async function run(r: DueDelivery, c: DeliveryContext) {
    const finished: FinishPatch[] = [];
    const posted: Array<{ headers: Record<string, string>; body: string }> = [];
    const d: OutboundDeps = {
      now: () => Date.parse('2026-11-10T01:00:00Z'), listDue: async () => [r], claim: async () => true, load: async () => c,
      finish: async (_id, p) => { finished.push(p); }, decrypt: () => 's', checkHost: async () => ({ ok: true }),
      post: async (_u, headers, body) => { posted.push({ headers, body }); return { kind: 'sent', status: 200 }; }, log: async () => {},
    };
    await dispatchDueDeliveries(d);
    return { finished, posted };
  }
  it('고른 동작은 몸과 X-Workon-Action 머리글에', async () => {
    const t = await run(row('draft'), ctx([{ key: 'draft', label: '기안 임시 저장' }]));
    expect(t.posted[0].headers[OUTBOUND_HEADERS.action]).toBe('draft');
    expect(JSON.parse(t.posted[0].body).action).toEqual({ key: 'draft', label: '기안 임시 저장' });
  });
  it('동작이 없어졌거나 고르지 않았으면 보내지 않고 그만둔다(시도 수는 그대로)', async () => {
    for (const [r, c, message] of [[row('board'), ctx([{ key: 'draft', label: '기안' }]), OUTBOUND_ACTION_GONE], [row(null), ctx([{ key: 'draft', label: '기안' }]), OUTBOUND_ACTION_REQUIRED]] as const) {
      const t = await run(r, c);
      expect(t.posted).toHaveLength(0);
      expect(t.finished[0]).toMatchObject({ status: 'gave_up', attempts: 0, last_error: message });
    }
  });
  it('동작을 정하지 않은 보낼 곳은 머리글·몸 칸 없이(옛 꼴)', async () => {
    const t = await run(row(null), ctx([]));
    expect(t.posted[0].headers).not.toHaveProperty(OUTBOUND_HEADERS.action);
    expect(JSON.parse(t.posted[0].body)).not.toHaveProperty('action');
  });
});

describe('앱 정의·연결', () => {
  const def = (extra: Record<string, unknown>) => validateAppDefinition({ schemaVersion: 1, fields: [{ key: 'topic', label: '주제', type: 'text', required: true }], output: 'bullets', ...extra });
  it('deliverAction은 보낼 곳을 고른 앱에만, 꼴이 틀리면 거절', () => {
    const EP = 'aaaaaaaa-1111-4111-8111-111111111111';
    expect(def({ deliverEndpointId: EP, deliverAction: 'draft' })).toMatchObject({ ok: true, value: { deliverAction: 'draft' } });
    const none = def({ deliverAction: 'draft' });
    expect(none.ok && none.value).not.toHaveProperty('deliverAction');
    expect(def({ deliverEndpointId: EP, deliverAction: 'Bad Key' })).toMatchObject({ ok: false });
  });
  it('실행 준비·넣기·관리자 바꾸기·직원 목록·화면이 동작을 잇는다', () => {
    expect(readFileSync('src/lib/assistant/prepare.ts', 'utf8')).toContain('appDeliverAction: definition.value.deliverAction');
    expect(readFileSync('src/lib/assistant/stream.ts', 'utf8')).toContain("...(turn.appDeliverAction ? { action: turn.appDeliverAction } : {})");
    const deliver = readFileSync('src/lib/apps/outbound/deliver.ts', 'utf8');
    expect(deliver).toContain("...(input.action ? { action: input.action } : {})");
    expect(deliver).toContain('resolveAction(actionsOf(ctx.endpoint.actions), row.action)');
    const admin = readFileSync('src/lib/apps/outbound/admin.ts', 'utf8');
    expect(admin).toContain("select('id, name, require_approval, actions')");
    expect(admin).toContain('parseActions(body!.actions)');
    expect(readFileSync('src/components/admin/OutboundEndpointsPanel.tsx', 'utf8')).toContain('받는 쪽 동작');
    expect(readFileSync('src/app/apps/builder/page.tsx', 'utf8')).toContain('aria-label="받는 쪽 동작"');
  });
});
