// tests/batch-0349.test.ts
// 시민 상담 미리 물어보기(2026-11-28) — 창을 열기 전에 기관 전체 관리자가 같은 엔진으로 답을 본다.
// 켜짐·하루 횟수를 보지 않고 시민 기록에 남기지 않는다(사용 기록은 남음)
import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
import { askPublic, type PublicAskDeps, type PublicAskEvent } from '@/lib/public-ask/service';

const ORG = { id: 'o1', name: '시험공단', status: 'active', logo_url: null, theme_color: null };
const SETTINGS = { enabled: false, agent_id: 'a1', notice: '', faq: [], contacts: [], allowed_origins: [], ip_daily_cap: 20, org_daily_cap: 500 };
const AGENT = { id: 'a1', organization_id: 'o1', department_id: 'd1', tier: 'public', deleted_at: null, is_active: true, model_id: null, system_prompt: null };

function deps(over: Partial<PublicAskDeps> = {}) {
  const claim = vi.fn(async () => ({ status: 'ok' as const, id: 'log1' }));
  const finishLog = vi.fn(async () => {});
  const logUsage = vi.fn(async () => {});
  const d: PublicAskDeps = {
    loadOrg: async () => ORG, loadSettings: async () => SETTINGS, loadAgent: async () => AGENT, orgBudgetExhausted: async () => false,
    claim, passesFilter: async () => true, prepare: async () => ({ chunks: [], systemAddendum: '' }), resolveModel: async () => 'claude-sonnet-4-6',
    async *stream() { yield { type: 'text', text: '답' }; yield { type: 'done', usage: { model: 'claude-sonnet-4-6', input_tokens: 1, output_tokens: 1 }, stopReason: 'end_turn' }; },
    finishLog, logUsage, now: () => Date.now(), ...over,
  };
  return { d, claim, finishLog, logUsage };
}

describe('미리 물어보기', () => {
  it('꺼진 창도 답하고, 하루 횟수를 차지하지 않으며 시민 기록에 남기지 않는다 — 사용 기록은 남김', async () => {
    const { d, claim, finishLog, logUsage } = deps();
    expect(await askPublic({ slug: 's', question: '환불?', ip: null }, d)).toMatchObject({ ok: false, code: 'closed' });
    const r = await askPublic({ slug: 's', question: '환불?', ip: null, preview: true }, d);
    if (!r.ok) throw new Error('거절됨');
    const evs: PublicAskEvent[] = []; for await (const e of r.events) evs.push(e);
    expect(evs.at(-1)).toMatchObject({ type: 'done' });
    expect(claim).not.toHaveBeenCalled();
    expect(finishLog).not.toHaveBeenCalled();
    expect(logUsage).toHaveBeenCalledTimes(1);
  });
  it('정지 기관·비서 없음은 미리 보기도 거절', async () => {
    expect(await askPublic({ slug: 's', question: 'q', ip: null, preview: true }, deps({ loadOrg: async () => ({ ...ORG, status: 'terminated' }) }).d)).toMatchObject({ ok: false, code: 'closed' });
    expect(await askPublic({ slug: 's', question: 'q', ip: null, preview: true }, deps({ loadSettings: async () => null }).d)).toMatchObject({ ok: false, code: 'not_ready' });
  });
  it('관리자 라우트·화면 — 기관 전체 관리자만, 화면은 미리 보기 주소로', () => {
    const route = readFileSync('src/app/api/admin/public-ask/test/route.ts', 'utf8');
    expect(route).toContain('managesWholeOrganization');
    expect(route).toContain('preview: true');
    expect(readFileSync('src/components/admin/PublicAskPanel.tsx', 'utf8')).toContain('endpoint="/api/admin/public-ask/test"');
  });
});

describe('공공 고유 업무 앱 둘(2026-11-28)', () => {
  it('정보공개 청구 검토는 제9조 갈래를 지시문에 두고 입력만, 개인정보 가리기 점검은 파일 필수·값을 다시 적지 않음', async () => {
    const { PUBLIC_SECTOR_FORM_PRESETS } = await import('@/lib/agent-presets');
    const foi = PUBLIC_SECTOR_FORM_PRESETS.find((p) => p.name === '정보공개 청구 검토')!;
    const pii = PUBLIC_SECTOR_FORM_PRESETS.find((p) => p.name === '개인정보 가리기 점검')!;
    expect(foi.systemPrompt).toContain('제9조 제1항');
    expect(foi.systemPrompt).toContain('부분공개');
    expect(foi.appDefinition!.attachments).toBeUndefined();
    expect(pii.appDefinition!.attachments).toEqual({ required: true });
    expect(pii.systemPrompt).toContain('값은 가린 꼴');
    expect(pii.systemPrompt).toContain('사람이 문서 전체를 다시 확인');
  });
});

describe('공공 고유 업무 앱 둘(2026-11-28, 2)', () => {
  it('감사 지적 조치계획은 지적 사항 줄마다 반복, 사업 결과보고서는 입력만', async () => {
    const { PUBLIC_SECTOR_FORM_PRESETS } = await import('@/lib/agent-presets');
    const audit = PUBLIC_SECTOR_FORM_PRESETS.find((p) => p.name === '감사 지적 조치계획')!.appDefinition!;
    const report = PUBLIC_SECTOR_FORM_PRESETS.find((p) => p.name === '사업 결과보고서')!.appDefinition!;
    expect(audit.steps?.[0].repeat).toEqual({ field: 'findings' });
    expect(report.attachments).toBeUndefined();
    expect(report.steps).toHaveLength(2);
  });
});
