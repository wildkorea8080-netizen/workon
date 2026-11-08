'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import WorkShell, { Card, ErrorNote, PageTitle, StatusBadge } from '@/components/work/WorkShell';
import { api, formatBytes, formatDateTime, PREVIEW_STATUS_LABEL } from '@/lib/work/client';
import type { ArtifactDto } from '@/components/work/types';
import type { MyGeneratedFile } from '@/lib/my-generated-files';
import { fileBadge } from '@/lib/file-badge';
import { matchesFileQuery, normalizeFileQuery, MY_FILES_QUERY_MAX } from '@/lib/file-search';

/** 결과물 모음 — 볼 수 있는 작업의 파일만, 판별로. 내려받기는 그때마다 권한을 다시 본다 */
export default function FilesPage() {
  const [allFiles, setFiles] = useState<ArtifactDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 내 파일 통합 찾기(2026-11-08) — 한 칸에 적은 글로 세 목록(업무 결과물·대화에서 만든 파일·대화에 올린 파일)을 함께 찾는다.
  // 입력 중인 글과 건 글을 따로 둔다(목록의 '더 보기'는 건 글로 이어 읽는다)
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    api<ArtifactDto[]>('/api/work/files').then((r) => (r.ok ? setFiles(r.data) : setError(r.error.message)));
  }, []);
  // 업무 결과물은 한 번에 다 받으므로 화면에서 거른다(파일 이름·작업 이름)
  const files = allFiles ? allFiles.filter((f) => matchesFileQuery(query, f.file_name, f.taskTitle)) : null;
  return (
    <WorkShell>
      <div className="mx-auto max-w-6xl px-4 py-8 md:px-8">
        <PageTitle title="결과물" subtitle="업무 작업·AI 대화에서 만들고 올린 내 파일입니다." />
        <form role="search" aria-label="내 파일 찾기" className="mb-6 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); setQuery(normalizeFileQuery(draft) ?? ''); }}>
          <input aria-label="파일 이름으로 내 파일 찾기" value={draft} maxLength={MY_FILES_QUERY_MAX} onChange={(e) => setDraft(e.target.value)} placeholder="파일 이름으로 찾기 — 업무 결과물·대화에서 만든 파일·대화에 올린 파일"
            className="min-w-[260px] flex-1 rounded-lg border border-[#DCE3EC] px-3 py-2 text-[15px]" />
          <button type="submit" className="rounded-lg border border-[#DCE3EC] px-4 py-2 text-[15px]">찾기</button>
          {query && <button type="button" onClick={() => { setDraft(''); setQuery(''); }} className="px-2 text-[14px] text-slate-500">전체 보기</button>}
        </form>
        <h2 className="mb-1 text-[17px] font-semibold text-slate-900">업무 결과물</h2>
        <p className="mb-3 text-[13px] text-slate-500">업무 작업에서 만든 파일입니다. 대화를 지워도 남습니다.</p>
        <ErrorNote message={error} />
        <Card className="p-0 overflow-x-auto">
          {files && files.length === 0 ? (
            <div className="p-6 text-[15px] text-slate-600">{query ? `'${query}'이(가) 이름에 든 업무 결과물이 없습니다.` : '아직 만든 파일이 없습니다.'}</div>
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
        <PagedFiles
          query={query}
          endpoint="/api/files"
          title="대화에서 만든 파일"
          description="AI 대화에서 비서가 만들어 준 파일입니다(양식 채우기·표 합치기·앱 결과 내보내기). 대화를 지우면 함께 지워집니다."
          sourceHeader="만든 곳"
          emptyText="대화에서 만든 파일이 없습니다."
          downloadHref={(id) => `/api/files/${id}`}
        />
        <PagedFiles
          query={query}
          endpoint="/api/attachments/mine"
          title="대화에 올린 파일"
          description="AI 대화에 붙여 보낸 파일입니다. 대화 입력창의 '지난 파일'로 다시 붙일 수 있고, 대화를 지우면 함께 지워집니다."
          sourceHeader="구분"
          emptyText="대화에 올린 파일이 없습니다."
          downloadHref={(id) => `/api/attachments/${id}/original`}
        />
      </div>
    </WorkShell>
  );
}

/**
 * 쪽으로 읽는 내 파일 목록 — '대화에서 만든 파일'(2026-11-07, 양식 채우기·표 합치기·앱 결과 내보내기)과 '대화에 올린 파일'(2026-11-08).
 * 내 것만, 50개씩. 찾기 글은 페이지 위 통합 찾기에서 받는다(바뀌면 처음부터 다시 읽는다)
 */
function PagedFiles({ query, endpoint, title, description, sourceHeader, emptyText, downloadHref }: {
  query: string; endpoint: string; title: string; description: string; sourceHeader: string; emptyText: string; downloadHref: (id: string) => string;
}) {
  const [files, setFiles] = useState<MyGeneratedFile[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const latest = useRef(0);
  const load = async (cursor: string | null) => {
    const seq = ++latest.current;
    setLoading(true);
    const params = new URLSearchParams();
    if (cursor) params.set('cursor', cursor);
    if (query) params.set('q', query);
    const r = await api<{ files: MyGeneratedFile[]; next: string | null }>(`${endpoint}${params.toString() ? `?${params.toString()}` : ''}`);
    if (seq !== latest.current) return; // 늦게 온 옛 응답은 버린다
    setLoading(false);
    if (!r.ok) { setError(r.error.message); return; }
    setError(null);
    setFiles((prev) => (cursor ? [...(prev ?? []), ...r.data.files] : r.data.files));
    setNext(r.data.next);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(null); }, [query, endpoint]);
  return (
    <section aria-label={title} className="mt-8">
      <h2 className="text-[17px] font-semibold text-slate-900">{title}</h2>
      <p className="mt-1 mb-3 text-[13px] text-slate-500">{description}</p>
      <ErrorNote message={error} />
      <Card className="p-0 overflow-x-auto">
        {files && files.length === 0 ? (
          <div className="p-6 text-[15px] text-slate-600">{query ? `'${query}'이(가) 이름에 든 파일이 없습니다.` : emptyText}</div>
        ) : (
          <table className="w-full min-w-[720px] text-left text-[15px]">
            <thead className="border-b border-[#DCE3EC] text-[13px] text-slate-500">
              <tr>
                <th scope="col" className="px-5 py-3 font-medium">파일</th>
                <th scope="col" className="px-5 py-3 font-medium">{sourceHeader}</th>
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
                    <a href={downloadHref(f.id)} className="rounded-lg border border-[#DCE3EC] px-3 py-1.5 text-[14px] hover:border-[#003087]">
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
