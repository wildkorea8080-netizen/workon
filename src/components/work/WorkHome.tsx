'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, TASK_STATUS_LABEL, formatDateTime } from '@/lib/work/client';
import { Card, ErrorNote, PageTitle, StatusBadge, statusTone } from './WorkShell';
import WorkflowCard from './WorkflowCard';
import type { ArtifactDto, TaskDto, WorkflowSummaryDto } from './types';

/**
 * 업무 홈 — 처리할 업무·검토할 결과물 중심(개편 03 문서 '홈'). 숫자는 실제 작업에서 센다 — 값이 없으면 0과 빈 안내.
 * 가짜 실적·절감 시간을 넣지 않는다.
 */
export default function WorkHome() {
  const [workflows, setWorkflows] = useState<WorkflowSummaryDto[] | null>(null);
  const [newTasksEnabled, setNewTasksEnabled] = useState(false);
  const [tasks, setTasks] = useState<TaskDto[] | null>(null);
  const [files, setFiles] = useState<ArtifactDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const [w, t, f] = await Promise.all([
        api<{ settings: { newTasksEnabled: boolean }; workflows: WorkflowSummaryDto[] }>('/api/workflows'),
        api<{ items: TaskDto[] }>('/api/work/tasks?limit=20'),
        api<ArtifactDto[]>('/api/work/files'),
      ]);
      if (w.ok) {
        setWorkflows(w.data.workflows);
        setNewTasksEnabled(w.data.settings.newTasksEnabled);
      }
      if (t.ok) setTasks(t.data.items);
      if (f.ok) setFiles(f.data);
      const firstError = [w, t, f].find((r) => !r.ok);
      if (firstError && !firstError.ok) setError(firstError.error.message);
    })();
  }, []);

  const review = tasks?.filter((t) => t.status === 'needs_review') ?? [];
  const active = tasks?.filter((t) => ['draft', 'ready', 'processing'].includes(t.status)) ?? [];
  const favorite = (workflows ?? []).filter((w) => w.available).concat((workflows ?? []).filter((w) => !w.available)).slice(0, 3);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 md:px-8">
      <PageTitle
        title="오늘 어떤 업무를 처리하시겠어요?"
        subtitle="업무를 고르고 자료를 넣으면 기관 양식에 맞춘 한글(HWPX)·엑셀(XLSX) 파일을 만듭니다."
        action={
          newTasksEnabled ? (
            <Link href="/assistants" className="rounded-[10px] bg-[#003087] px-5 py-3 text-[15px] font-semibold text-white hover:bg-[#002070]">
              새 업무 시작
            </Link>
          ) : null
        }
      />
      <ErrorNote message={error} />
      {!newTasksEnabled && workflows && (
        <p className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-[14px] text-amber-900">
          이 기관은 아직 새 업무 작업을 시작할 수 없습니다. 이미 만든 작업과 결과물은 그대로 볼 수 있습니다.
        </p>
      )}

      <div className="grid gap-4 md:grid-cols-3 mb-8">
        <SummaryCard label="검토할 작업" value={tasks ? `${review.length}건` : '…'} href="/tasks?status=needs_review" />
        <SummaryCard label="진행 중" value={tasks ? `${active.length}건` : '…'} href="/tasks" />
        <SummaryCard label="최근 결과물" value={files ? `${files.length}개` : '…'} href="/files" />
      </div>

      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[18px] font-semibold">자주 쓰는 업무 비서</h2>
        <Link href="/assistants" className="text-[14px] text-[#003087] hover:underline">
          전체 보기
        </Link>
      </div>
      <div className="grid gap-4 md:grid-cols-3 mb-10">
        {favorite.map((w) => (
          <WorkflowCard key={w.key} workflow={w} canStart={newTasksEnabled} />
        ))}
      </div>

      <h2 className="mb-3 text-[18px] font-semibold">최근 작업</h2>
      <Card className="p-0 overflow-x-auto">
        {tasks && tasks.length === 0 ? (
          <div className="p-6 text-[15px] text-slate-600">
            아직 작업이 없습니다. <Link href="/assistants" className="text-[#003087] underline">업무 비서</Link>에서 처리할 업무를 고르면 첫 작업이 시작됩니다.
          </div>
        ) : (
          <TaskTable tasks={tasks ?? []} />
        )}
      </Card>
    </div>
  );
}

function SummaryCard({ label, value, href }: { label: string; value: string; href: string }) {
  return (
    <Link href={href} className="block rounded-xl border border-[#DCE3EC] bg-white p-5 hover:border-[#003087] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#003087]">
      <div className="text-[14px] text-slate-500">{label}</div>
      <div className="mt-1 text-[26px] font-bold">{value}</div>
    </Link>
  );
}

export function TaskTable({ tasks }: { tasks: TaskDto[] }) {
  return (
    <table className="w-full min-w-[640px] text-left text-[15px]">
      <thead className="border-b border-[#DCE3EC] text-[13px] text-slate-500">
        <tr>
          <th scope="col" className="px-5 py-3 font-medium">제목</th>
          <th scope="col" className="px-5 py-3 font-medium">업무</th>
          <th scope="col" className="px-5 py-3 font-medium">상태</th>
          <th scope="col" className="px-5 py-3 font-medium">수정</th>
          <th scope="col" className="px-5 py-3 font-medium"><span className="sr-only">이어서</span></th>
        </tr>
      </thead>
      <tbody>
        {tasks.map((t) => (
          <tr key={t.id} className="border-b border-[#DCE3EC] last:border-0">
            <td className="px-5 py-3 font-medium">{t.title}</td>
            <td className="px-5 py-3 text-slate-600">{t.workflowName}</td>
            <td className="px-5 py-3">
              <StatusBadge label={TASK_STATUS_LABEL[t.status] ?? t.status} tone={statusTone(t.status)} />
            </td>
            <td className="px-5 py-3 text-slate-500 text-[14px]">{formatDateTime(t.updatedAt)}</td>
            <td className="px-5 py-3 text-right">
              <Link href={`/tasks/${t.id}`} className="rounded-lg border border-[#DCE3EC] px-3 py-1.5 text-[14px] hover:border-[#003087]">
                이어서 작업
              </Link>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
