// tests/batch-0345.test.ts
// 시민용 민원 상담 창 엔진(2026-11-27, 0136) — 꺼짐·없음·준비 안 됨·예산·마감·개인정보 거절·근거 없음·답함·확인 못 하면 닫힘
import { describe, expect, it, vi } from 'vitest';
import { askPublic, ipHashOf, loadPublicConfig, type PublicAskDeps, type LogPatch, type PublicAskEvent } from '@/lib/public-ask/service';
import { frameAncestors, normalizeOrigin, parsePublicAskSettings, PUBLIC_ASK_MESSAGES } from '@/lib/public-ask/spec';

const ORG = { id: 'o1', name: '시험공단', status: 'active', logo_url: null, theme_color: null };
const SETTINGS = { enabled: true, agent_id: 'a1', notice: '안내', faq: ['대관 신청'], contacts: [{ name: '체육시설팀', phone: '02-000-0000', note: '' }], allowed_origins: [], ip_daily_cap: 20, org_daily_cap: 500 };
const AGENT = { id: 'a1', organization_id: 'o1', department_id: 'd1', tier: 'public', deleted_at: null, is_active: true, model_id: null, system_prompt: '시민 상담 비서' };
const CHUNK = { documentId: 'doc1', documentTitle: '체육시설 이용 규정', chunkIndex: 0, n: 1, text: '환불은 이용 3일 전까지 전액', similarity: 0.9, page: 3 };

function deps(over: Partial<PublicAskDeps> = {}) {
  const logs: { id: string; patch: LogPatch }[] = [];
  const usage: string[] = [];
  const d: PublicAskDeps = {
    loadOrg: async () => ORG,
    loadSettings: async () => SETTINGS,
    loadAgent: async () => AGENT,
    orgBudgetExhausted: async () => false,
    claim: async () => ({ status: 'ok', id: 'log1' }),
    passesFilter: async () => true,
    prepare: async () => ({ chunks: [CHUNK], systemAddendum: '참고 자료: [1] 환불은 이용 3일 전까지 전액' }),
    resolveModel: async () => 'claude-sonnet-4-6',
    async *stream() {
      yield { type: 'text', text: '이용 3일 전까지 ' };
      yield { type: 'text', text: '전액 환불됩니다 [1].' };
      yield { type: 'done', usage: { model: 'claude-sonnet-4-6', input_tokens: 100, output_tokens: 20 }, stopReason: 'end_turn' };
    },
    finishLog: async (id, patch) => { logs.push({ id, patch }); },
    logUsage: async (_dept, agentId) => { usage.push(agentId); },
    now: () => Date.parse('2026-11-27T03:00:00Z'),
    ...over,
  };
  return { d, logs, usage };
}
async function collect(gen: AsyncGenerator<PublicAskEvent>) { const out: PublicAskEvent[] = []; for await (const e of gen) out.push(e); return out; }
const ask = (d: PublicAskDeps, question: unknown = '수영장 환불은 어떻게 되나요?') => askPublic({ slug: 'test', question, ip: '203.0.113.5' }, d);

describe('시민 상담 — 거절', () => {
  it('질문 꼴·없는 기관·꺼짐·정지 기관·비서가 시민 전용이 아님', async () => {
    expect(await ask(deps().d, '')).toMatchObject({ ok: false, status: 400 });
    expect(await ask(deps().d, 'x'.repeat(501))).toMatchObject({ ok: false, status: 400 });
    expect(await ask(deps({ loadOrg: async () => null }).d)).toMatchObject({ ok: false, status: 404 });
    expect(await ask(deps({ loadSettings: async () => ({ ...SETTINGS, enabled: false }) }).d)).toMatchObject({ ok: false, status: 403, code: 'closed' });
    expect(await ask(deps({ loadOrg: async () => ({ ...ORG, status: 'suspended' }) }).d)).toMatchObject({ ok: false, status: 403 });
    expect(await ask(deps({ loadAgent: async () => ({ ...AGENT, tier: 'official' }) }).d)).toMatchObject({ ok: false, status: 503, code: 'not_ready' });
    expect(await ask(deps({ loadAgent: async () => ({ ...AGENT, organization_id: 'o2' }) }).d)).toMatchObject({ ok: false, code: 'not_ready' });
  });
  it('기관 예산을 다 쓰면·IP/기관 마감이면 모델을 부르지 않는다', async () => {
    const stream = vi.fn();
    expect(await ask(deps({ orgBudgetExhausted: async () => true, stream }).d)).toMatchObject({ ok: false, status: 429, code: 'budget' });
    expect(await ask(deps({ claim: async () => ({ status: 'capped_ip' }), stream }).d)).toMatchObject({ ok: false, message: PUBLIC_ASK_MESSAGES.cappedIp });
    expect(await ask(deps({ claim: async () => ({ status: 'capped_org' }), stream }).d)).toMatchObject({ ok: false, message: PUBLIC_ASK_MESSAGES.cappedOrg });
    expect(stream).not.toHaveBeenCalled();
  });
  it('개인정보·금지어에 걸리면 거절하고 기록에 질문 글을 남기지 않는다', async () => {
    const { d, logs } = deps({ passesFilter: async () => false });
    expect(await ask(d, '900101-1234567 환불')).toMatchObject({ ok: false, status: 400, code: 'rejected' });
    expect(logs).toEqual([{ id: 'log1', patch: { result: 'rejected_pii' } }]);
  });
  it('확인 못 하면 닫힘 — 예산·금지어를 못 읽으면 던지고(라우트 503), 차지한 줄은 답하지 못함으로', async () => {
    await expect(ask(deps({ orgBudgetExhausted: async () => { throw new Error('db'); } }).d)).rejects.toThrow();
    const { d, logs } = deps({ passesFilter: async () => { throw new Error('forbidden_words_unavailable'); } });
    await expect(ask(d)).rejects.toThrow();
    expect(logs[0].patch.result).toBe('unavailable');
  });
});

describe('시민 상담 — 답', () => {
  it('근거로 답하면 흘려 보내고 기록·사용 기록(public_ask)을 남긴다', async () => {
    const { d, logs, usage } = deps();
    const r = await ask(d);
    if (!r.ok) throw new Error('거절됨');
    const events = await collect(r.events);
    expect(events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join('')).toBe('이용 3일 전까지 전액 환불됩니다 [1].');
    expect(events.at(-1)).toMatchObject({ type: 'done', found: true, sources: ['체육시설 이용 규정 · p.3'] });
    expect(logs[0].patch).toMatchObject({ result: 'answered', question: '수영장 환불은 어떻게 되나요?', input_tokens: 100, output_tokens: 20 });
    expect(usage).toEqual(['a1']);
  });
  it('근거가 없으면 no_source로 기록하고 연락처를 함께 돌려준다', async () => {
    const { d, logs } = deps({ prepare: async () => ({ chunks: [], systemAddendum: '[문서 검색 결과 없음]' }) });
    const r = await ask(d);
    if (!r.ok) throw new Error('거절됨');
    const done = (await collect(r.events)).at(-1);
    expect(done).toMatchObject({ type: 'done', found: false, contacts: [{ name: '체육시설팀' }] });
    expect(logs[0].patch.result).toBe('no_source');
  });
  it('찾기를 못 부르면 503, 모델이 중간에 끊기면 error 이벤트', async () => {
    expect(await ask(deps({ prepare: async () => null }).d)).toMatchObject({ ok: false, status: 503 });
    const { d, logs } = deps({ async *stream() { yield { type: 'text', text: '부분' }; throw new Error('끊김'); } });
    const r = await ask(d);
    if (!r.ok) throw new Error('거절됨');
    expect((await collect(r.events)).at(-1)).toEqual({ type: 'error', message: PUBLIC_ASK_MESSAGES.unavailable });
    expect(logs[0].patch.result).toBe('unavailable');
  });
  it('IP는 해시만, 공개 설정에는 비서 id가 없다', async () => {
    expect(ipHashOf('203.0.113.5')).toMatch(/^[0-9a-f]{64}$/);
    const c = await loadPublicConfig('test', deps().d);
    expect(c.ok && JSON.stringify(c.config)).not.toContain('a1');
  });
});

describe('설정 검사', () => {
  it('켤 때 사유·상한 범위·https 홈페이지만', () => {
    expect(parsePublicAskSettings({ enabled: true })).toMatchObject({ ok: false });
    expect(parsePublicAskSettings({ enabled: false, ipDailyCap: 101 })).toMatchObject({ ok: false });
    expect(parsePublicAskSettings({ enabled: false, allowedOrigins: ['http://x.go.kr'] })).toMatchObject({ ok: false });
    const ok = parsePublicAskSettings({ enabled: true, reason: '시민 상담 시작', allowedOrigins: ['https://WWW.Agency.go.kr/path'], faq: ['대관 신청', '대관 신청'] });
    expect(ok).toMatchObject({ ok: true, value: { allowedOrigins: ['https://www.agency.go.kr'], faq: ['대관 신청'], ipDailyCap: 20, orgDailyCap: 500 } });
    expect(normalizeOrigin('javascript:alert(1)')).toBeNull();
    expect(frameAncestors([])).toBe("frame-ancestors 'self'");
    expect(frameAncestors(['https://a.go.kr'])).toBe("frame-ancestors 'self' https://a.go.kr");
  });
});
