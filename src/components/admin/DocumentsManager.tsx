'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  UPLOAD_ACCEPT_ATTRIBUTE,
  UPLOAD_FORMATS_LABEL,
  MAX_UPLOAD_SIZE_LABEL,
} from '@/lib/file-types';
import type { Document, Agent } from '@/lib/db';
import { uploadReferenceDocument, startReading, type DocumentUploadStage } from '@/lib/document-upload-client';
import { isInForce, kstToday } from '@/lib/edition-dates';
import EditionCompareModal, { compareEndpoint } from '@/components/admin/EditionCompareModal';
import { filterDocuments, normalizeDocumentTags, tagCounts, MAX_DOCUMENT_TAGS, type DocumentFilter, type DocumentStatusFilter } from '@/lib/document-tags';
import { mergeSuggestedTags } from '@/lib/document-tag-suggest';

/** 바꿀 옛 판 후보(0055) — 고른 비서 하나의 현재 판(지난 판·지우는 중 아님). 비서를 하나만 골랐을 때만 */
export function replaceCandidates(docs: Document[], agentIds: string[]): Document[] {
  if (agentIds.length !== 1) return [];
  return docs.filter((d) => d.agent_id === agentIds[0] && !d.retired_at && d.noda_status !== 'retired' && d.noda_status !== 'deleting');
}

/** 새 판 줄의 안내 — 옛 판을 이미 내렸는지, 읽히면 내릴지, 시행일을 기다리는지 */
export function editionNote(doc: Document, docs: Document[], today: string = kstToday()): string {
  const old = docs.find((d) => d.id === doc.replaces_id);
  const name = old ? old.title || old.file_name : '옛 판';
  if (old?.noda_status === 'retired') return `← ‘${name}’을(를) 대신합니다(옛 판은 지난 판).`;
  // 시행일 전 — 새 판이 읽혔어도 그날까지는 옛 판이 근거다(document-editions.ts notCitableEditionIds)
  if (!isInForce(doc.effective_from, today)) {
    return doc.noda_status === 'ready'
      ? `← ‘${name}’을(를) 대신할 새 판 — 시행일(${doc.effective_from})까지는 옛 판을 근거로 쓰고, 그날부터 새 판으로 바꿉니다.`
      : `← ‘${name}’을(를) 대신할 새 판 — 다 읽히면 시행일(${doc.effective_from})에 옛 판을 지난 판으로 내립니다.`;
  }
  if (doc.noda_status === 'ready') return `← ‘${name}’을(를) 대신합니다 — 옛 판을 내리는 중입니다(그동안에도 옛 판은 근거로 쓰지 않습니다).`;
  return `← ‘${name}’을(를) 대신할 새 판 — 다 읽히면 옛 판을 지난 판으로 내립니다.`;
}

/** 옛 판과 비교할 수 있는 새 판인가 — 바꾼 옛 판이 목록에 있어야 한다(옛 판 행을 지웠으면 replaces_id가 NULL) */
export function canCompareWithPrevious(doc: Document, docs: Document[]): boolean {
  return Boolean(doc.replaces_id) && docs.some((d) => d.id === doc.replaces_id);
}

/** 목록 응답은 오래 멈춘 읽는 중 행 하나에 kick: true를 달아 준다(서버는 응답 뒤 일을 이어 가지 못한다) */
type DocumentRow = Document & { kick?: boolean };

/** 읽는 중인 문서가 있으면 앞 응답을 받은 뒤 이만큼 쉬고 목록을 다시 부른다 */
const POLL_INTERVAL_MS = 5_000;

/** 읽기 상태 칩. ready·NULL(옛 문서)은 표시 없음 */
function ReadStatusChip({ doc }: { doc: DocumentRow }) {
  switch (doc.noda_status) {
    case 'reading':
      return <span className="text-xs px-2 py-0.5 rounded font-medium bg-blue-100 text-blue-800">읽는 중</span>;
    case 'failed':
      return (
        <span className="text-xs px-2 py-0.5 rounded font-medium bg-red-100 text-red-800">
          읽기 실패{doc.noda_reason ? ` — ${doc.noda_reason}` : ''}
        </span>
      );
    case 'unreadable':
      return (
        <span className="text-xs px-2 py-0.5 rounded font-medium bg-red-100 text-red-800">
          읽지 못함{doc.noda_reason ? ` — ${doc.noda_reason}` : ''}
        </span>
      );
    case 'deleting':
      return <span className="text-xs px-2 py-0.5 rounded font-medium bg-amber-100 text-amber-800">삭제 대기</span>;
    case 'retired':
      return <span className="text-xs px-2 py-0.5 rounded font-medium bg-slate-200 text-slate-700">지난 판 — 근거로 쓰지 않음</span>;
    default:
      return null;
  }
}

export default function DocumentsManager() {
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadForm, setUploadForm] = useState({
    file:     null as File | null,
    agentIds: [] as string[],
    title:    '',
    // 규정·매뉴얼 대부분은 전 직원 공통이라 기관 전체가 기본
    visibility: 'organization' as 'organization' | 'department',
    // 판(0055) — 개정본이면 바꿀 옛 판(비서 하나일 때만)·시행일
    replacesId: '',
    effectiveFrom: '',
  });
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [uploadStage, setUploadStage] = useState<DocumentUploadStage | null>(null);
  const [dragging, setDragging] = useState(false);
  // 비서 추가 모달
  const [assignModal, setAssignModal] = useState<Document | null>(null);
  const [assignIds, setAssignIds] = useState<string[]>([]);
  const [assigning, setAssigning] = useState(false);
  // 두 판 비교(신구 대비) — 새 판 id
  const [compareId, setCompareId] = useState<string | null>(null);
  // 목록 찾기·거르기와 태그 고치기(0060)
  const [filter, setFilter] = useState<DocumentFilter>({});
  const [tagEdit, setTagEdit] = useState<{ id: string; text: string; error: string | null; saving: boolean; suggesting?: boolean; note?: string | null } | null>(null);

  // 이 화면에서 이미 다시 걸어 본 문서 — 한 번만 건다
  const kickedRef = useRef<Set<string>>(new Set());
  // 목록 요청 순번. 늦게 온 옛 응답이 새 요청·'다시 시도'로 바꾼 화면을 덮지 않게 한다
  const listSeqRef = useRef(0);

  /** 목록 행에 kick이 있으면 그 문서의 읽기를 이 화면에서 한 번만 다시 건다 */
  const applyDocuments = useCallback((rows: DocumentRow[]) => {
    setDocuments(rows);
    for (const row of rows) {
      if (row.kick && !kickedRef.current.has(row.id)) {
        kickedRef.current.add(row.id);
        startReading([row.id]);
      }
    }
  }, []);

  /** 목록만 다시 부른다. 실패해도 조용히 넘어간다(다음 호출이 맞춘다). 더 새 요청이 나갔으면 이 응답은 버린다 */
  const refreshDocuments = useCallback(async () => {
    const seq = ++listSeqRef.current;
    try {
      const result = await (await fetch('/api/documents')).json();
      if (seq !== listSeqRef.current) return;
      if (result.ok) applyDocuments(result.data);
    } catch {
      // 다음 주기에 다시 부른다
    }
  }, [applyDocuments]);

  useEffect(() => {
    loadData();
  }, []);

  // 읽는 중인 문서가 있는 동안만 목록을 다시 부른다. 없으면 멈추고, 화면을 떠나도 멈춘다.
  // 앞 응답을 받은 뒤에 다음을 예약한다(setInterval이면 NODA가 느릴 때 요청이 겹쳐 쌓인다)
  const hasReading = documents.some((d) => d.noda_status === 'reading');
  useEffect(() => {
    if (!hasReading) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      await refreshDocuments();
      if (!stopped) timer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    timer = setTimeout(tick, POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [hasReading, refreshDocuments]);

  const loadData = async () => {
    const seq = ++listSeqRef.current;
    try {
      const [agentsResponse, docsResponse] = await Promise.all([
        fetch('/api/agents'),
        fetch('/api/documents'),
      ]);
      const [agentsResult, docsResult] = await Promise.all([
        agentsResponse.json(),
        docsResponse.json(),
      ]);
      if (agentsResult.ok) setAgents(agentsResult.data);
      if (docsResult.ok && seq === listSeqRef.current) applyDocuments(docsResult.data);
    } catch (err) {
      setErrorMessage('데이터 로드 중 오류가 발생했습니다.');
    } finally {
      setLoading(false);
    }
  };

  const openAssignModal = (doc: Document) => {
    setAssignModal(doc);
    setAssignIds([]);
  };

  const handleAssign = async () => {
    if (!assignModal || assignIds.length === 0) return;
    setAssigning(true);
    try {
      const res = await fetch('/api/documents/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId: assignModal.id, agentIds: assignIds }),
      });
      const result = await res.json();
      if (!result.ok) throw new Error(result.error?.message);
      setStatusMessage(`${result.data.added}개 비서에 문서가 추가됐습니다. 읽는 중입니다 — 다 읽으면 비서가 찾을 수 있습니다.`);
      setAssignModal(null);
      startReading(result.data.documentIds ?? []);
      loadData();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : '추가 중 오류가 발생했습니다.');
      setAssignModal(null);
    } finally {
      setAssigning(false);
    }
  };

  const handleDelete = async (documentId: string) => {
    if (!confirm('문서를 삭제하시겠습니까? 이 작업은 취소할 수 없습니다.')) return;
    try {
      const response = await fetch('/api/documents', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId }),
      });
      const result = await response.json();
      if (!result.ok) throw new Error(result.error?.message || '삭제 실패');
      listSeqRef.current++; // 지우기 전에 나간 목록 응답이 지운 행을 되살리지 않게
      setDocuments((prev) => prev.filter((d) => d.id !== documentId));
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : '삭제 중 오류가 발생했습니다.');
      // 보관소에서 못 지운 경우(502) 행이 '삭제 대기'로 바뀌었다 — 목록을 다시 불러 보인다
      refreshDocuments();
    }
  };

  /** 태그 저장 — 화면에서 먼저 다듬어 보고(서버가 다시 본다), 저장된 값으로 목록을 고친다 */
  const saveTags = async (documentId: string) => {
    if (!tagEdit || tagEdit.id !== documentId) return;
    const checked = normalizeDocumentTags(tagEdit.text);
    if (!checked.ok) { setTagEdit({ ...tagEdit, error: checked.message }); return; }
    setTagEdit({ ...tagEdit, saving: true, error: null });
    try {
      const res = await fetch(`/api/documents/${documentId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tags: checked.tags }) });
      const result = await res.json().catch(() => null);
      if (!result?.ok) { setTagEdit((t) => (t ? { ...t, saving: false, error: result?.error?.message ?? '태그를 저장하지 못했습니다.' } : t)); return; }
      setDocuments((prev) => prev.map((d) => (d.id === documentId ? { ...d, tags: result.data.tags as string[] } : d)));
      setTagEdit(null);
    } catch {
      setTagEdit((t) => (t ? { ...t, saving: false, error: '태그를 저장하지 못했습니다.' } : t));
    }
  };

  /** AI 태그 초안 — 제안을 편집 칸의 지금 태그 뒤에 잇는다(저장은 사람이 '저장'으로) */
  const suggestTags = async (documentId: string) => {
    if (!tagEdit || tagEdit.id !== documentId) return;
    setTagEdit({ ...tagEdit, suggesting: true, error: null, note: null });
    try {
      const res = await fetch(`/api/documents/${documentId}/tag-suggest`, { method: 'POST' });
      const result = await res.json().catch(() => null);
      setTagEdit((t) => {
        if (!t || t.id !== documentId) return t;
        if (!result?.ok) return { ...t, suggesting: false, error: result?.error?.message ?? '태그 초안을 만들지 못했습니다.' };
        const current = normalizeDocumentTags(t.text);
        const merged = mergeSuggestedTags(current.ok ? current.tags : [], result.data.suggestions as string[], MAX_DOCUMENT_TAGS);
        const fresh = (result.data.suggestions as string[]).length;
        return { ...t, suggesting: false, text: merged.join(', '), note: fresh ? 'AI가 제안한 태그를 더했습니다. 확인하고 고친 뒤 저장하세요.' : 'AI가 제안할 태그를 찾지 못했습니다.' };
      });
    } catch {
      setTagEdit((t) => (t ? { ...t, suggesting: false, error: '태그 초안을 만들지 못했습니다.' } : t));
    }
  };

  const handleRetry = (documentId: string) => {
    startReading([documentId], { retry: true });
    // 이미 나가 있는 목록 요청의 응답('읽기 실패')이 아래 표시를 덮지 않게 버린다
    listSeqRef.current++;
    // 서버가 읽는 중으로 바꾸기 전에 목록을 부르면 '읽기 실패'가 다시 보여 5초 맞추기가 시작되지 못한다.
    // 먼저 읽는 중으로 보이고, 5초마다 부르는 목록이 서버 상태에 맞춘다
    setDocuments((prev) =>
      prev.map((d) => (d.id === documentId ? { ...d, noda_status: 'reading' as const, noda_reason: null } : d))
    );
  };

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatusMessage('');
    setErrorMessage('');

    if (!uploadForm.file) {
      setErrorMessage('파일을 선택해주세요.');
      return;
    }

    if (uploadForm.agentIds.length === 0) {
      setErrorMessage('비서를 하나 이상 선택해주세요.');
      return;
    }

    setUploading(true);
    setUploadStage('uploading');
    try {
      const result = await uploadReferenceDocument(
        uploadForm.file,
        {
          agentIds: uploadForm.agentIds,
          title: uploadForm.title.trim() || undefined,
          visibility: uploadForm.visibility,
          replacesId: uploadForm.agentIds.length === 1 ? uploadForm.replacesId || undefined : undefined,
          effectiveFrom: uploadForm.effectiveFrom || undefined,
        },
        setUploadStage
      );
      if (!result.ok) {
        setErrorMessage(result.message);
        return;
      }

      // 읽기는 기다리지 않고 건다 — 목록이 '읽는 중'을 보여 주고 다 읽으면 바뀐다
      startReading(result.documentIds);
      setStatusMessage('문서를 올렸습니다. 읽는 중입니다 — 다 읽으면 비서가 찾을 수 있습니다.');
      setUploadForm({ file: null, agentIds: [], title: '', visibility: 'organization', replacesId: '', effectiveFrom: '' });
      loadData();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : '업로드 중 오류가 발생했습니다.');
    } finally {
      setUploading(false);
      setUploadStage(null);
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-slate-600"></div>
        <span className="ml-3 text-slate-600">로딩 중...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Upload Form */}
      <div className="p-6 border rounded-lg bg-white shadow-sm">
        <h2 className="text-xl font-semibold mb-4">문서 업로드</h2>

        {statusMessage && (
          <div className="p-4 text-green-700 bg-green-100 rounded-lg mb-4 flex items-center space-x-2">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            <span>{statusMessage}</span>
          </div>
        )}
        {errorMessage && (
          <div className="p-4 text-red-700 bg-red-100 rounded-lg mb-4 flex items-center space-x-2">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>{errorMessage}</span>
          </div>
        )}

        <form onSubmit={handleUpload} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">
              비서 선택 * <span className="text-xs text-slate-400 font-normal">(복수 선택 가능)</span>
            </label>
            <div className="border border-slate-300 rounded-md max-h-48 overflow-y-auto divide-y divide-slate-100">
              {agents.length === 0 ? (
                <p className="px-3 py-2 text-sm text-slate-400">등록된 비서가 없습니다.</p>
              ) : agents.map((agent) => {
                const checked = uploadForm.agentIds.includes(agent.id);
                return (
                  <label key={agent.id}
                    className={`flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-slate-50 transition-colors ${checked ? 'bg-blue-50' : ''}`}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        setUploadForm(prev => ({
                          ...prev,
                          agentIds: checked
                            ? prev.agentIds.filter(id => id !== agent.id)
                            : [...prev.agentIds, agent.id],
                        }));
                      }}
                      className="rounded accent-slate-900 w-4 h-4 flex-shrink-0"
                    />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-800 truncate">{agent.name}</p>
                      {agent.description && (
                        <p className="text-xs text-slate-400 truncate">{agent.description}</p>
                      )}
                    </div>
                  </label>
                );
              })}
            </div>
            {/* 선택한 비서를 이름으로 보여준다.
                목록이 스크롤 영역이라 고른 항목이 화면 밖으로 나가는데,
                숫자만 보여주면 무엇을 골랐는지 확인할 방법이 없다.
                문서가 엉뚱한 비서에 붙으면 그 비서만 그 자료를 참고하게 된다. */}
            <div className="mt-2">
              {uploadForm.agentIds.length === 0 ? (
                <p className="text-xs text-slate-400">
                  선택된 비서가 없습니다. 이 문서를 참고할 비서를 골라주세요.
                </p>
              ) : (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-slate-500">선택됨</span>
                  {uploadForm.agentIds.map((id) => {
                    const agent = agents.find((a) => a.id === id);
                    return (
                      <span
                        key={id}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 text-xs"
                      >
                        {agent?.name ?? '(삭제된 비서)'}
                        <button
                          type="button"
                          onClick={() =>
                            setUploadForm((prev) => ({
                              ...prev,
                              agentIds: prev.agentIds.filter((x) => x !== id),
                            }))
                          }
                          className="text-blue-400 hover:text-blue-700 leading-none"
                          aria-label={`${agent?.name ?? ''} 선택 해제`}
                        >
                          ×
                        </button>
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* 판(0055) — 개정본을 올릴 때. 새 판이 읽히면 옛 판은 지난 판이 되어 근거로 쓰지 않는다 */}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm font-medium text-slate-700">바꿀 옛 판 (개정본일 때)
              <select
                aria-label="바꿀 옛 판"
                value={uploadForm.agentIds.length === 1 ? uploadForm.replacesId : ''}
                disabled={uploadForm.agentIds.length !== 1}
                onChange={(e) => setUploadForm((prev) => ({ ...prev, replacesId: e.target.value }))}
                className="mt-1 w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-normal disabled:bg-slate-50"
              >
                <option value="">없음(새 문서)</option>
                {replaceCandidates(documents, uploadForm.agentIds).map((d) => <option key={d.id} value={d.id}>{d.title || d.file_name}</option>)}
              </select>
              <span className="mt-1 block text-xs font-normal text-slate-500">{uploadForm.agentIds.length === 1 ? '새 판이 읽힌 뒤에 옛 판을 지난 판으로 내립니다(읽기에 실패하면 옛 판을 계속 씁니다).' : '비서를 하나만 고르면 고를 수 있습니다.'}</span>
            </label>
            <label className="block text-sm font-medium text-slate-700">시행일 (선택)
              <input
                type="date"
                aria-label="시행일"
                value={uploadForm.effectiveFrom}
                onChange={(e) => setUploadForm((prev) => ({ ...prev, effectiveFrom: e.target.value }))}
                className="mt-1 w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-normal"
              />
              <span className="mt-1 block text-xs font-normal text-slate-500">바꿀 옛 판을 고르고 시행일을 오늘 뒤로 적으면, 그날까지는 옛 판을 근거로 쓰고 시행일부터 새 판으로 바꿉니다. 그 밖에는 목록과 근거 창에 표시합니다.</span>
            </label>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">문서 제목 (선택사항)</label>
            <input
              type="text"
              value={uploadForm.title}
              onChange={(e) => setUploadForm(prev => ({ ...prev, title: e.target.value }))}
              className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-500 focus:border-slate-500"
              placeholder="문서 제목을 입력하세요"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">공개 범위</label>
            <div className="space-y-2 p-3 border border-slate-200 rounded-md">
              {([
                ['organization', '기관 전체', '이 기관의 모든 직원이 검색·참고합니다 (복무규정, 공통 매뉴얼 등)'],
                ['department', '내 부서로 제한', '내 부서와 하위 부서만 참고합니다 (인사·감사·법무 자료 등)'],
              ] as ['organization' | 'department', string, string][]).map(([value, label, hint]) => (
                <label key={value} className="flex items-start gap-2.5 cursor-pointer">
                  <input
                    type="radio"
                    name="doc-visibility"
                    checked={uploadForm.visibility === value}
                    onChange={() => setUploadForm(prev => ({ ...prev, visibility: value }))}
                    className="mt-0.5 w-4 h-4 border-slate-300 text-[#003087] focus:ring-[#003087]"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm text-slate-800">{label}</span>
                    <span className="block text-xs text-slate-400">{hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">파일 선택 *</label>
            {uploadForm.file ? (
              <div className="p-4 border-2 border-dashed border-blue-300 bg-blue-50 rounded-md">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-3">
                    <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    <div>
                      <p className="font-medium text-blue-900">{uploadForm.file.name}</p>
                      <p className="text-sm text-blue-700">{formatFileSize(uploadForm.file.size)}</p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setUploadForm(prev => ({ ...prev, file: null }))}
                    className="text-blue-600 hover:text-blue-800"
                  >
                    변경
                  </button>
                </div>
              </div>
            ) : (
              <div>
                <label
                  className={`w-full p-8 border-2 border-dashed rounded-md cursor-pointer transition-colors flex items-center justify-center ${
                    dragging ? 'border-blue-400 bg-blue-50' : 'border-slate-300 hover:border-slate-400'
                  }`}
                  onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragging(false);
                    const dropped = e.dataTransfer.files[0];
                    if (dropped) setUploadForm(prev => ({ ...prev, file: dropped }));
                  }}
                >
                  <div className="text-center pointer-events-none">
                    <svg className="w-10 h-10 mx-auto mb-2 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3v-6" />
                    </svg>
                    <p className="font-medium text-slate-700">
                      {dragging ? '파일을 놓으세요' : '클릭 또는 드래그앤드롭'}
                    </p>
                    <p className="text-xs text-slate-500 mt-1">
                      {UPLOAD_FORMATS_LABEL} (최대 {MAX_UPLOAD_SIZE_LABEL})                    </p>
                    {/* 검색은 문서 전체가 아니라 **청크(문단) 단위**로 걸린다.
                        그래서 질문에 쓰일 만한 표현이 문서 안에 있어야 찾아온다.
                        규정 원문만 올리면 "출장비 얼마예요" 같은 실제 질문과
                        말이 달라 놓치는 일이 잦다. */}
                    <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                      자주 묻는 내용은 <span className="text-slate-600 font-medium">질문/답변 형식</span>으로
                      정리해 함께 올리면 훨씬 잘 찾습니다.
                      <br />
                      예) Q. 출장 여비 규정 / A. 임원 이상 100,000원, 그 외 70,000원
                    </p>
                  </div>
                  <input
                    type="file"
                    accept={UPLOAD_ACCEPT_ATTRIBUTE}
                    onChange={(e) => setUploadForm(prev => ({ ...prev, file: e.target.files?.[0] || null }))}
                    className="hidden"
                  />
                </label>
              </div>
            )}
          </div>

          {uploading && (
            <p className="text-sm text-slate-600">
              {uploadStage === 'registering' ? '문서를 등록하는 중...' : '파일을 올리는 중...'}
            </p>
          )}

          <button
            type="submit"
            // 비서나 파일이 없으면 누를 수 없게 한다. 눌린 뒤 오류를 내면
            // 무엇이 빠졌는지 한 번 더 찾아야 한다.
            disabled={uploading || uploadForm.agentIds.length === 0 || !uploadForm.file}
            className="w-full px-4 py-2 bg-slate-900 text-white rounded-md hover:bg-slate-800 disabled:bg-slate-400 disabled:cursor-not-allowed flex items-center justify-center space-x-2 transition-colors"
          >
            {uploading ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                <span>업로드 중...</span>
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3v-6" />
                </svg>
                <span>문서 업로드</span>
              </>
            )}
          </button>
        </form>
      </div>

      {/* Documents List */}
      <div>
        <h2 className="text-xl font-semibold mb-4">업로드된 문서</h2>
        {documents.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm" aria-label="문서 찾기">
            <input
              aria-label="문서 이름·태그 찾기"
              value={filter.q ?? ''}
              onChange={(e) => setFilter((f) => ({ ...f, q: e.target.value }))}
              placeholder="이름·태그로 찾기"
              className="min-w-[12rem] flex-1 rounded-md border border-slate-300 px-3 py-1.5"
            />
            <select aria-label="비서로 거르기" value={filter.agentId ?? ''} onChange={(e) => setFilter((f) => ({ ...f, agentId: e.target.value || undefined }))} className="rounded-md border border-slate-300 px-2 py-1.5">
              <option value="">모든 비서</option>
              {agents.filter((a) => documents.some((d) => d.agent_id === a.id)).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <select aria-label="상태로 거르기" value={filter.status ?? ''} onChange={(e) => setFilter((f) => ({ ...f, status: e.target.value as DocumentStatusFilter }))} className="rounded-md border border-slate-300 px-2 py-1.5">
              <option value="">모든 상태</option>
              <option value="ready">읽음(현재 판)</option>
              <option value="reading">읽는 중</option>
              <option value="problem">실패·못 읽음·삭제 대기</option>
              <option value="retired">지난 판</option>
            </select>
            <select aria-label="태그로 거르기" value={filter.tag ?? ''} onChange={(e) => setFilter((f) => ({ ...f, tag: e.target.value || undefined }))} className="rounded-md border border-slate-300 px-2 py-1.5">
              <option value="">모든 태그</option>
              {tagCounts(documents).map((t) => <option key={t.tag} value={t.tag}>{t.tag} ({t.count})</option>)}
            </select>
            {(filter.q || filter.agentId || filter.status || filter.tag) && (
              <button type="button" onClick={() => setFilter({})} className="text-xs text-slate-500 underline">조건 지우기</button>
            )}
            <span className="text-xs text-slate-500">{filterDocuments(documents, filter).length}/{documents.length}개</span>
          </div>
        )}
        <div className="space-y-3">
          {filterDocuments(documents, filter).map((doc) => (
            <div key={doc.id} className="p-4 border rounded-lg bg-white hover:shadow-sm transition-shadow">
              <div className="flex justify-between items-start">
                <div className="flex items-start space-x-4 flex-1">
                  <div className="w-10 h-10 bg-slate-100 rounded-lg flex items-center justify-center flex-shrink-0">
                    <svg className="w-5 h-5 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="font-medium text-slate-900 truncate">{doc.title || doc.file_name}</h3>
                    <div className="flex flex-wrap items-center gap-3 mt-1">
                      <span className="text-xs text-slate-500">{doc.file_type}</span>
                      <span className="text-xs text-slate-500">•</span>
                      <span className="text-xs text-slate-500">{new Date(doc.created_at).toLocaleDateString('ko-KR')}</span>
                      <span className="text-xs text-slate-500">•</span>
                      <span className={`text-xs px-2 py-0.5 rounded font-medium ${
                        doc.agent_id
                          ? 'bg-green-100 text-green-800'
                          : 'bg-amber-100 text-amber-800'
                      }`}>
                        {doc.agent_id
                          ? `🤖 ${agents.find(a => a.id === doc.agent_id)?.name ?? '에이전트 연결'}`
                          : '미연결'}
                      </span>
                      <ReadStatusChip doc={doc} />
                      {doc.effective_from && <span className="text-xs text-slate-500">시행 {doc.effective_from}</span>}
                    </div>
                    {doc.replaces_id && <p className="mt-1 text-xs text-slate-500">{editionNote(doc, documents)}</p>}
                    {(doc.tags?.length ?? 0) > 0 && tagEdit?.id !== doc.id && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {doc.tags!.map((t) => (
                          <button key={t} type="button" onClick={() => setFilter((f) => ({ ...f, tag: t }))} className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700 hover:bg-slate-200" title="이 태그로 거르기">#{t}</button>
                        ))}
                      </div>
                    )}
                    {tagEdit?.id === doc.id && (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <input
                          aria-label="태그(쉼표로 구분)"
                          value={tagEdit.text}
                          onChange={(e) => setTagEdit({ ...tagEdit, text: e.target.value, error: null })}
                          placeholder="예: 여비, 복무, 2026 개정"
                          className="min-w-[14rem] flex-1 rounded-md border border-slate-300 px-2 py-1 text-xs"
                        />
                        <button type="button" disabled={tagEdit.saving} onClick={() => void saveTags(doc.id)} className="rounded-md bg-slate-900 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40">저장</button>
                        <button type="button" disabled={tagEdit.saving || tagEdit.suggesting} onClick={() => void suggestTags(doc.id)} className="rounded-md border border-slate-300 px-2.5 py-1 text-xs text-slate-700 disabled:opacity-40" title="AI가 문서 앞부분을 읽고 태그를 제안합니다(저장은 직접) — AI 사용량이 기록됩니다">{tagEdit.suggesting ? '초안 만드는 중…' : 'AI 초안'}</button>
                        <button type="button" onClick={() => setTagEdit(null)} className="text-xs text-slate-500 underline">취소</button>
                        {tagEdit.note && <p role="status" className="w-full text-xs text-slate-500">{tagEdit.note}</p>}
                        {tagEdit.error && <p role="alert" className="w-full text-xs text-red-600">{tagEdit.error}</p>}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1 ml-4 flex-shrink-0">
                  {doc.noda_status === 'failed' && (
                    <button
                      onClick={() => handleRetry(doc.id)}
                      className="px-2.5 py-1.5 text-xs font-medium bg-red-50 text-red-700 hover:bg-red-100 rounded-md transition-colors"
                      title="문서 읽기를 다시 시도"
                    >
                      다시 시도
                    </button>
                  )}
                  {canCompareWithPrevious(doc, documents) && (
                    <button
                      onClick={() => setCompareId(doc.id)}
                      className="px-2.5 py-1.5 text-xs font-medium bg-slate-100 text-slate-700 hover:bg-slate-200 rounded-md transition-colors"
                      title="바꾼 옛 판과 글을 맞대어 바뀐 곳을 봅니다"
                    >
                      옛 판과 비교
                    </button>
                  )}
                  <button
                    onClick={() => setTagEdit({ id: doc.id, text: (doc.tags ?? []).join(', '), error: null, saving: false })}
                    className="px-2.5 py-1.5 text-xs font-medium bg-slate-50 text-slate-600 hover:bg-slate-100 rounded-md transition-colors"
                    title="검색·거르기에 쓸 태그를 붙입니다"
                  >
                    태그
                  </button>
                  <button
                    onClick={() => openAssignModal(doc)}
                    className="px-2.5 py-1.5 text-xs font-medium bg-blue-50 text-blue-700 hover:bg-blue-100 rounded-md transition-colors"
                    title="다른 비서에 추가 연결"
                  >
                    + 비서 추가
                  </button>
                  <button
                  onClick={() => handleDelete(doc.id)}
                  className="p-2 text-slate-400 hover:text-red-600 transition-colors"
                  title="문서 삭제"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
                </div>
              </div>
            </div>
          ))}

          {documents.length > 0 && filterDocuments(documents, filter).length === 0 && (
            <p className="py-6 text-center text-sm text-slate-500">조건에 맞는 문서가 없습니다.</p>
          )}
          {documents.length === 0 && (
            <div className="text-center py-12 text-slate-500 border rounded-lg bg-slate-50">
              <svg className="w-12 h-12 mx-auto mb-4 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <div className="text-sm">아직 업로드된 문서가 없습니다.</div>
              <div className="text-xs mt-1">위에서 문서를 업로드하면 여기에 표시됩니다.</div>
            </div>
          )}
        </div>
      </div>

      {compareId && <EditionCompareModal endpoint={compareEndpoint('documents', compareId)} onClose={() => setCompareId(null)} />}

      {/* 비서 추가 모달 */}
      {assignModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4"
          onClick={() => setAssignModal(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6 space-y-4"
            onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-bold text-slate-900">비서 추가 연결</h3>
            <p className="text-xs text-slate-500 bg-slate-50 rounded-lg px-3 py-2 truncate">
              📄 {assignModal.title || assignModal.file_name}
            </p>
            <div className="border border-slate-200 rounded-xl max-h-52 overflow-y-auto divide-y divide-slate-100">
              {agents
                .filter(a => a.id !== assignModal.agent_id)
                .map(agent => {
                  const checked = assignIds.includes(agent.id);
                  return (
                    <label key={agent.id}
                      className={`flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-slate-50 transition-colors ${checked ? 'bg-blue-50' : ''}`}>
                      <input type="checkbox" checked={checked}
                        onChange={() => setAssignIds(prev =>
                          checked ? prev.filter(id => id !== agent.id) : [...prev, agent.id]
                        )}
                        className="rounded accent-slate-900 w-4 h-4 flex-shrink-0" />
                      <span className="text-sm text-slate-800">{agent.name}</span>
                    </label>
                  );
                })}
            </div>
            {assignIds.length > 0 && (
              <p className="text-xs text-blue-600">{assignIds.length}개 비서 선택됨</p>
            )}
            {errorMessage && (
              <p className="text-xs text-red-600">{errorMessage}</p>
            )}
            <div className="flex gap-3 pt-1">
              <button onClick={() => setAssignModal(null)}
                className="flex-1 py-2.5 border border-slate-200 rounded-xl text-sm text-slate-600 hover:bg-slate-50">
                취소
              </button>
              <button onClick={handleAssign}
                disabled={assigning || assignIds.length === 0}
                className="flex-1 py-2.5 bg-slate-900 hover:bg-slate-800 disabled:bg-slate-300 text-white font-semibold rounded-xl text-sm transition-colors">
                {assigning ? '추가 중...' : '추가'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}