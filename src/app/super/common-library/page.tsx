'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { ORG_TYPES, type OrgType } from '@/lib/org-types';
import { UPLOAD_ACCEPT_ATTRIBUTE, UPLOAD_FORMATS_LABEL, MAX_UPLOAD_SIZE_LABEL } from '@/lib/file-types';
import { uploadCommonDocument, startCommonReading, type CommonUploadStage } from '@/lib/common-upload-client';

/** 목록 행(`GET /api/super/common-documents`). 저장소 경로·NODA 파일 이름은 서버가 떼고 보낸다 */
interface CommonRow {
  id: string;
  org_type: OrgType;
  title: string;
  edition_year: number;
  usage_terms: string;
  file_name: string;
  size_bytes: number | null;
  noda_status: 'reading' | 'ready' | 'failed' | 'unreadable' | 'deleting' | 'retired' | null;
  noda_reason: string | null;
  retired_at: string | null;
  created_at: string;
  /** 오래 멈춘 읽는 중 행 하나에 서버가 달아 준다 — 화면이 그 id로 읽기를 다시 건다 */
  kick?: boolean;
}

/** 읽는 중인 문서가 있으면 앞 응답을 받은 뒤 이만큼 쉬고 목록을 다시 부른다 */
const POLL_INTERVAL_MS = 5_000;
const BASE = '/api/super/common-documents';
const FAILED_HINT = '읽지 못한 판은 지운 뒤 다시 올리세요 — 같은 이름의 판이 남아 있으면 새로 올릴 수 없습니다.';
const CHIP = 'text-xs px-2 py-0.5 rounded font-medium';

function StatusChip({ row }: { row: CommonRow }) {
  if (row.retired_at || row.noda_status === 'retired') {
    return <span className={`${CHIP} bg-slate-700 text-slate-300`}>지난 판</span>;
  }
  switch (row.noda_status) {
    case 'reading':
      return <span className={`${CHIP} bg-blue-900/50 text-blue-300`}>읽는 중</span>;
    case 'ready':
      return <span className={`${CHIP} bg-emerald-900/40 text-emerald-400`}>읽음</span>;
    case 'failed':
      return (
        <span className={`${CHIP} bg-red-900/40 text-red-400`}>
          읽기 실패{row.noda_reason ? ` — ${row.noda_reason}` : ''}
        </span>
      );
    case 'unreadable':
      return (
        <span className={`${CHIP} bg-red-900/40 text-red-400`}>
          읽을 수 없음{row.noda_reason ? ` — ${row.noda_reason}` : ''}
        </span>
      );
    case 'deleting':
      return <span className={`${CHIP} bg-amber-900/40 text-amber-400`}>지우는 중</span>;
    default:
      return null;
  }
}

function formatSize(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
}

const EMPTY_FORM = { file: null as File | null, title: '', year: String(new Date().getFullYear()), usageTerms: '', replacesId: '' };

export default function CommonLibraryPage() {
  const [orgType, setOrgType] = useState<OrgType>(ORG_TYPES[0]);
  const [rows, setRows] = useState<CommonRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showRetired, setShowRetired] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [fileKey, setFileKey] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [stage, setStage] = useState<CommonUploadStage | null>(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  // 이 화면에서 이미 다시 걸어 본 문서 — 한 번만 건다
  const kickedRef = useRef<Set<string>>(new Set());
  // 목록 요청 순번. 늦게 온 옛 응답이 새 요청·탭 바꿈·'다시 시도'로 바꾼 화면을 덮지 않게 한다
  const listSeqRef = useRef(0);

  const applyRows = useCallback((next: CommonRow[]) => {
    setRows(next);
    for (const row of next) {
      if (row.kick && !kickedRef.current.has(row.id)) {
        kickedRef.current.add(row.id);
        startCommonReading([row.id]);
      }
    }
  }, []);

  /** 목록만 다시 부른다. 실패해도 조용히 넘어간다(다음 호출이 맞춘다). 더 새 요청이 나갔으면 이 응답은 버린다 */
  const refreshDocuments = useCallback(async () => {
    const seq = ++listSeqRef.current;
    try {
      const result = await (await fetch(`${BASE}?org_type=${encodeURIComponent(orgType)}`)).json();
      if (seq !== listSeqRef.current) return;
      if (result.ok) {
        applyRows(result.data);
        setLoading(false); // 처음 불러오기를 대신한 응답이면 '불러오는 중'을 끝낸다
      }
    } catch {
      // 다음 주기에 다시 부른다
    }
  }, [orgType, applyRows]);

  // 탭을 바꾸면 그 유형의 목록을 새로 부른다. 나가 있던 앞 탭의 응답은 순번으로 버린다
  useEffect(() => {
    const seq = ++listSeqRef.current;
    setLoading(true);
    setRows([]);
    setForm((f) => ({ ...f, replacesId: '' }));
    (async () => {
      try {
        const result = await (await fetch(`${BASE}?org_type=${encodeURIComponent(orgType)}`)).json();
        if (seq !== listSeqRef.current) return;
        if (result.ok) applyRows(result.data);
        else setErrorMessage(result.error?.message || '문서 목록을 불러오지 못했습니다.');
      } catch {
        if (seq === listSeqRef.current) setErrorMessage('문서 목록을 불러오지 못했습니다.');
      } finally {
        if (seq === listSeqRef.current) setLoading(false);
      }
    })();
  }, [orgType, applyRows]);

  // 읽는 중인 문서가 있는 동안만 목록을 다시 부른다. 없으면 멈추고, 화면을 떠나도 멈춘다.
  // 앞 응답을 받은 뒤에 다음을 예약한다(setInterval이면 NODA가 느릴 때 요청이 겹쳐 쌓인다)
  const hasReading = rows.some((r) => r.noda_status === 'reading');
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

  const current = rows.filter((r) => !r.retired_at);
  const retired = rows.filter((r) => r.retired_at);
  // 바꿀 옛 판 후보: 이 유형의 현재 판(지우는 중인 것은 서버가 거절한다)
  const replaceCandidates = current.filter((r) => r.noda_status !== 'deleting');

  const handleRetry = (id: string) => {
    startCommonReading([id], { retry: true });
    // 이미 나가 있는 목록 요청의 응답('읽기 실패')이 아래 표시를 덮지 않게 버린다
    listSeqRef.current++;
    // 서버가 읽는 중으로 바꾸기 전에 목록을 부르면 '읽기 실패'가 다시 보여 5초 맞추기가 시작되지 못한다.
    // 먼저 읽는 중으로 보이고, 5초마다 부르는 목록이 서버 상태에 맞춘다
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, noda_status: 'reading' as const, noda_reason: null } : r)));
  };

  const handleDelete = async (row: CommonRow) => {
    if (!confirm(`'${row.title}(${row.edition_year})'을(를) 지우시겠습니까? 이 작업은 취소할 수 없습니다.`)) return;
    setErrorMessage('');
    try {
      const res = await fetch(`${BASE}/${row.id}`, { method: 'DELETE' });
      const result = await res.json().catch(() => null);
      if (!res.ok || !result?.ok) throw new Error(result?.error?.message || '삭제하지 못했습니다.');
      listSeqRef.current++; // 지우기 전에 나간 목록 응답이 지운 행을 되살리지 않게
      setRows((prev) => prev.filter((r) => r.id !== row.id));
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : '삭제 중 오류가 발생했습니다.');
      // 보관소에서 못 지운 경우(502) 행이 '지우는 중'으로 바뀌었다 — 목록을 다시 불러 보인다
      refreshDocuments();
    }
  };

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatusMessage('');
    setErrorMessage('');

    if (!form.file) return setErrorMessage('파일을 선택해 주세요.');
    if (!form.title.trim()) return setErrorMessage('문서 이름을 입력해 주세요.');
    const year = Number(form.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      return setErrorMessage('기준 연도는 2000~2100 사이의 정수여야 합니다.');
    }
    if (!form.usageTerms.trim()) return setErrorMessage('이용 조건 확인 내용을 입력해 주세요.');

    setUploading(true);
    setStage('uploading');
    try {
      const result = await uploadCommonDocument(
        form.file,
        {
          org_type: orgType,
          title: form.title.trim(),
          edition_year: year,
          usage_terms: form.usageTerms.trim(),
          replaces_id: form.replacesId || undefined,
        },
        setStage
      );
      if (!result.ok) return setErrorMessage(result.message);
      setStatusMessage(
        form.replacesId
          ? '문서를 올렸습니다. 읽는 중입니다 — 다 읽으면 옛 판이 지난 판으로 바뀝니다.'
          : '문서를 올렸습니다. 읽는 중입니다 — 다 읽으면 비서가 찾을 수 있습니다.'
      );
      setForm({ ...EMPTY_FORM, year: form.year });
      setFileKey((k) => k + 1);
      await refreshDocuments();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : '업로드 중 오류가 발생했습니다.');
    } finally {
      setUploading(false);
      setStage(null);
    }
  };

  const inputCls =
    'w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-[#7C3AED]';

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h1 className="text-xl font-bold text-white">공통 자료실</h1>
        <p className="text-sm text-slate-400 mt-1">
          기관 유형별로 모든 기관의 문서 찾기 비서가 함께 참고하는 자료입니다. 올리기 전에 이용 조건(공공누리 등)을 확인해 기록하세요.
        </p>
      </div>

      {/* 유형 탭 */}
      <div className="flex flex-wrap gap-2">
        {ORG_TYPES.map((t) => (
          <button
            key={t}
            onClick={() => setOrgType(t)}
            className={`px-3.5 py-2 rounded-xl text-sm font-medium transition-colors ${
              t === orgType ? 'bg-[#7C3AED] text-white' : 'bg-slate-800 text-slate-400 hover:text-white hover:bg-slate-700'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {errorMessage && (
        <div className="px-4 py-3 rounded-lg bg-red-900/30 border border-red-800/50 text-sm text-red-300">{errorMessage}</div>
      )}
      {statusMessage && (
        <div className="px-4 py-3 rounded-lg bg-emerald-900/30 border border-emerald-800/50 text-sm text-emerald-300">
          {statusMessage}
        </div>
      )}

      {/* 현재 판 */}
      <section className="bg-[#1E293B] border border-slate-700/50 rounded-2xl overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-700/50 text-sm font-semibold text-white">
          {orgType} — 현재 판 <span className="text-slate-500 font-normal">({current.length})</span>
        </div>
        {loading ? (
          <p className="px-5 py-8 text-sm text-slate-500">불러오는 중...</p>
        ) : current.length === 0 ? (
          <p className="px-5 py-8 text-sm text-slate-500">올린 문서가 없습니다.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-slate-700/50">
                <th className="px-5 py-2 font-medium">이름</th>
                <th className="px-3 py-2 font-medium">기준 연도</th>
                <th className="px-3 py-2 font-medium">상태</th>
                <th className="px-3 py-2 font-medium">올린 때</th>
                <th className="px-3 py-2 font-medium">크기</th>
                <th className="px-5 py-2 font-medium text-right">관리</th>
              </tr>
            </thead>
            <tbody>
              {current.map((row) => (
                <tr key={row.id} className="border-b border-slate-700/30 last:border-0 align-top">
                  <td className="px-5 py-3 text-slate-200">
                    <div>{row.title}</div>
                    <div className="text-xs text-slate-500 mt-0.5">{row.file_name}</div>
                    {(row.noda_status === 'failed' || row.noda_status === 'unreadable') && (
                      <div className="text-xs text-amber-400 mt-1">{FAILED_HINT}</div>
                    )}
                  </td>
                  <td className="px-3 py-3 text-slate-300">{row.edition_year}</td>
                  <td className="px-3 py-3">
                    <StatusChip row={row} />
                  </td>
                  <td className="px-3 py-3 text-slate-400 whitespace-nowrap">{formatDate(row.created_at)}</td>
                  <td className="px-3 py-3 text-slate-400 whitespace-nowrap">{formatSize(row.size_bytes)}</td>
                  <td className="px-5 py-3 text-right whitespace-nowrap">
                    {row.noda_status === 'failed' && (
                      <button onClick={() => handleRetry(row.id)} className="text-xs text-blue-400 hover:text-blue-300 mr-3">
                        다시 시도
                      </button>
                    )}
                    <button onClick={() => handleDelete(row)} className="text-xs text-red-400 hover:text-red-300">
                      {row.noda_status === 'deleting' ? '다시 지우기' : '지우기'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* 지난 판 (접힘) */}
      {retired.length > 0 && (
        <section className="bg-[#1E293B] border border-slate-700/50 rounded-2xl overflow-hidden">
          <button
            onClick={() => setShowRetired((v) => !v)}
            className="w-full px-5 py-3 text-left text-sm font-semibold text-slate-300 hover:text-white flex items-center justify-between"
          >
            <span>
              지난 판 <span className="text-slate-500 font-normal">({retired.length})</span>
            </span>
            <span className="text-slate-500">{showRetired ? '접기' : '펼치기'}</span>
          </button>
          {showRetired && (
            <table className="w-full text-sm border-t border-slate-700/50">
              <tbody>
                {retired.map((row) => (
                  <tr key={row.id} className="border-b border-slate-700/30 last:border-0">
                    <td className="px-5 py-3 text-slate-300">
                      <div>{row.title}</div>
                      <div className="text-xs text-slate-500 mt-0.5">{row.file_name}</div>
                    </td>
                    <td className="px-3 py-3 text-slate-400">{row.edition_year}</td>
                    <td className="px-3 py-3">
                      <StatusChip row={row} />
                    </td>
                    <td className="px-3 py-3 text-slate-400 whitespace-nowrap">{formatDate(row.created_at)}</td>
                    <td className="px-3 py-3 text-slate-400 whitespace-nowrap">{formatSize(row.size_bytes)}</td>
                    <td className="px-5 py-3 text-right">
                      <button onClick={() => handleDelete(row)} className="text-xs text-red-400 hover:text-red-300">
                        지우기
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {/* 올리기 */}
      <section className="bg-[#1E293B] border border-slate-700/50 rounded-2xl p-5">
        <h2 className="text-sm font-semibold text-white mb-4">{orgType}에 문서 올리기</h2>
        <form onSubmit={handleUpload} className="space-y-4">
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">
              파일 <span className="text-slate-500">({UPLOAD_FORMATS_LABEL} · 최대 {MAX_UPLOAD_SIZE_LABEL})</span>
            </label>
            <input
              key={fileKey}
              type="file"
              accept={UPLOAD_ACCEPT_ATTRIBUTE}
              disabled={uploading}
              onChange={(e) => {
                const file = e.target.files?.[0] ?? null;
                // 이름이 비어 있으면 파일 이름(확장자 뺀 것)을 제안한다
                setForm((f) => ({ ...f, file, title: f.title || (file ? file.name.replace(/\.[^.]+$/, '') : '') }));
              }}
              className="block w-full text-sm text-slate-300 file:mr-3 file:px-3 file:py-2 file:rounded-lg file:border-0 file:bg-slate-700 file:text-slate-200"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="md:col-span-2">
              <label className="block text-xs text-slate-400 mb-1.5">문서 이름 (필수)</label>
              <input
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                disabled={uploading}
                placeholder="예: 예산편성기준"
                className={inputCls}
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1.5">기준 연도 (필수)</label>
              <input
                type="number"
                value={form.year}
                onChange={(e) => setForm((f) => ({ ...f, year: e.target.value }))}
                disabled={uploading}
                min={2000}
                max={2100}
                className={inputCls}
              />
            </div>
          </div>

          <div>
            <label className="block text-xs text-slate-400 mb-1.5">바꿀 옛 판</label>
            <select
              value={form.replacesId}
              onChange={(e) => setForm((f) => ({ ...f, replacesId: e.target.value }))}
              disabled={uploading}
              className={inputCls}
            >
              <option value="">없음(새 문서)</option>
              {replaceCandidates.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title} ({r.edition_year})
                </option>
              ))}
            </select>
            <p className="text-xs text-slate-500 mt-1">
              같은 이름의 현재 판이 있으면 여기서 골라야 올릴 수 있습니다. 새 판을 다 읽으면 옛 판은 지난 판으로 바뀝니다.
            </p>
          </div>

          <div>
            <label className="block text-xs text-slate-400 mb-1.5">이용 조건 확인 (필수)</label>
            <textarea
              value={form.usageTerms}
              onChange={(e) => setForm((f) => ({ ...f, usageTerms: e.target.value }))}
              disabled={uploading}
              rows={2}
              placeholder="예: 공공누리 1유형 — 출처 표시 후 자유 이용 확인(2026-10-25)"
              className={inputCls}
            />
          </div>

          <button
            type="submit"
            disabled={uploading}
            className="px-5 py-2.5 rounded-xl bg-[#7C3AED] text-white text-sm font-medium hover:bg-[#6D28D9] disabled:opacity-50"
          >
            {uploading ? (stage === 'registering' ? '등록하는 중...' : '올리는 중...') : '올리기'}
          </button>
        </form>
      </section>
    </div>
  );
}
