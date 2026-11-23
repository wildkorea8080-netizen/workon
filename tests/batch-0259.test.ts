import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { actionErrorText } from '@/lib/ok-json';

// 0259 — 관리자 비서 화면(AgentsManager)의 조작이 실패해도 아무것도 안 보이던 것.
// 예전엔 `throw new Error(result.error?.message)` → 서버가 안내 글 없이 실패하면 빈 글('')의 오류가 되어
// `err instanceof Error ? err.message : …`가 ''를 골랐고 `{error && …}`가 그리지 않았다(승인·반려는 빈 alert).
// 응답 몸이 JSON이 아니면 영어 구문 오류 글이, 연결이 끊기면 'Failed to fetch'가 그대로 보였다.
// '활성/비활성' 단추는 실패를 아예 알리지 않았다(몸을 못 읽으면 처리되지 않은 오류).

const src = readFileSync('src/components/admin/AgentsManager.tsx', 'utf8').replace(/\r\n/g, '\n');

describe('actionErrorText', () => {
  it('서버 안내 글이 있으면 그 글', () => {
    expect(actionErrorText(new Error('이름이 겹칩니다.'), '실패')).toBe('이름이 겹칩니다.');
  });
  it('빈 글·공백·undefined 메시지는 정해 둔 글', () => {
    expect(actionErrorText(new Error(undefined), '저장하지 못했습니다.')).toBe('저장하지 못했습니다.');
    expect(actionErrorText(new Error('  '), '저장하지 못했습니다.')).toBe('저장하지 못했습니다.');
  });
  it('구문 오류·연결 실패·오류가 아닌 값은 정해 둔 글', () => {
    expect(actionErrorText(new SyntaxError('Unexpected token < in JSON'), '실패')).toBe('실패');
    expect(actionErrorText(new TypeError('Failed to fetch'), '실패')).toBe('실패');
    expect(actionErrorText('x', '실패')).toBe('실패');
    expect(actionErrorText(null, '실패')).toBe('실패');
  });
});

describe('관리자 비서 화면', () => {
  it('오류 글은 모두 actionErrorText로 고른다', () => {
    expect(src).not.toContain('err instanceof Error ? err.message');
    expect((src.match(/actionErrorText\(err, '/g) ?? []).length).toBeGreaterThanOrEqual(11);
  });

  it("'활성/비활성' 실패를 알린다", () => {
    const i = src.indexOf('const handleToggleActive = async');
    const body = src.slice(i, src.indexOf('\n  };', i));
    expect(body).toContain('catch (err)');
    expect(body).toContain("setError(actionErrorText(err, '");
  });
});
