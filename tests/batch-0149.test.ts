import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));

import { departmentDescendantsStrict } from '@/lib/department-scope';

/**
 * 2026-11-18 — 읽기 실패를 '없음'·'빈 값'으로 보고 판정을 통과시키던 곳.
 * ① 부서 이동의 순환 검사가 하위 부서를 `getSharedDepartmentIds`(실패하면 자기 부서만 — 보이는 범위에는 안전)로 읽어,
 *    읽기가 실패하면 '하위 없음'이 되어 자기 하위 부서 밑으로 옮기는 이동을 통과시켰다(끊어진 고리).
 * ② 비서 설정 저장이 지금 값을 못 읽으면 빈 값으로 보고 유형을 'chat'으로, 모든 설정을 '바뀜'으로 판정했다.
 * ③ 슈퍼관리자 공지 목록은 못 읽어도 빈 목록(ok)이었다.
 */

describe('departmentDescendantsStrict', () => {
  const rpc = (r: { data: unknown; error: unknown }) => vi.fn(async () => r);
  it('하위 부서(자기 포함)', async () => {
    const f = rpc({ data: [{ id: 'd1' }, { id: 'd2' }, { id: 'd3' }], error: null });
    expect(await departmentDescendantsStrict('d1', f)).toEqual(['d1', 'd2', 'd3']);
    expect(f).toHaveBeenCalledWith('department_descendants', { p_department_id: 'd1' });
  });
  it('자기가 빠져 오면 붙인다', async () => {
    expect(await departmentDescendantsStrict('d1', rpc({ data: [{ id: 'd2' }], error: null }))).toEqual(['d1', 'd2']);
    expect(await departmentDescendantsStrict('d1', rpc({ data: [], error: null }))).toEqual(['d1']);
  });
  it('못 읽으면 null — 자기 부서만으로 꾸미지 않음', async () => {
    expect(await departmentDescendantsStrict('d1', rpc({ data: null, error: { code: 'X' } }))).toBeNull();
    expect(await departmentDescendantsStrict('d1', rpc({ data: 'x', error: null }))).toBeNull();
    expect(await departmentDescendantsStrict('', rpc({ data: [], error: null }))).toBeNull();
  });
});

describe('쓰는 곳', () => {
  it('부서 이동 순환 검사는 엄격한 읽기 — 못 읽으면 503, 관리자 부서 읽기 실패도 503', () => {
    const s = readFileSync('src/app/api/departments/[id]/route.ts', 'utf8');
    expect(s).toContain('const descendants = await departmentDescendantsStrict(target.id);');
    expect(s).toMatch(/if \(!descendants\) \{\s*return NextResponse\.json\([^)]*\{ status: 503 \}/);
    expect(s).not.toContain('getSharedDepartmentIds');
    expect(s).toMatch(/if \(readError\) \{\s*return \{ error: NextResponse\.json\([^\n]*503/);
  });
  it('비서 설정 저장은 지금 값을 못 읽으면 503', () => {
    const s = readFileSync('src/app/api/agents/[id]/route.ts', 'utf8');
    expect(s).toContain("if (currentError || !current) return jsonError('비서 설정을 지금 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 503);");
    expect(s).not.toContain('(current ?? {})');
  });
  it('슈퍼관리자 공지 목록은 못 읽으면 503', () => {
    const s = readFileSync('src/app/api/super/notices/route.ts', 'utf8');
    const block = s.slice(s.indexOf('if (error) {'), s.indexOf('const notices ='));
    expect(block).toContain('status: 503');
    expect(block).not.toContain('ok: true');
  });
});
