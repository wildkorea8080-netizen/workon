import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { documentStatusLabel } from '@/components/agents/DocumentsPanel';

/** 비서 편집 창의 '문서' 탭(2026-11-06) — 주인이 자기 비서의 참고 문서가 읽혔는지 보고, 다시 시도·지우기·더 올리기 */
const read = (p: string) => readFileSync(p, 'utf8');

describe('문서 읽기 상태 표시', () => {
  it('상태마다 직원이 알아들을 말로', () => {
    expect(documentStatusLabel({ noda_status: 'ready', noda_reason: null })).toEqual({ text: '읽음 — 대화에서 근거로 씀', tone: 'ok' });
    expect(documentStatusLabel({ noda_status: 'reading', noda_reason: null }).text).toBe('읽는 중');
    expect(documentStatusLabel({ noda_status: 'failed', noda_reason: '문서 보관 한도를 넘어 읽지 못했습니다.' }).text).toBe('읽기 실패 — 문서 보관 한도를 넘어 읽지 못했습니다.');
    expect(documentStatusLabel({ noda_status: 'unreadable', noda_reason: null })).toEqual({ text: '읽지 못함', tone: 'bad' });
    expect(documentStatusLabel({ noda_status: 'deleting', noda_reason: null }).tone).toBe('bad');
    expect(documentStatusLabel({ noda_status: 'retired', noda_reason: null }).tone).toBe('muted');
    expect(documentStatusLabel({ noda_status: null, noda_reason: null }).text).toContain('옮기기 전');
  });
});

describe('문서 탭 연결', () => {
  it('목록 API — agent_id는 uuid만, 보이는 범위를 건 뒤에 좁힌다', () => {
    const route = read('src/app/api/documents/route.ts');
    expect(route).toContain("const agentParam = request.nextUrl.searchParams.get('agent_id');");
    expect(route).toContain('if (agentParam !== null && !UUID_RE.test(agentParam))');
    const or = route.indexOf('.or(visibleFilter);');
    const eq = route.indexOf("if (agentParam) query = query.eq('agent_id', agentParam.toLowerCase());");
    expect(or).toBeGreaterThan(0);
    expect(eq).toBeGreaterThan(or);
  });

  it('탭 — 이 비서의 문서만 부르고, 다시 시도는 읽기 라우트, 지우기는 삭제 라우트(권한은 서버가)', () => {
    const panel = read('src/components/agents/DocumentsPanel.tsx');
    expect(panel).toContain('/api/documents?agent_id=${encodeURIComponent(agentId)}');
    expect(panel).toContain('startReading([id], { retry: true });');
    expect(panel).toContain("body: JSON.stringify({ documentId: doc.id })");
    expect(panel).toContain('uploadReferenceDocument(file, { agentIds: [agentId] })');
    // 읽는 중일 때만 앞 응답 뒤에 다시 부르고 늦은 옛 응답은 버린다, 멈춘 행은 한 번만 다시 건다
    expect(panel).toContain('if (!hasReading) return;');
    expect(panel).toContain('if (seq !== seqRef.current) return;');
    expect(panel).toContain('if (r.kick && !kickedRef.current.has(r.id))');
    expect(panel).not.toContain('setInterval');
  });

  it('편집 창 — 링크형이 아닌 비서에만 문서 탭, 문서 찾기가 꺼졌으면 안내', () => {
    const modal = read('src/components/agents/AgentEditorModal.tsx');
    expect(modal).toContain("...(isLink ? [] : [['documents', '문서'], ['templates', '양식']]),");
    expect(modal).toContain("docSearchOn={Boolean(agent.capabilities && 'doc_search' in agent.capabilities)}");
    expect(read('src/components/agents/DocumentsPanel.tsx')).toContain('{!docSearchOn && (');
  });
});
