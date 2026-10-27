'use client';

import WorkShell from '@/components/work/WorkShell';
import TaskWorkbench from '@/components/work/TaskWorkbench';

export default function TaskPage({ params }: { params: { id: string } }) {
  return (
    <WorkShell>
      <TaskWorkbench taskId={params.id} />
    </WorkShell>
  );
}
