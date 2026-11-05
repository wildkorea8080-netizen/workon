import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { parseUsageGroups, usageRowsFromGroups, type UsageGroup } from '@/lib/usage-summary';

/**
 * 관리자 이용통계를 DB가 묶는다(0058, 2026-11-05) — 예전에는 기록을 앱으로 읽어 묶어 50,000행에서 멈췄다.
 * DB는 (묶음·활동·모델)마다 세고, 앱은 이름을 붙여 합치고 정렬한다.
 */

const g = (over: Partial<UsageGroup>): UsageGroup => ({ bucket: 'a1', action: 'chat_message', model: 'claude-sonnet-4-6', count: 1, input_tokens: 10, output_tokens: 5, cost_krw: 1.5, ...over });

describe('묶음 → 화면 행', () => {
  it('묶음마다 합치고, 모델은 토큰을 쓴 묶음만, 활동은 모두', () => {
    const rows = usageRowsFromGroups([
      g({ count: 1000, input_tokens: 10_000, output_tokens: 5_000, cost_krw: 1_500 }),
      g({ model: 'claude-opus-5', count: 500, input_tokens: 5_000, output_tokens: 2_500, cost_krw: 2_000 }),
      g({ action: 'document_generated', model: null, count: 3, input_tokens: 0, output_tokens: 0, cost_krw: 0 }),
      g({ bucket: 'a2', count: 2, input_tokens: 20, output_tokens: 10, cost_krw: 3 }),
    ], new Map([['a1', { name: '여비 비서', sub: '🧳' }]]));
    expect(rows.map((r) => [r.key, r.name, r.count, r.inputTokens, r.costKrw])).toEqual([
      ['a1', '여비 비서', 1503, 15_000, 3_500],
      ['a2', '(삭제됨)', 2, 20, 3],
    ]);
    expect(rows[0].models.map((m) => [m.key, m.count, m.costKrw])).toEqual([['claude-opus-5', 500, 2_000], ['claude-sonnet-4-6', 1000, 1_500]]);
    expect(rows[0].actions.map((a) => [a.label, a.count])).toEqual([['AI 대화', 1500], ['문서 파일 생성', 3]]);
  });
  it('원가가 같으면 횟수 순, 모르는 활동은 코드 그대로', () => {
    const rows = usageRowsFromGroups([g({ bucket: 'x', cost_krw: 0, count: 1 }), g({ bucket: 'y', cost_krw: 0, count: 9, action: 'new_thing' })], new Map());
    expect(rows.map((r) => r.key)).toEqual(['y', 'x']);
    expect(rows[0].actions[0].label).toBe('new_thing');
  });
  it('DB 응답 다듬기 — 배열이 아니거나 모양이 틀린 원소는 버리고, 숫자 글자는 숫자로, 빈 모델은 null', () => {
    expect(parseUsageGroups(null)).toEqual([]);
    expect(parseUsageGroups({})).toEqual([]);
    expect(parseUsageGroups([null, 3, { bucket: 1, action: 'a' }, { bucket: 'b', action: 'chat_message', model: '', count: '7', input_tokens: '12.5', output_tokens: 'abc', cost_krw: null }])).toEqual([
      { bucket: 'b', action: 'chat_message', model: null, count: 7, input_tokens: 12.5, output_tokens: 0, cost_krw: 0 },
    ]);
  });
});

describe('연결·마이그레이션(원본 확인)', () => {
  it('라우트는 관리 범위·기간·축·옛 모델을 넘겨 DB 함수를 부르고, 보는 축의 이름 사전만 읽는다', () => {
    const route = readFileSync('src/app/api/admin/usage-summary/route.ts', 'utf8');
    for (const s of ["supabaseAdmin.rpc('usage_summary'", 'p_department_ids: managedDeptIds', 'p_axis: axis', 'p_legacy_model: LEGACY_PRICING_MODEL_ID', "if (axis === 'user')", 'usageRowsFromGroups(parseUsageGroups(grouped), names)']) {
      expect(route).toContain(s);
    }
    expect(route).toContain('isAdminSession(session)');
  });
  it('0058 — 셈 규칙(비서 없는 기록 빼기·숫자 아닌 값 0·토큰 쓴 기록만 모델·옛 모델), 값 하나로 돌려줌, 실행 권한 service_role만', () => {
    const sql = readFileSync('supabase/migrations/0058_usage_summary.sql', 'utf8');
    for (const s of [
      "WHEN 'agent' THEN NULLIF(l.details->>'agent_id', '')",
      "WHEN 'user' THEN COALESCE(l.user_id::text, '(알 수 없음)')",
      'CASE WHEN inp > 0 OR outp > 0 THEN COALESCE(model_raw, p_legacy_model) END AS model',
      'WHERE l.department_id = ANY(p_department_ids)',
      'AND l.created_at <= p_to',
      'RETURNS jsonb',
      'REVOKE ALL ON FUNCTION public.usage_summary(uuid[], timestamptz, timestamptz, text, text) FROM PUBLIC, anon, authenticated',
      'GRANT EXECUTE ON FUNCTION public.usage_summary(uuid[], timestamptz, timestamptz, text, text) TO service_role',
    ]) expect(sql).toContain(s);
  });
});
