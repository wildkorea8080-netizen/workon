import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { SEARCH_MAX_CHARS, orIlike, searchTerm } from '@/lib/postgrest-search';

/**
 * 2026-11-18 — 찾기 글을 PostgREST 필터 글에 그대로 넣던 곳. 슈퍼관리자 계정 관리·기관 상세 사용자 찾기는
 * `.or(\`email.ilike.%${search}%,…\`)`라 쉼표 하나로 조회가 깨지고(500) 조건을 덧붙일 수 있었다. 업무 작업 목록 커서도 Date.parse만 봤다.
 * 같은 묶음: 기관 상세 '사용량' 탭의 예상 비용을 기록한 원가로, 토큰은 숫자만.
 */

describe('searchTerm', () => {
  it('감싸기를 깨는 글자·제어 글자만 뺀다 — 이메일의 점·밑줄은 그대로', () => {
    expect(searchTerm('kim_lee@x.kr')).toBe('kim_lee@x.kr');
    expect(searchTerm('a,b')).toBe('a,b');
    expect(searchTerm('x",role.eq.ADMIN')).toBe('x ,role.eq.ADMIN');
    expect(searchTerm(String.raw`a\b`)).toBe('a b');
    expect(searchTerm('이​경우')).toBe('이 경우');
  });
  it('빈 글·글 아님은 null, 60자로 자름', () => {
    for (const v of ['', '   ', '"""', null, 5, undefined]) expect(searchTerm(v)).toBeNull();
    expect(searchTerm('가'.repeat(100))!.length).toBe(SEARCH_MAX_CHARS);
  });
  it('orIlike', () => {
    expect(orIlike(['email', 'full_name'], 'a,b')).toBe('email.ilike."%a,b%",full_name.ilike."%a,b%"');
  });
  it('잎 파일', () => {
    expect(readFileSync('src/lib/postgrest-search.ts', 'utf8')).not.toMatch(/^import /m);
  });
});

describe('쓰는 곳', () => {
  it('찾기 글을 그대로 필터에 넣는 곳이 없다', () => {
    for (const p of ['src/app/api/super/accounts/users/route.ts', 'src/app/api/super/organizations/[id]/users/route.ts', 'src/app/api/super/organizations/route.ts']) {
      const s = readFileSync(p, 'utf8');
      expect(s, p).not.toMatch(/\$\{search\}/);
      expect(s, p).toContain('searchTerm(search)');
    }
  });
  it('업무 작업 목록 커서는 ISO 시각·uuid만, 만들 때도 ISO로', () => {
    const s = readFileSync('src/lib/work/services.ts', 'utf8');
    expect(s).toContain('(Z|[+-]\\d{2}:\\d{2})$/.test(updatedAt)');
    expect(s).toContain('cursorTime(last.updated_at)');
  });
  it('기관 상세 사용량 — 기록한 원가, 숫자만', () => {
    const s = readFileSync('src/app/api/super/organizations/[id]/usage/route.ts', 'utf8');
    expect(s).toContain('sumCostUsd(allRows)'); // 원가는 모든 활동(2026-11-19, batch-0188)
    expect(s).not.toContain('estimateCostUsd(');
    expect(s).toContain('num(row.details?.input_tokens)');
  });
});
