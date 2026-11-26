'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BATCH_ITEM_STATUS_LABELS, BATCH_JUDGE_GRADES, BATCH_JUDGE_LABELS, batchAgreementSummary, isBatchJudgeGrade, judgeVerdict,
  type BatchItemView, type BatchJudgeGrade, type BatchView,
} from '@/lib/apps/batch-spec';
import { fetchOkJson, requestJson, serverErrorText } from '@/lib/ok-json';
import { latestGate } from '@/lib/latest-request';

/** 줄별 결과를 못 읽었을 때(2026-11-26) — '줄이 없습니다'로 보이지 않는다 */
export const BATCH_ITEMS_UNREAD = '줄별 결과를 지금 불러오지 못했습니다. 잠시 뒤 다시 열어 주세요.';
export const BATCH_LABEL_FAILED = '사람 판정을 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.';

/** 입력값 몇 개를 한 줄로 — 줄을 알아볼 만큼만 */
export function itemInputPreview(item: Pick<BatchItemView, 'inputs' | 'fileName'>, fields: Array<{ key: string; label: string }>): string {
  const parts = [
    ...(item.fileName ? [item.fileName] : []),
    ...fields.map((f) => (item.inputs[f.key] ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean),
  ];
  const text = parts.slice(0, 3).join(' · ');
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

/**
 * 일괄 실행의 줄별 결과와 사람 판정(0126) — 만든 직원이 마친 줄마다 결과가 기대 답과 맞는지 맞음·일부·틀림을 매기면
 * AI 채점과 맞대 일치율·후하게/짜게 본 줄·3×3 표를 보인다(서버가 다시 셈). 결과 글은 대화에서 본다
 */
export default function AppBatchItems({ batchId, fields, onChanged }: { batchId: string; fields: Array<{ key: string; label: string }>; onChanged?: (batch: BatchView) => void }) {
  const [batch, setBatch] = useState<BatchView | null>(null);
  const [items, setItems] = useState<BatchItemView[] | null>(null);
  const [unread, setUnread] = useState(false);
  const [saving, setSaving] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const gate = useRef(latestGate());

  const load = useCallback(async () => {
    const ticket = gate.current.begin();
    const body = await fetchOkJson<{ data: { batch: BatchView; items: BatchItemView[] } }>(`/api/apps/batches/${encodeURIComponent(batchId)}`);
    if (!gate.current.isLatest(ticket)) return;
    if (!body) { setUnread(true); return; }
    setUnread(false); setBatch(body.data.batch); setItems(body.data.items);
  }, [batchId]);
  useEffect(() => { void load(); }, [load]);

  async function label(item: BatchItemView, value: string) {
    if (saving !== null) return;
    const grade: BatchJudgeGrade | null = isBatchJudgeGrade(value) ? value : null;
    setSaving(item.position); setError(null);
    const ticket = gate.current.begin();
    const reply = await requestJson(`/api/apps/batches/${encodeURIComponent(batchId)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ position: item.position, grade }),
    });
    setSaving(null);
    if (!reply.ok) { setError(serverErrorText(reply.body, BATCH_LABEL_FAILED)); return; }
    if (!gate.current.isLatest(ticket)) return;
    const next = reply.body.data as { batch: BatchView; items: BatchItemView[] };
    setBatch(next.batch); setItems(next.items); setUnread(false);
    onChanged?.(next.batch);
  }

  if (unread && !items) return <p role="alert" className="mt-2 text-amber-700">{BATCH_ITEMS_UNREAD}</p>;
  if (!items) return <p className="mt-2 text-slate-500">줄별 결과를 불러오는 중…</p>;
  const agreement = batch?.agreement;
  return (
    <div className="mt-2 space-y-2">
      {unread && <p role="alert" className="text-amber-700">{BATCH_ITEMS_UNREAD} 아래는 앞서 읽은 결과입니다.</p>}
      <p className="text-slate-600">
        마친 줄마다 결과가 기대 답과 맞는지 직접 매기면 AI 채점이 사람 판정과 얼마나 맞는지 셉니다. 결과 글은 각 줄의 대화에서 보세요.
        {batchAgreementSummary(agreement)}
      </p>
      {agreement && agreement.compared > 0 && (
        <table className="text-[11px]">
          <caption className="text-left text-slate-500">사람 판정(줄) → AI 채점(칸)</caption>
          <thead><tr><th className="px-1" />{BATCH_JUDGE_GRADES.map((g) => <th key={g} className="px-1 font-medium">{BATCH_JUDGE_LABELS[g]}</th>)}</tr></thead>
          <tbody>
            {BATCH_JUDGE_GRADES.map((h) => (
              <tr key={h}><th className="px-1 text-left font-medium">{BATCH_JUDGE_LABELS[h]}</th>{BATCH_JUDGE_GRADES.map((g) => <td key={g} className={`px-1 text-center ${h === g ? 'font-semibold' : ''}`}>{agreement.matrix[h][g]}</td>)}</tr>
            ))}
          </tbody>
        </table>
      )}
      {error && <p role="alert" className="text-red-700">{error}</p>}
      {items.length === 0 ? <p className="text-slate-500">줄이 없습니다.</p> : (
        <ul className="max-h-80 space-y-1 overflow-y-auto">
          {items.map((it) => (
            <li key={it.position} className="rounded border border-slate-100 px-2 py-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 flex-1 truncate">{it.position}. {itemInputPreview(it, fields) || '(입력 없음)'}</span>
                <span className="text-slate-500">{BATCH_ITEM_STATUS_LABELS[it.status]}</span>
                {it.conversationId && <Link href={`/chat?conv=${encodeURIComponent(it.conversationId)}`} className="text-ws-accent-text underline">결과 보기</Link>}
              </div>
              {it.expect && <p className="text-slate-500">기대 답: {it.expect}</p>}
              {(it.judgeGrade || it.judgeReason) && <p className="text-slate-600">AI 채점(참고): {judgeVerdict(it.judgeGrade, it.judgeReason)}</p>}
              {it.status === 'done' && (
                <label className="mt-1 flex items-center gap-2">
                  <span>사람 판정</span>
                  <select value={it.humanGrade ?? ''} disabled={saving !== null} onChange={(e) => void label(it, e.target.value)} className="rounded border border-slate-300 px-1 py-0.5">
                    <option value="">매기지 않음</option>
                    {BATCH_JUDGE_GRADES.map((g) => <option key={g} value={g}>{BATCH_JUDGE_LABELS[g]}</option>)}
                  </select>
                  {saving === it.position && <span className="text-slate-500">저장 중…</span>}
                </label>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
