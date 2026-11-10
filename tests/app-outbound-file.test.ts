import { readFileSync } from 'fs';
import { createHash, createHmac } from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import { OUTBOUND_FILE_MAX_BYTES, OUTBOUND_HEADERS, buildOutboundPayload } from '@/lib/apps/outbound/spec';
import { dispatchDueDeliveries, type DeliveryContext, type DueDelivery, type FinishPatch, type OutboundDeps } from '@/lib/apps/outbound/deliver';
import { validateAppDefinition } from '@/lib/apps/definition';
import { buildResultHwpxBytes } from '@/lib/apps/schedule-result-file';
import { extractTextFromHwp } from '@/lib/hwp';

/** 앱 결과 보내기에 결과 한글 파일 함께 싣기(2026-11-10) — 앱이 고를 때만, 보내기 직전에 만들고, 5MB 넘으면 글만, 못 만들면 다시 */

const EP = 'aaaaaaaa-1111-4111-8111-111111111111';
const def = (extra: Record<string, unknown>) => validateAppDefinition({ schemaVersion: 1, fields: [{ key: 'topic', label: '주제', type: 'text', required: true }], output: 'bullets', ...extra });

describe('앱 정의', () => {
  it('보낼 곳을 고른 앱에만 deliverFile이 남고, 참거짓이 아니면 거절', () => {
    const on = def({ deliverEndpointId: EP, deliverFile: true });
    expect(on.ok && on.value).toMatchObject({ deliverEndpointId: EP, deliverFile: true });
    const off = def({ deliverEndpointId: EP, deliverFile: false });
    expect(off.ok && off.value).not.toHaveProperty('deliverFile');
    const noEndpoint = def({ deliverFile: true });
    expect(noEndpoint.ok && noEndpoint.value).not.toHaveProperty('deliverFile');
    expect(def({ deliverEndpointId: EP, deliverFile: 'yes' })).toMatchObject({ ok: false });
  });
});

describe('보내는 몸', () => {
  const base = { deliveryId: 'd1', sentAt: '2026-11-10T00:00:00Z', app: { id: 'a1', name: '앱' }, run: { messageId: 'm1', conversationId: 'c1', completedAt: '2026-11-10T00:00:00Z' }, text: '결과' };
  it('파일을 고르지 않으면 file 칸이 없다(옛 꼴 그대로)', () => {
    expect(JSON.parse(buildOutboundPayload(base)).result).toEqual({ text: '결과', truncated: false });
  });
  it('실은 파일 — 이름·형식·크기·sha256·base64', () => {
    const body = JSON.parse(buildOutboundPayload({ ...base, file: { name: '앱 작성 결과.hwpx', size: 3, sha256: 'ab', base64: 'AAAA' } }));
    expect(body.result.file).toEqual({ name: '앱 작성 결과.hwpx', content_type: 'application/hwp+zip', size: 3, sha256: 'ab', encoding: 'base64', data: 'AAAA' });
    expect(body.result).not.toHaveProperty('file_omitted');
  });
  it('상한을 넘어 뺀 파일 — file은 null, 이유 칸', () => {
    const body = JSON.parse(buildOutboundPayload({ ...base, file: { omitted: 'too_large', size: 9_000_000 } }));
    expect(body.result.file).toBeNull();
    expect(body.result.file_omitted).toBe('too_large');
  });
});

describe('보내기 실행기', () => {
  const row: DueDelivery = { id: 'd1', organization_id: 'o1', endpoint_id: 'e1', agent_id: 'a1', message_id: 'm1', status: 'pending', attempts: 0, claimed_at: null };
  const ctx = (deliverFile: unknown): DeliveryContext => ({
    endpoint: { url: 'https://hook.example.com/in', secret_encrypted: 'enc', organization_id: 'o1', revoked_at: null },
    message: { content: '최종 결과', conversation_id: 'c1', created_at: '2026-11-10T05:00:00Z', role: 'assistant', source_references: {}, agent_version: 3 },
    agent: { id: 'a1', name: '주간 보고 앱', app_definition: { deliverFile, exportTemplateId: 'tpl' } },
  });
  function deps(context: DeliveryContext, over: Partial<OutboundDeps> = {}) {
    const finished: Array<{ id: string; patch: FinishPatch }> = [];
    const posted: Array<{ headers: Record<string, string>; body: string }> = [];
    const bytes = Buffer.from('PK-hwpx-bytes');
    const buildFile = vi.fn(async (_ctx: Parameters<NonNullable<OutboundDeps['buildFile']>>[0]) => ({ name: '주간 보고 앱 작성 결과.hwpx', bytes }));
    const d: OutboundDeps = {
      now: () => Date.parse('2026-11-10T06:00:00Z'), listDue: async () => [row], claim: async () => true, load: async () => context,
      finish: async (id, patch) => { finished.push({ id, patch }); }, decrypt: () => 's3cret', checkHost: async () => ({ ok: true }),
      post: async (_url, headers, body) => { posted.push({ headers, body }); return { kind: 'sent', status: 200 }; }, log: async () => {}, buildFile, ...over,
    };
    return { d, finished, posted, buildFile, bytes };
  }

  it('앱이 고르면 만든 파일을 base64로 싣고, 서명은 파일이 든 본문 그대로', async () => {
    const t = deps(ctx(true));
    expect(await dispatchDueDeliveries(t.d)).toMatchObject({ sent: 1 });
    expect(t.buildFile).toHaveBeenCalledTimes(1);
    expect(t.buildFile.mock.calls[0][0]).toMatchObject({ agent: { id: 'a1', app_definition: { exportTemplateId: 'tpl' } }, message: { content: '최종 결과', agent_version: 3 } });
    const { headers, body } = t.posted[0];
    const file = JSON.parse(body).result.file;
    expect(Buffer.from(file.data, 'base64').equals(t.bytes)).toBe(true);
    expect(file).toMatchObject({ name: '주간 보고 앱 작성 결과.hwpx', size: t.bytes.length, sha256: createHash('sha256').update(t.bytes).digest('hex') });
    const ts = headers[OUTBOUND_HEADERS.timestamp];
    expect(headers[OUTBOUND_HEADERS.signature]).toBe(`sha256=${createHmac('sha256', 's3cret').update(`${ts}.${body}`).digest('hex')}`);
  });

  it('고르지 않았으면(없음·false·참 아닌 값) 만들지 않고 file 칸도 없다', async () => {
    for (const flag of [undefined, false, 'true']) {
      const t = deps(ctx(flag));
      await dispatchDueDeliveries(t.d);
      expect(t.buildFile).not.toHaveBeenCalled();
      expect(JSON.parse(t.posted[0].body).result).not.toHaveProperty('file');
    }
  });

  it('5MB를 넘으면 글만 보내고 file_omitted', async () => {
    const t = deps(ctx(true), { buildFile: async () => ({ name: 'x.hwpx', bytes: Buffer.alloc(OUTBOUND_FILE_MAX_BYTES + 1) }) });
    expect(await dispatchDueDeliveries(t.d)).toMatchObject({ sent: 1 });
    const result = JSON.parse(t.posted[0].body).result;
    expect(result.file).toBeNull();
    expect(result.file_omitted).toBe('too_large');
    expect(result.text).toBe('최종 결과');
  });

  it('파일을 못 만들면 보내지 않고 다시 보낼 일(시도 수를 셈)', async () => {
    const t = deps(ctx(true), { buildFile: async () => { throw new Error('storage'); } });
    expect(await dispatchDueDeliveries(t.d)).toMatchObject({ sent: 0, retried: 1 });
    expect(t.posted).toHaveLength(0);
    expect(t.finished[0].patch).toMatchObject({ status: 'pending', attempts: 1, last_error: '결과 한글 파일을 만들지 못했습니다(잠시 뒤 다시 보냄).' });
  });

  it('주소가 막히면 파일을 만들지도 않는다', async () => {
    const t = deps(ctx(true), { checkHost: async () => ({ ok: false, retry: false, message: '내부망' }) });
    expect(await dispatchDueDeliveries(t.d)).toMatchObject({ gaveUp: 1 });
    expect(t.buildFile).not.toHaveBeenCalled();
  });
});

describe('결과 한글 파일 바이트', () => {
  it('양식을 고르지 않은 앱은 표준 보고서에 저장된 답을 그대로 — 저장하지 않는다', async () => {
    const built = await buildResultHwpxBytes({ agentId: 'a1', appName: '주간 보고 앱', exportTemplateId: undefined, message: { content: '## 주간 보고\n- 민원 처리 12건', source_references: null, agent_version: 2 } });
    expect(built.fileName).toMatch(/\.hwpx$/);
    expect(built.templateName).toBe('앱 실행 결과');
    const text = await extractTextFromHwp(built.bytes, 'r.hwpx');
    expect(text).toContain('민원 처리 12건');
    expect(text).toContain('주간 보고 앱');
  });
});

describe('연결', () => {
  it('보내기 직전에 앱 정의·답의 근거·판을 읽고, 빌더에 고르는 칸', () => {
    const lib = readFileSync('src/lib/apps/outbound/deliver.ts', 'utf8');
    expect(lib).toContain("select('content, conversation_id, created_at, role, source_references, agent_version')");
    expect(lib).toContain("select('id, name, app_definition')");
    expect(lib).toContain('buildResultHwpxBytes({');
    const builder = readFileSync('src/app/apps/builder/page.tsx', 'utf8');
    expect(builder).toContain('결과 한글 파일도 함께 보내기');
    expect(builder).toContain('on && d.deliverEndpointId');
  });
});
