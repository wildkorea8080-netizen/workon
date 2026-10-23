'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  UPLOAD_ACCEPT_ATTRIBUTE,
  UPLOAD_FORMATS_LABEL,
  MAX_UPLOAD_SIZE_LABEL,
} from '@/lib/file-types';
import type { Document, Agent } from '@/lib/db';
import { uploadReferenceDocument, startReading, type DocumentUploadStage } from '@/lib/document-upload-client';

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
  });
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [uploadStage, setUploadStage] = useState<DocumentUploadStage | null>(null);
  const [dragging, setDragging] = useState(false);
  // 비서 추가 모달
  const [assignModal, setAssignModal] = useState<Document | null>(null);
  const [assignIds, setAssignIds] = useState<string[]>([]);
  const [assigning, setAssigning] = useState(false);

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
      setUploadForm({ file: null, agentIds: [], title: '', visibility: 'organization' });
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
        <div className="space-y-3">
          {documents.map((doc) => (
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
                    </div>
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