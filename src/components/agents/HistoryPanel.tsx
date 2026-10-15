'use client';

import { useCallback, useEffect, useState } from 'react';
import { describeHistoryItem, canRevertTo } from '@/lib/agent-form';

type HistoryItem = {
  id: string;
  kind: string;
  version: number | null;
  changed_by_name: string | null;
  detail: Record<string, unknown>;
  created_at: string;
};

/** 누가 언제 무엇을 바꿨는지 + 이 판으로 되돌리기(설계 6.4) */
export default function HistoryPanel({
  agentId,
  version,
  onReverted,
  onStale,
}: {
  agentId: string;
  version: number;
  onReverted: () => void;
  /** 판이 어긋나 되돌리지 못했을 때 부모가 판을 새로 읽는다(설정 고친 내용은 유지) */
  onStale?: () => void;
}) {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/agents/${agentId}/history`);
    const r = await res.json();
    if (r.ok) setItems(r.data.items);
    else setError(r.error?.message ?? '변경 기록을 불러오지 못했습니다.');
  }, [agentId]);

  useEffect(() => {
    load();
  }, [load, version]);

  const revert = async (target: number) => {
    if (
      !confirm(
        `판 ${target}(으)로 되돌릴까요? 지금 내용은 기록에 남고, 되돌린 내용이 새 판이 됩니다. 설정 탭에서 저장하지 않은 고친 내용은 사라집니다.`
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/agents/${agentId}/revert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: target, base_version: version }),
      });
      const r = await res.json();
      if (!r.ok) {
        setError(r.error?.message ?? '되돌리지 못했습니다.');
        if (res.status === 409 && r.error?.details?.reason === 'conflict') onStale?.();
      } else {
        onReverted();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      {items.map((item) => (
        <div key={item.id} className="flex items-start gap-3 p-3 border border-slate-100 rounded-xl">
          <span
            className={`mt-0.5 px-1.5 py-0.5 text-[10px] font-semibold rounded ${
              item.version === version ? 'bg-[#003087] text-white' : 'bg-slate-100 text-slate-500'
            }`}
          >
            {item.version !== null ? `판 ${item.version}` : '기록'}
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-slate-800">{describeHistoryItem(item)}</p>
            <p className="text-[11px] text-slate-400">
              {item.changed_by_name ?? '시스템'} · {new Date(item.created_at).toLocaleString('ko-KR')}
            </p>
          </div>
          {canRevertTo(item, version) && (
            <button
              onClick={() => revert(item.version as number)}
              disabled={busy}
              className="px-3 py-1 text-xs border border-slate-200 rounded-lg hover:bg-slate-50 text-slate-600 disabled:opacity-50 flex-shrink-0"
            >
              이 판으로 되돌리기
            </button>
          )}
        </div>
      ))}
      {items.length === 0 && <p className="text-xs text-slate-400 py-4 text-center">기록이 없습니다.</p>}
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}
