'use client';

import { useEffect, useState } from 'react';
import WorkShell, { ErrorNote, PageTitle } from '@/components/work/WorkShell';
import WorkflowCard from '@/components/work/WorkflowCard';
import { api } from '@/lib/work/client';
import type { WorkflowSummaryDto } from '@/components/work/types';

/** 업무 비서 10개 — 구현·검수·파일 산출이 끝난 업무만 '시작'이 열린다. 나머지는 준비 중과 이유 */
export default function AssistantsPage() {
  const [data, setData] = useState<{ workflows: WorkflowSummaryDto[]; canStart: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ settings: { newTasksEnabled: boolean }; workflows: WorkflowSummaryDto[] }>('/api/workflows').then((r) => {
      if (r.ok) setData({ workflows: r.data.workflows, canStart: r.data.settings.newTasksEnabled });
      else setError(r.error.message);
    });
  }, []);
  const ready = data?.workflows.filter((w) => w.available).length ?? 0;
  const total = data?.workflows.length ?? 0;
  const subtitle = !data
    ? undefined
    : !data.canStart
      ? '이 기관은 아직 새 작업이 켜지지 않았습니다. 운영자가 켜면 업무를 시작할 수 있습니다.'
      : ready === total
        ? '업무를 골라 시작하세요. 원자료와 양식을 넣으면 한글·엑셀 파일을 만듭니다.'
        : `${total}개 중 ${ready}개를 지금 쓸 수 있습니다. 나머지는 처리·검수·파일 산출 구현이 끝나면 열립니다.`;
  return (
    <WorkShell>
      <div className="mx-auto max-w-6xl px-4 py-8 md:px-8">
        <PageTitle title="업무 비서" subtitle={subtitle} />
        <ErrorNote message={error} />
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data?.workflows.map((w) => (
            <WorkflowCard key={w.key} workflow={w} canStart={data.canStart} />
          ))}
        </div>
      </div>
    </WorkShell>
  );
}
