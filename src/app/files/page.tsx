'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import WorkShell, { Card, ErrorNote, PageTitle, StatusBadge } from '@/components/work/WorkShell';
import { api, formatBytes, formatDateTime, PREVIEW_STATUS_LABEL } from '@/lib/work/client';
import type { ArtifactDto } from '@/components/work/types';

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
        <p className="mt-3 text-[13px] text-slate-500">
          지난 대화에서 만든 파일은 <Link href="/chat" className="underline">AI 대화</Link>의 해당 대화에 그대로 있습니다.
        </p>
      </div>
    </WorkShell>
  );
}
