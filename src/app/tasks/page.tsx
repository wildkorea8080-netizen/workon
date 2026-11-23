'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import WorkShell, { Card, ErrorNote, PageTitle } from '@/components/work/WorkShell';
import { TaskTable } from '@/components/work/WorkHome';
import { api, TASK_STATUS_LABEL } from '@/lib/work/client';
import { emptyListText } from '@/lib/ok-json';
import type { TaskDto } from '@/components/work/types';

const FILTERS = ['', 'needs_review', 'processing', 'ready', 'draft', 'completed'];

/** 내 작업함 — 내가 주인이거나 공유받은 작업만. 상태로 거르고 다음 쪽을 이어 본다 */
function TasksList() {
  const params = useSearchParams();
  const [status, setStatus] = useState(params.get('status') ?? '');
  const [items, setItems] = useState<TaskDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unread, setUnread] = useState(false);
  // 거르기를 빨리 바꾸면 늦게 온 앞 거르기의 응답을 버린다
  const requestSeq = useRef(0);

  const load = useCallback(
    async (next: string | null) => {
      const seq = ++requestSeq.current;
      setLoading(true);
      const q = new URLSearchParams({ limit: '20' });
      if (status) q.set('status', status);
      if (next) q.set('cursor', next);
      const r = await api<{ items: TaskDto[]; nextCursor: string | null }>(`/api/work/tasks?${q}`);
      if (seq !== requestSeq.current) return;
      setLoading(false);
      if (!r.ok) {
        setError(r.error.message);
        // 첫 쪽을 못 읽었으면 앞 거르기의 작업을 새 거르기 결과처럼 남기지 않는다('더 보기' 실패는 읽은 쪽 그대로)
        if (!next) { setItems([]); setCursor(null); setUnread(true); }
        return;
      }
      setError(null);
      setUnread(false);
      setItems((prev) => (next ? [...prev, ...r.data.items] : r.data.items));
      setCursor(r.data.nextCursor);
    },
    [status]
  );
  useEffect(() => {
    void load(null);
  }, [load]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 md:px-8">
      <PageTitle title="내 작업함" subtitle="내가 만든 작업과 공유받은 작업입니다." />
      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="상태로 거르기">
        {FILTERS.map((f) => (
          <button
            key={f || 'all'}
            onClick={() => setStatus(f)}
            aria-pressed={status === f}
            className={`rounded-lg border px-3 py-1.5 text-[14px] ${status === f ? 'border-[#003087] bg-[#003087] text-white' : 'border-[#DCE3EC] bg-white hover:border-[#003087]'}`}
          >
            {f ? TASK_STATUS_LABEL[f] : '전체'}
          </button>
        ))}
      </div>
      <ErrorNote message={error} />
      <Card className="p-0 overflow-x-auto">
        {!loading && items.length === 0 ? <div className="p-6 text-[15px] text-slate-600">{emptyListText(unread, '해당하는 작업이 없습니다.', '작업 목록을')}</div> : <TaskTable tasks={items} />}
      </Card>
      {cursor && (
        <button onClick={() => load(cursor)} className="mt-4 rounded-lg border border-[#DCE3EC] bg-white px-4 py-2 text-[14px] hover:border-[#003087]">
          더 보기
        </button>
      )}
    </div>
  );
}

export default function TasksPage() {
  return (
    <WorkShell>
      <Suspense fallback={null}>
        <TasksList />
      </Suspense>
    </WorkShell>
  );
}
