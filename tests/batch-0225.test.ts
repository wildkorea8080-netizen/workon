import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

/**
 * 2026-11-20 — 실패해도 아무 반응이 없던 단추 둘.
 * ① 비서 만들기 창의 '프롬프트 다듬기': 응답이 실패여도(월 한도 429·모델 오류·연결 실패) 조용히 끝났다 —
 *    단추가 돌다 멈출 뿐, 한도에 걸린 것인지 알 수 없었다(비서 편집 창의 같은 단추는 알린다).
 * ② 비서 카드의 ★ 즐겨찾기: 바꾸지 못해도(서버는 읽기 실패를 503으로 답한다) 별이 그대로이고 까닭이 없었다.
 * 이제 서버가 준 안내(없으면 정해 둔 문구)를 보인다.
 */

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

describe('비서 만들기 창 — 프롬프트 다듬기 (원본)', () => {
  const src = read('src/components/chat/CreateAgentModal.tsx');
  const fn = src.slice(src.indexOf('const handleEnhance = async () => {'), src.indexOf('const addFiles ='));

  it('실패를 알린다 — 서버 안내 먼저, 없으면 정해 둔 문구', () => {
    expect(fn).toContain('setError(null);');
    expect(fn).toContain('if (result?.ok) setSystemPrompt(result.data.enhancedPrompt);');
    expect(fn).toContain('else setError(result?.error?.message ?? ENHANCE_FAILED);');
  });
  it('연결 실패·몸을 못 읽은 응답도 조용히 넘기지 않는다', () => {
    expect(fn).toContain('await res.json().catch(() => null)');
    expect(fn).toContain('} catch {\n      setError(ENHANCE_FAILED);');
    expect(fn).not.toContain('// silent');
  });
  it('실패해도 적은 지시문은 그대로 둔다', () => {
    expect(fn.split('setSystemPrompt(').length).toBe(2);
  });
});

describe('비서 고르기 — ★ 즐겨찾기 (원본)', () => {
  const src = read('src/components/chat/AgentSelector.tsx');
  const fn = src.slice(src.indexOf('const handleFavoriteToggle = async'), src.indexOf('return (\n    <>'));

  it('바꾸지 못하면 알리고 별은 그대로', () => {
    expect(fn).toContain('if (!result?.ok) { setFavoriteError(result?.error?.message ?? FAVORITE_FAILED); return; }');
    expect(fn).toContain('} catch {\n      setFavoriteError(FAVORITE_FAILED);');
    expect(fn).not.toContain('// ignore');
    // 실패 길에서 즐겨찾기 목록을 바꾸지 않는다
    expect(fn.indexOf('setFavoriteIds(')).toBeGreaterThan(fn.indexOf('setFavoriteError(null);'));
  });
  it('되면 앞 알림을 지운다, 알림은 목록을 가리지 않고 위에 보인다', () => {
    expect(fn).toContain('setFavoriteError(null);');
    expect(src).toContain('{favoriteError && <p role="alert" className="mb-3 text-center text-xs text-red-500">{favoriteError}</p>}');
    expect(src.indexOf('{favoriteError && <p role="alert"')).toBeLessThan(src.indexOf('{loading ? ('));
  });
});
