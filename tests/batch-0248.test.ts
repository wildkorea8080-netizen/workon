import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

/**
 * 2026-11-21 — 대화 첫 화면의 비서 고르기(`AgentSelector`)가 못 읽은 목록을 앞 탭의 목록으로 보이지 않는다.
 * ① 탭을 빨리 바꾸면 늦게 온 앞 탭의 응답이 새 탭의 목록을 덮었다(요청 순번이 없었다) — '즐겨찾기' 탭에 전체 비서가 보이는 식.
 * ② 서버가 `{ ok: false }`를 안내 글 없이 주면 `new Error(undefined)`의 빈 글이 오류가 되어 오류 칸이 비고(거짓으로 읽힘)
 *    **앞 탭의 비서 카드가 그대로** 새 탭의 목록처럼 남았다. 몸이 JSON이 아니면 영어 구문 오류 글이 화면에 보였다.
 * 이제 실패면 목록을 비우고 정해 둔 한국어 안내를 보이며, 늦게 온 앞 응답은 버린다.
 */

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const src = read('src/components/chat/AgentSelector.tsx');
const load = src.slice(src.indexOf('const fetchAgents = useCallback'), src.indexOf('useEffect(() => { fetchAgents(activeTab); }'));

describe('비서 목록 읽기', () => {
  it('늦게 온 앞 탭 응답은 버린다', () => {
    expect(load).toContain('const seq = ++requestSeq.current;');
    expect(load).toContain('if (seq !== requestSeq.current) return;');
    expect(load).toContain('if (seq === requestSeq.current) setLoading(false);');
  });
  it('안내 글이 없어도 실패를 실패로 — 앞 목록을 비운다', () => {
    expect(load).not.toContain('throw new Error(result.error?.message)');
    expect(load).toContain('if (!res.ok || !result?.ok || !Array.isArray(result.data)) {');
    expect(load).toContain('setAgents([]);');
    expect(load).toContain('|| AGENT_LIST_UNREAD');
  });
  it('JSON이 아닌 몸의 구문 오류 글을 보이지 않는다', () => {
    expect(load).toContain('await res.json().catch(() => null)');
    expect(load).not.toContain('err instanceof Error ? err.message');
  });
  it('안내 문구', async () => {
    const { AGENT_LIST_UNREAD } = await import('@/components/chat/AgentSelector');
    expect(AGENT_LIST_UNREAD).toBe('비서 목록을 지금 불러오지 못했습니다. 잠시 뒤 다시 눌러 주세요.');
  });
});
