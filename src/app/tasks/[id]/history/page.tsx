'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import WorkShell, { Card, ErrorNote, PageTitle, StatusBadge } from '@/components/work/WorkShell';
import { api, formatDateTime } from '@/lib/work/client';
import type { ArtifactDto } from '@/components/work/types';

interface VersionRow {
  id: string;
  version: number;
  origin: string;
  changeReason: string;
  createdAt: string;
  current: boolean;
  artifacts: ArtifactDto[];
}

const ORIGIN: Record<string, string> = { generate: 'AI 초안', edit: '직접 수정', revise: 'AI 수정 적용', restore: '복구', import: '가져오기' };

/** 변경 기록 — 판마다 무엇이 왜 바뀌었는지와 그 판의 파일. 복구는 과거 내용으로 새 판을 만든다(과거 판·파일은 그대로) */
export default function HistoryPage({ params }: { params: { id: string } }) {
  const [rows, setRows] = useState<VersionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const load = useCallback(async () => {
    const [v, t] = await Promise.all([api<VersionRow[]>(`/api/work/tasks/${params.id}/versions`), api<{ task: { access: { edit: boolean } } }>(`/api/work/tasks/${params.id}`)]);
    if (v.ok) setRows(v.data);
    else setError(v.error.message);
    if (t.ok) setCanEdit(t.data.task.access.edit);
  }, [params.id]);
  useEffect(() => {
    void load();
  }, [load]);
  const currentVersion = rows?.find((r) => r.current)?.version ?? 0;

  async function restore(row: VersionRow) {
    const r = await api(`/api/work/tasks/${params.id}/versions/${row.id}/restore`, { method: 'POST', json: { baseVersion: currentVersion } });
    if (!r.ok) return setError(r.error.message);
    setError(null);
    await load();
  }

  return (
    <WorkShell>
      <div className="mx-auto max-w-4xl px-4 py-8 md:px-8">
        <PageTitle title="변경 기록" action={<Link href={`/tasks/${params.id}`} className="text-[15px] text-[#003087] underline">작업실로</Link>} />
        <ErrorNote message={error} />
        <div className="space-y-3">
          {rows?.map((r) => (
            <Card key={r.id}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[17px] font-semibold">{r.version}판</span>
                <StatusBadge label={ORIGIN[r.origin] ?? r.origin} />
                {r.current && <StatusBadge label="지금 판" tone="ok" />}
                <span className="ml-auto text-[14px] text-slate-500">{formatDateTime(r.createdAt)}</span>
              </div>
              {r.changeReason && <p className="mt-2 text-[14px] text-slate-700">{r.changeReason}</p>}
              <div className="mt-2 flex flex-wrap gap-3 text-[14px]">
                {r.artifacts.map((a) => (
                  <a key={a.id} href={`/api/work/artifacts/${a.id}/download`} className="text-[#003087] underline">
                    {a.format.toUpperCase()} 내려받기
                  </a>
                ))}
                {!r.artifacts.length && <span className="text-slate-500">이 판의 파일 없음(만드는 중이거나 실패)</span>}
                {canEdit && !r.current && (
                  <button onClick={() => restore(r)} className="ml-auto rounded-lg border border-[#DCE3EC] px-3 py-1 hover:border-[#003087]">
                    이 판 내용으로 복구
                  </button>
                )}
              </div>
            </Card>
          ))}
        </div>
      </div>
    </WorkShell>
  );
}
