import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-20 — 업무 저장소(운영 Supabase)가 기관·부서 이름과 사용자 활성 여부를 못 읽으면 '없음'으로 보던 것.
 * ① 기관명·부서명: 실행기가 공문·보고서·민원 회신·감사 요구자료의 기관명·부서명 칸에 넣는다 — 못 읽으면 빈 칸으로 문서를 만들었다
 *    → 던져 실행을 다시 시도(pg 저장소는 원래 던진다).
 * ② 활성 여부: 못 읽으면 비활성으로 보아 업무 API가 '업무를 쓸 수 없음'(403)이었다 → 503 `ACTOR_UNAVAILABLE`.
 * ③ 예산 알림의 기관 담당자 주소를 못 읽으면 빼고 관리자에게만 보내 '보냄'으로 끝냈다 → 던짐(부서 알림의 받는 사람과 같게).
 */

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));

import { createSupabaseWorkStore } from '@/lib/work/store/supabase';
import { WorkError } from '@/lib/work/types';

function fakeDb(result: { data: unknown; error: unknown }) {
  const b: Record<string, unknown> = {};
  for (const n of ['select', 'eq', 'is', 'in']) b[n] = () => b;
  b.maybeSingle = async () => result;
  return { from: () => b } as never;
}

const failing = () => createSupabaseWorkStore(fakeDb({ data: null, error: { code: 'XX000', message: 'boom' } }));

describe('업무 저장소의 읽기 실패', () => {
  it('기관명을 못 읽으면 던진다', async () => {
    await expect(failing().getOrganizationName('o1')).rejects.toThrow('업무 DB 오류');
  });
  it('부서명을 못 읽으면 던진다', async () => {
    await expect(failing().getDepartmentName('d1', 'o1')).rejects.toThrow('업무 DB 오류');
  });
  it('활성 여부를 못 읽으면 503 ACTOR_UNAVAILABLE', async () => {
    const err = await failing().isUserActive('u1').catch((e) => e);
    expect(err).toBeInstanceOf(WorkError);
    expect(err).toMatchObject({ code: 'ACTOR_UNAVAILABLE', status: 503 });
  });
  it('정말 없으면 예전과 같다', async () => {
    const store = createSupabaseWorkStore(fakeDb({ data: null, error: null }));
    expect(await store.getOrganizationName('o1')).toBeNull();
    expect(await store.getDepartmentName('d1', 'o1')).toBeNull();
    expect(await store.isUserActive('u1')).toBe(false);
  });
  it('읽히면 그 값', async () => {
    expect(await createSupabaseWorkStore(fakeDb({ data: { name: '총무과' }, error: null })).getDepartmentName('d1', 'o1')).toBe('총무과');
    expect(await createSupabaseWorkStore(fakeDb({ data: { is_active: true }, error: null })).isUserActive('u1')).toBe(true);
  });
});

describe('예산 알림의 기관 담당자 주소', () => {
  it('못 읽으면 던진다(관리자에게만 보내고 끝내지 않음)', () => {
    const src = readFileSync('src/lib/budget-alerts.ts', 'utf8');
    expect(src).toContain("const { data: org, error: orgError } = await supabaseAdmin.from('organizations').select('contact_email, budget_alert_emails')");
    expect(src).toContain('if (orgError) throw new Error(`organizations: ${orgError.message}`);');
  });
});
