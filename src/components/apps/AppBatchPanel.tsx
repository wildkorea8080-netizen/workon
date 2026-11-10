'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { renderAppInput, type AppDefinition } from '@/lib/apps/definition';
import { estimateAppCalls } from '@/lib/apps/call-estimate';
import {
  BATCH_FILES_UNSUPPORTED, BATCH_MAX_ROWS, BATCH_NAME_MAX, BATCH_STATUS_LABELS, parseBatchTable, type BatchView,
} from '@/lib/apps/batch-spec';

const kst = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' }) : '—');

/** 붙인 표를 미리 보기 — 줄마다 앱 규칙(서버와 같은 `renderAppInput`)으로 검사하고, 많으면 AI 호출 수를 더한다 */
export function previewBatch(definition: AppDefinition, text: string): { ok: true; rows: Record<string, string>[]; maxCalls: number } | { ok: false; errors: string[] } {
  const parsed = parseBatchTable(text, definition.fields);
  if (!parsed.ok) return parsed;
  const errors: string[] = [];
  let maxCalls = 0;
  parsed.rows.forEach((row, i) => {
    const checked = renderAppInput(definition, row);
    if (!checked.ok) errors.push(`${i + 1}번째 줄: ${checked.message}`);
    else maxCalls += estimateAppCalls(definition, checked.inputs, 0).max;
  });
  return errors.length ? { ok: false, errors: errors.slice(0, 10) } : { ok: true, rows: parsed.rows, maxCalls };
}

/**
 * 입력형 앱 일괄 실행(0077) — 엑셀에서 복사한 표(첫 줄 = 입력 항목 이름)나 CSV를 붙이면 줄마다 이 앱을 실행하고 결과를 엑셀로 받는다.
 * 실행은 서버가 5분마다 몇 줄씩(손 실행·예약과 같은 권한·한도·사용 기록). 파일이 꼭 필요한 앱은 일괄 실행할 수 없다
 */
export default function AppBatchPanel({ agentId, agentName, definition, disabled }: { agentId: string; agentName: string; definition: AppDefinition; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [batches, setBatches] = useState<BatchView[]>([]);
  const unsupported = Boolean(definition.attachments?.required);
  const preview = useMemo(() => (text.trim() ? previewBatch(definition, text) : null), [definition, text]);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/apps/batches?agent=${encodeURIComponent(agentId)}`);
      const body = await res.json().catch(() => null);
      if (res.ok && body?.ok) setBatches(body.data);
    } catch { /* 목록은 표시일 뿐 */ }
  }, [agentId]);
  useEffect(() => { if (open) void load(); }, [open, load]);
  // 실행 중인 일괄 실행이 있으면 30초마다 다시 읽는다
  useEffect(() => {
    if (!open || !batches.some((b) => b.status === 'running')) return;
    const timer = setTimeout(() => void load(), 30_000);
    return () => clearTimeout(timer);
  }, [open, batches, load]);

  async function submit() {
    if (busy || !preview?.ok) return;
    setBusy(true); setError(null); setErrors([]);
    try {
      const res = await fetch('/api/apps/batches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_id: agentId, name: name.trim() || undefined, rows: preview.rows }) });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) { setError(body?.error?.message ?? '일괄 실행을 만들지 못했습니다.'); setErrors(body?.error?.details?.errors ?? []); }
      else { setText(''); setName(''); await load(); }
    } finally { setBusy(false); }
  }
  async function cancel(batch: BatchView) {
    if (!window.confirm(`'${batch.name}'을(를) 그만둘까요? 기다리던 줄은 실행하지 않습니다(이미 실행 중인 줄은 끝까지 갑니다).`)) return;
    const res = await fetch(`/api/apps/batches/${encodeURIComponent(batch.id)}`, { method: 'DELETE' });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.ok) setError(body?.error?.message ?? '그만두지 못했습니다.');
    await load();
  }
  async function readFile(file: File) {
    if (file.size > 400_000) { setError('CSV 파일이 너무 큽니다(400KB까지).'); return; }
    setText(await file.text());
  }

  const header = definition.fields.map((f) => f.label).join('\t');
  return (
    <section className="mt-6 border-t pt-5">
      <button type="button" onClick={() => setOpen((v) => !v)} className="text-sm font-semibold text-ws-accent-text">{open ? '▾' : '▸'} 여러 건 한 번에 실행(일괄 실행)</button>
      {open && (unsupported ? <p className="mt-3 text-xs text-slate-600">{BATCH_FILES_UNSUPPORTED}</p> : (
        <div className="mt-3 space-y-3">
          <p className="text-xs leading-5 text-slate-500">
            엑셀에서 표를 복사해 붙이거나 CSV 파일을 고르세요. <strong>첫 줄은 입력 항목 이름</strong>({definition.fields.map((f) => f.label).join(', ')})이고 아래로 한 줄에 한 건, {BATCH_MAX_ROWS}줄까지입니다.
            줄마다 이 앱을 한 번씩 실행해(지금 판·지금 권한) 결과를 엑셀로 모아 줍니다. 서버가 5분마다 몇 줄씩 처리하므로 줄이 많으면 시간이 걸립니다(창을 닫아도 이어 가고, 모두 마치거나 멈추면 메일로 한 번 알립니다). 줄마다 AI 사용량이 듭니다.
          </p>
          <button type="button" onClick={() => setText(`${header}\n`)} className="text-xs text-ws-accent-text underline">머리글 넣기</button>
          <textarea aria-label="일괄 실행 표" value={text} disabled={disabled || busy} onChange={(e) => setText(e.target.value)} rows={6} placeholder={`${header}\n…`} className="w-full rounded-xl border border-slate-200 p-3 font-mono text-xs" />
          <div className="flex flex-wrap items-center gap-3">
            <input aria-label="CSV 파일" type="file" accept=".csv,.tsv,.txt,text/csv" disabled={disabled || busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) void readFile(f); e.target.value = ''; }} className="max-w-full text-xs" />
            <input aria-label="일괄 실행 이름" value={name} maxLength={BATCH_NAME_MAX} onChange={(e) => setName(e.target.value)} placeholder={`이름(선택) — 기본 '${agentName} 일괄 실행'`} className="min-w-0 flex-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs" />
          </div>
          {preview && (preview.ok
            ? <p role="status" className="text-xs text-slate-700">{preview.rows.length}줄 — 많으면 AI 호출 {preview.maxCalls}번</p>
            : <ul role="alert" className="space-y-0.5 text-xs text-red-700">{preview.errors.map((e) => <li key={e}>{e}</li>)}</ul>)}
          <button type="button" disabled={disabled || busy || !preview?.ok} onClick={() => void submit()} className="rounded-xl bg-ws-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">{busy ? '만드는 중…' : '일괄 실행 시작'}</button>
          {error && <div role="alert" className="text-xs text-red-700"><p>{error}</p>{errors.length > 1 && <ul>{errors.slice(1).map((e) => <li key={e}>{e}</li>)}</ul>}</div>}
          {batches.length > 0 && (
            <ul className="space-y-2 text-xs">
              {batches.map((b) => (
                <li key={b.id} className="rounded-lg border border-slate-200 p-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{b.name}</span>
                    <span className={b.status === 'running' ? 'text-ws-accent-text' : b.status === 'stopped' ? 'text-red-700' : 'text-slate-600'}>{BATCH_STATUS_LABELS[b.status]} · 완료 {b.done}/{b.total}{b.failed ? ` · 실패 ${b.failed}` : ''}{b.skipped ? ` · 건너뜀 ${b.skipped}` : ''}</span>
                  </div>
                  <p className="mt-1 text-slate-500">{kst(b.createdAt)}{b.finishedAt ? ` ~ ${kst(b.finishedAt)}` : ''}{b.stopReason ? ` — ${b.stopReason}` : ''}</p>
                  <div className="mt-1 flex gap-3">
                    {(b.done > 0 || b.failed > 0) && <Link href={`/api/apps/batches/${encodeURIComponent(b.id)}/export`} prefetch={false} className="text-ws-accent-text underline">결과 엑셀</Link>}
                    {b.status === 'running' && <button type="button" onClick={() => void cancel(b)} className="text-red-600 underline">그만두기</button>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </section>
  );
}
