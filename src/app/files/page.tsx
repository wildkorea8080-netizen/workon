'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import WorkShell, { Card, ErrorNote, PageTitle, StatusBadge } from '@/components/work/WorkShell';
import { api, formatBytes, formatDateTime, PREVIEW_STATUS_LABEL } from '@/lib/work/client';
import type { ArtifactDto } from '@/components/work/types';
import type { MyGeneratedFile } from '@/lib/my-generated-files';
import { fileBadge } from '@/lib/file-badge';

/** 결과물 모음 — 볼 수 있는 작업의 파일만, 판별로. 내려받기는 그때마다 권한을 다시 본다 */
export default function FilesPage() {
  const [files, setFiles] = useState<ArtifactDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<ArtifactDto[]>('/api/work/files').then((r) => (r.ok ? setFiles(r.data) : setError(r.error.message)));
  }, []);
  return (
    <WorkShell>
      <div className="mx-auto max-w-6xl px-4 py-8 md:px-8">
        <PageTitle title="결과물" subtitle="업무 작업에서 만든 파일입니다. 대화를 지워도 남습니다." />
        <ErrorNote message={error} />
        <Card className="p-0 overflow-x-auto">
          {files && files.length === 0 ? (
            <div className="p-6 text-[15px] text-slate-600">아직 만든 파일이 없습니다.</div>
          ) : (
            <table className="w-full min-w-[720px] text-left text-[15px]">
              <thead className="border-b border-[#DCE3EC] text-[13px] text-slate-500">
                <tr>
                  <th scope="col" className="px-5 py-3 font-medium">파일</th>
                  <th scope="col" className="px-5 py-3 font-medium">작업</th>
                  <th scope="col" className="px-5 py-3 font-medium">상태</th>
                  <th scope="col" className="px-5 py-3 font-medium">만든 때</th>
                  <th scope="col" className="px-5 py-3 font-medium"><span className="sr-only">내려받기</span></th>
                </tr>
              </thead>
              <tbody>
                {(files ?? []).map((f) => (
                  <tr key={f.id} className="border-b border-[#DCE3EC] last:border-0">
                    <td className="px-5 py-3">
                      <span className="mr-2 rounded border border-[#DCE3EC] px-1.5 py-0.5 text-[12px] font-semibold">{f.format.toUpperCase()}</span>
                      {f.file_name} <span className="text-[13px] text-slate-500">{formatBytes(f.size_bytes)}</span>
                    </td>
                    <td className="px-5 py-3 text-slate-600">{f.taskTitle}</td>
                    <td className="px-5 py-3">
                      {f.current ? <StatusBadge label="최신 판" tone="ok" /> : <StatusBadge label="지난 판" />}
                      <span className="ml-2 text-[13px] text-slate-500">{PREVIEW_STATUS_LABEL[f.preview_status]}</span>
                    </td>
                    <td className="px-5 py-3 text-[14px] text-slate-500">{formatDateTime(f.created_at)}</td>
                    <td className="px-5 py-3 text-right">
                      <a href={`/api/work/artifacts/${f.id}/download`} className="rounded-lg border border-[#DCE3EC] px-3 py-1.5 text-[14px] hover:border-[#003087]">
                        내려받기
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <ConversationFiles />
      </div>
    </WorkShell>
  );
}

/**
 * 대화에서 만든 파일(2026-11-07) — 양식 채우기·표 합치기·앱 결과 내보내기로 비서가 나에게 만들어 준 파일. 내 것만, 50개씩.
 * 대화를 지우면 함께 사라진다(업무 작업 결과물과 다름)
 */
function ConversationFiles() {
  const [files, setFiles] = useState<MyGeneratedFile[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // 파일 이름 찾기(2026-11-08) — 입력 중인 글과 지금 목록에 건 글을 따로 둔다('더 보기'는 건 글로 이어 읽는다)
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const latest = useRef(0);
  const load = async (cursor: string | null, q: string = query) => {
    const seq = ++latest.current;
    setLoading(true);
    const params = new URLSearchParams();
    if (cursor) params.set('cursor', cursor);
    if (q) params.set('q', q);
    const r = await api<{ files: MyGeneratedFile[]; next: string | null }>(`/api/files${params.toString() ? `?${params.toString()}` : ''}`);
    if (seq !== latest.current) return; // 늦게 온 옛 응답은 버린다
    setLoading(false);
    if (!r.ok) { setError(r.error.message); return; }
    setError(null);
    setFiles((prev) => (cursor ? [...(prev ?? []), ...r.data.files] : r.data.files));
    setNext(r.data.next);
  };
  useEffect(() => { void load(null); }, []);
  return (
    <section aria-label="대화에서 만든 파일" className="mt-8">
      <h2 className="text-[17px] font-semibold text-slate-900">대화에서 만든 파일</h2>
      <p className="mt-1 mb-3 text-[13px] text-slate-500">AI 대화에서 비서가 만들어 준 파일입니다(양식 채우기·표 합치기·앱 결과 내보내기). 대화를 지우면 함께 지워집니다.</p>
      <form role="search" className="mb-3 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); const q = draft.trim(); setQuery(q); void load(null, q); }}>
        <input aria-label="파일 이름으로 찾기" value={draft} maxLength={60} onChange={(e) => setDraft(e.target.value)} placeholder="파일 이름으로 찾기"
          className="min-w-[220px] flex-1 rounded-lg border border-[#DCE3EC] px-3 py-1.5 text-[14px]" />
        <button type="submit" disabled={loading} className="rounded-lg border border-[#DCE3EC] px-3 py-1.5 text-[14px] disabled:opacity-50">찾기</button>
        {query && <button type="button" onClick={() => { setDraft(''); setQuery(''); void load(null, ''); }} className="px-2 text-[14px] text-slate-500">전체 보기</button>}
      </form>
      <ErrorNote message={error} />
      <Card className="p-0 overflow-x-auto">
        {files && files.length === 0 ? (
          <div className="p-6 text-[15px] text-slate-600">{query ? `'${query}'이(가) 이름에 든 파일이 없습니다.` : '대화에서 만든 파일이 없습니다.'}</div>
        ) : (
          <table className="w-full min-w-[720px] text-left text-[15px]">
            <thead className="border-b border-[#DCE3EC] text-[13px] text-slate-500">
              <tr>
                <th scope="col" className="px-5 py-3 font-medium">파일</th>
                <th scope="col" className="px-5 py-3 font-medium">만든 곳</th>
                <th scope="col" className="px-5 py-3 font-medium">대화</th>
                <th scope="col" className="px-5 py-3 font-medium">만든 때</th>
                <th scope="col" className="px-5 py-3 font-medium"><span className="sr-only">내려받기</span></th>
              </tr>
            </thead>
            <tbody>
              {(files ?? []).map((f) => (
                <tr key={f.id} className="border-b border-[#DCE3EC] last:border-0">
                  <td className="px-5 py-3">
                    <span className="mr-2 rounded border border-[#DCE3EC] px-1.5 py-0.5 text-[12px] font-semibold">{fileBadge(f.file_name)}</span>
                    {f.file_name} <span className="text-[13px] text-slate-500">{formatBytes(f.size_bytes)}</span>
                  </td>
                  <td className="px-5 py-3 text-slate-600">{f.source}</td>
                  <td className="px-5 py-3">
                    <Link href={`/chat?conv=${encodeURIComponent(f.conversation_id)}`} className="text-slate-700 underline">{f.conversation_title ?? '대화 열기'}</Link>
                  </td>
                  <td className="px-5 py-3 text-[14px] text-slate-500">{formatDateTime(f.created_at)}</td>
                  <td className="px-5 py-3 text-right">
                    <a href={`/api/files/${f.id}`} className="rounded-lg border border-[#DCE3EC] px-3 py-1.5 text-[14px] hover:border-[#003087]">
                      내려받기
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {next && (
        <button type="button" onClick={() => void load(next)} disabled={loading} className="mt-3 rounded-lg border border-[#DCE3EC] px-3 py-1.5 text-[14px] disabled:opacity-50">
          {loading ? '불러오는 중…' : '더 보기'}
        </button>
      )}
    </section>
  );
}
