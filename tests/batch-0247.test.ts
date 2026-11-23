import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { emptyListText } from '@/lib/ok-json';

/**
 * 2026-11-21 — 관리자 설정 화면의 금지어 목록이 못 읽은 것을 '없음'으로 보이지 않는다.
 * 서버(`GET /api/forbidden-words`)는 읽기 실패를 503으로 답하는데, 화면은 오류 띠를 띄우면서 목록 자리에 '등록된 금지어가 없습니다'·
 * '금지어 목록 (0개)'를 보였다. 그 오류 띠는 조작마다 지워지는 칸이라, 금지어를 하나 더하면 띠가 사라지고 목록에 **새 금지어 하나만** 남았다 —
 * 관리자는 이미 걸어 둔 금지어가 없는 줄 알게 된다(필터에는 그대로 걸린다). 이제 못 읽음을 따로 기억해 늘 알리고 '다시 불러오기'를 둔다.
 */

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const src = read('src/components/admin/SettingsManager.tsx');
const load = src.slice(src.indexOf('const loadForbiddenWords = async'), src.indexOf('const loadSecurityLogs = async'));

describe('금지어 목록 읽기', () => {
  it('못 읽음을 조작 오류와 따로 기억한다', () => {
    expect(src).toContain('const [wordsUnread, setWordsUnread] = useState(false);');
    expect(load).toContain("fetchOkJson<{ data: unknown }>('/api/forbidden-words')");
    expect(load).toContain('setWordsUnread(true);');
    expect(load).toContain('setWordsUnread(false);');
    expect(load).not.toContain('setError(');
  });
  it('못 읽으면 늘 알리고 다시 불러올 수 있다', () => {
    expect(src).toContain('{wordsUnread && (');
    expect(src).toContain('{FORBIDDEN_WORDS_UNREAD}');
    expect(src).toContain('onClick={() => void loadForbiddenWords()}');
  });
  it('없다고 하지 않는다', () => {
    expect(src).toContain("금지어 목록 ({wordsUnread ? '읽지 못함' : `${forbiddenWords.length}개`})");
    expect(src).toContain("{emptyListText(wordsUnread, '등록된 금지어가 없습니다.', '금지어 목록을')}");
  });
  it('안내 문구', async () => {
    const { FORBIDDEN_WORDS_UNREAD } = await import('@/components/admin/SettingsManager');
    expect(FORBIDDEN_WORDS_UNREAD).toContain('이미 등록된 금지어가 이 목록에서 빠져 있을 수 있습니다');
    expect(emptyListText(true, '등록된 금지어가 없습니다.', '금지어 목록을')).toBe('금지어 목록을 지금 불러오지 못했습니다. 화면을 새로 고쳐 주세요.');
  });
});
