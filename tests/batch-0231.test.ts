import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

/**
 * 2026-11-20 — 관리자 문서 화면이 못 읽은 목록을 '없습니다'로 보이지 않는다.
 * 처음 읽기에서 문서 목록·비서 목록의 응답이 실패여도(503 — 공개 범위를 못 읽으면 문서 목록이 이렇게 답한다, 0229)
 * 화면은 아무것도 하지 않았다: '아직 업로드된 문서가 없습니다. 위에서 문서를 업로드하면 여기에 표시됩니다.',
 * 올릴 비서 고르기에는 '등록된 비서가 없습니다'. 관리자는 문서가 사라진 줄 알거나 같은 문서를 다시 올린다.
 * 이제 못 읽은 것을 따로 기억해 '지금 불러오지 못했습니다'로 보이고, 주기적 다시 읽기가 성공하면 풀린다.
 */

const src = readFileSync('src/components/admin/DocumentsManager.tsx', 'utf8').replace(/\r\n/g, '\n');
const load = src.slice(src.indexOf('const loadData = async () => {'), src.indexOf('const openAssignModal'));
const refresh = src.slice(src.indexOf('const refreshDocuments = useCallback'), src.indexOf('useEffect(() => {\n    loadData();'));

describe('문서 화면 (원본)', () => {
  it('처음 읽기 — 두 목록 모두 못 읽음을 기억한다', () => {
    expect(load).toContain("fetchOkJson<{ data: Agent[] }>('/api/agents')");
    expect(load).toContain("fetchOkJson<{ data: Document[] }>('/api/documents')");
    expect(load).toContain('setUnread({ documents: !docsResult, agents: !agentsResult });');
    expect(load).toContain('setLoading(false);');
  });

  it('늦게 온 응답은 여전히 버린다(요청 순번)', () => {
    expect(load).toContain('if (docsResult && seq === listSeqRef.current) applyDocuments(docsResult.data);');
  });

  it('다시 읽기가 성공하면 못 읽음이 풀린다, 실패하면 앞 목록을 그대로 둔다', () => {
    expect(refresh).toContain('if (result.ok) { applyDocuments(result.data); setUnread((u) => (u.documents ? { ...u, documents: false } : u)); }');
    expect(refresh).not.toContain('applyDocuments([])');
  });

  it('빈 자리에 없습니다라고 하지 않는다 — 올리라는 안내도 못 읽었을 때는 뺀다', () => {
    expect(src).toContain("{emptyListText(unread.documents, '아직 업로드된 문서가 없습니다.', '문서 목록을')}");
    expect(src).toContain('{!unread.documents && <div className="text-xs mt-1">위에서 문서를 업로드하면 여기에 표시됩니다.</div>}');
    expect(src).toContain("{emptyListText(unread.agents, '등록된 비서가 없습니다.', '비서 목록을')}");
  });
});
