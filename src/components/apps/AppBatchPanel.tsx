'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { renderAppInput, type AppDefinition } from '@/lib/apps/definition';
import { estimateAppCalls } from '@/lib/apps/call-estimate';
import {
  BATCH_FILE_ROWS_MISMATCH, BATCH_MAX_FILES, BATCH_MAX_ROWS, BATCH_NAME_MAX, BATCH_STATUS_LABELS, pairRowsWithFiles, parseBatchTable, type BatchView,
} from '@/lib/apps/batch-spec';
import { ATTACHMENT_ACCEPT } from '@/lib/attachments/limits';
import { uploadAttachment } from '@/lib/attachments/upload-client';

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
 * 파일마다 한 건(2026-11-10) 미리 보기 — 표가 비면 모든 파일에 빈 입력 한 줄, 표는 한 줄(모든 파일에 같은 입력)이거나 파일 수와 같은 줄.
 * 줄마다 앱 규칙으로 검사하고, 파일 하나씩 붙인 실행의 많으면 AI 호출 수를 더한다
 */
export function previewFileBatch(definition: AppDefinition, text: string, fileCount: number): { ok: true; rows: Record<string, string>[]; maxCalls: number } | { ok: false; errors: string[] } {
  if (fileCount < 1) return { ok: false, errors: ['파일을 하나 이상 올려 주세요.'] };
  let rows: Record<string, string>[] = [{}];
  if (text.trim()) {
    const parsed = parseBatchTable(text, definition.fields);
    if (!parsed.ok) return parsed;
    rows = parsed.rows;
  }
  if (!pairRowsWithFiles(rows, fileCount)) return { ok: false, errors: [BATCH_FILE_ROWS_MISMATCH] };
  const errors: string[] = [];
  const checked: Record<string, string>[] = [];
  rows.forEach((row, i) => {
    const r = renderAppInput(definition, row);
    if (!r.ok) errors.push(text.trim() ? `${i + 1}번째 줄: ${r.message}` : `입력 표를 채워 주세요 — ${r.message}`);
    else checked.push(r.inputs);
  });
  if (errors.length) return { ok: false, errors: errors.slice(0, 10) };
  const paired = pairRowsWithFiles(checked, fileCount)!;
  return { ok: true, rows, maxCalls: paired.reduce((sum, inputs) => sum + estimateAppCalls(definition, inputs, 1).max, 0) };
}

type BatchUpload = { key: string; name: string; state: 'uploading' | 'ready' | 'failed'; id?: string; message?: string };

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
  const acceptsFiles = Boolean(definition.attachments);
  const filesOnly = Boolean(definition.attachments?.required);
  const [mode, setMode] = useState<'table' | 'files'>(filesOnly ? 'files' : 'table');
  const [uploads, setUploads] = useState<BatchUpload[]>([]);
  const readyIds = uploads.filter((u) => u.state === 'ready' && u.id).map((u) => u.id!);
  const uploading = uploads.some((u) => u.state === 'uploading');
  const preview = useMemo(() => {
    if (mode === 'files') return uploads.length ? previewFileBatch(definition, text, readyIds.length) : null;
    return text.trim() ? previewBatch(definition, text) : null;
  }, [definition, text, mode, uploads.length, readyIds.length]);

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
      const payload = { agent_id: agentId, name: name.trim() || undefined, rows: preview.rows, ...(mode === 'files' ? { attachment_ids: readyIds } : {}) };
      const res = await fetch('/api/apps/batches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) { setError(body?.error?.message ?? '일괄 실행을 만들지 못했습니다.'); setErrors(body?.error?.details?.errors ?? []); }
      else { setText(''); setName(''); setUploads([]); await load(); }
    } finally { setBusy(false); }
  }
  async function addFiles(list: FileList) {
    const room = BATCH_MAX_FILES - uploads.length;
    const picked = Array.from(list).slice(0, Math.max(0, room));
    if (list.length > picked.length) setError(`파일은 ${BATCH_MAX_FILES}개까지 올릴 수 있습니다.`);
    for (const file of picked) {
      const key = `${Date.now()}-${Math.random()}`;
      setUploads((u) => [...u, { key, name: file.name, state: 'uploading' }]);
      const result = await uploadAttachment(file, () => {});
      setUploads((u) => u.map((x) => (x.key !== key ? x : result.ok
        ? (result.attachment.status === 'ready' ? { ...x, state: 'ready', id: result.attachment.id } : { ...x, state: 'failed', id: result.attachment.id, message: result.attachment.error ?? '읽지 못했습니다.' })
        : { ...x, state: 'failed', message: result.message })));
    }
  }
  function removeUpload(item: BatchUpload) {
    setUploads((u) => u.filter((x) => x.key !== item.key));
    if (item.id) void fetch(`/api/attachments/${encodeURIComponent(item.id)}`, { method: 'DELETE' }).catch(() => {});
  }
  async function cancel(batch: BatchView) {
    if (!window.confirm(`'${batch.name}'을(를) 그만둘까요? 기다리던 줄은 실행하지 않습니다(이미 실행 중인 줄은 끝까지 갑니다).`)) return;
    const res = await fetch(`/api/apps/batches/${encodeURIComponent(batch.id)}`, { method: 'DELETE' });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.ok) setError(body?.error?.message ?? '그만두지 못했습니다.');
    await load();
  }
  async function retryUnfinished(batch: BatchView) {
    if (!window.confirm(`'${batch.name}'에서 마치지 못한 ${batch.failed + batch.skipped}줄(실패·건너뜀)로 새 일괄 실행을 만들까요? 지금 앱 설정으로 다시 실행합니다(줄마다 AI 사용량이 듭니다).`)) return;
    setError(null); setErrors([]);
    const res = await fetch(`/api/apps/batches/${encodeURIComponent(batch.id)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'retry_unfinished' }) });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.ok) { setError(body?.error?.message ?? '다시 실행하지 못했습니다.'); setErrors(body?.error?.details?.errors ?? []); }
    else if (body.data?.skippedFiles) setError(`파일마다 한 건의 줄 ${body.data.skippedFiles}개는 빼고 만들었습니다(파일을 다시 올려 실행해 주세요).`);
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
      {open && (
        <div className="mt-3 space-y-3">
          {acceptsFiles && (
            <div role="radiogroup" aria-label="일괄 실행 방식" className="flex gap-4 text-xs">
              {!filesOnly && <label className="flex items-center gap-1"><input type="radio" checked={mode === 'table'} onChange={() => setMode('table')} />표로 여러 건</label>}
              <label className="flex items-center gap-1"><input type="radio" checked={mode === 'files'} onChange={() => setMode('files')} />파일마다 한 건</label>
            </div>
          )}
          {mode === 'table' ? (
            <p className="text-xs leading-5 text-slate-500">
              엑셀에서 표를 복사해 붙이거나 CSV 파일을 고르세요. <strong>첫 줄은 입력 항목 이름</strong>({definition.fields.map((f) => f.label).join(', ')})이고 아래로 한 줄에 한 건, {BATCH_MAX_ROWS}줄까지입니다.
              줄마다 이 앱을 한 번씩 실행해(지금 판·지금 권한) 결과를 엑셀로 모아 줍니다. 서버가 5분마다 몇 줄씩 처리하므로 줄이 많으면 시간이 걸립니다(창을 닫아도 이어 가고, 모두 마치거나 멈추면 메일로 한 번 알립니다). 줄마다 AI 사용량이 듭니다. 기관이 한 번의 줄 수 상한을 낮춰 두었으면 그 줄 수까지입니다.
            </p>
          ) : (
            <div className="space-y-2">
              <p className="text-xs leading-5 text-slate-500">
                파일을 {BATCH_MAX_FILES}개까지 올리면 <strong>파일 하나마다 이 앱을 한 번씩</strong> 실행합니다(파일은 실행 때까지 서버에 따로 보관하고, 일괄 실행이 끝나면 지웁니다).
                입력 항목은 아래 표에 <strong>한 줄</strong>(모든 파일에 같은 입력)이나 <strong>파일 수와 같은 줄</strong>(올린 순서대로 짝)로 넣고, 입력이 필요 없으면 비워 두세요.
              </p>
              <input aria-label="일괄 실행 파일" type="file" multiple accept={ATTACHMENT_ACCEPT} disabled={disabled || busy || uploads.length >= BATCH_MAX_FILES} onChange={(e) => { const f = e.target.files; if (f?.length) void addFiles(f); e.target.value = ''; }} className="max-w-full text-xs" />
              {uploads.length > 0 && (
                <ol className="space-y-1 text-xs">
                  {uploads.map((u, i) => (
                    <li key={u.key} className="flex items-center justify-between gap-2 rounded border border-slate-200 px-2 py-1">
                      <span className="min-w-0 truncate">{i + 1}. {u.name}</span>
                      <span className={u.state === 'failed' ? 'text-red-700' : 'text-slate-500'}>{u.state === 'uploading' ? '올리는 중…' : u.state === 'ready' ? '읽음' : `못 읽음${u.message ? ` — ${u.message}` : ''}`}</span>
                      <button type="button" onClick={() => removeUpload(u)} disabled={u.state === 'uploading'} className="text-slate-500 underline disabled:opacity-40">빼기</button>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}
          <button type="button" onClick={() => setText(`${header}\n`)} className="text-xs text-ws-accent-text underline">머리글 넣기</button>
          <textarea aria-label="일괄 실행 표" value={text} disabled={disabled || busy} onChange={(e) => setText(e.target.value)} rows={6} placeholder={`${header}\n…`} className="w-full rounded-xl border border-slate-200 p-3 font-mono text-xs" />
          <div className="flex flex-wrap items-center gap-3">
            {mode === 'table' && <input aria-label="CSV 파일" type="file" accept=".csv,.tsv,.txt,text/csv" disabled={disabled || busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) void readFile(f); e.target.value = ''; }} className="max-w-full text-xs" />}
            <input aria-label="일괄 실행 이름" value={name} maxLength={BATCH_NAME_MAX} onChange={(e) => setName(e.target.value)} placeholder={`이름(선택) — 기본 '${agentName} 일괄 실행'`} className="min-w-0 flex-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs" />
          </div>
          {preview && (preview.ok
            ? <p role="status" className="text-xs text-slate-700">{mode === 'files' ? `파일 ${readyIds.length}개` : `${preview.rows.length}줄`} — 많으면 AI 호출 {preview.maxCalls}번</p>
            : <ul role="alert" className="space-y-0.5 text-xs text-red-700">{preview.errors.map((e) => <li key={e}>{e}</li>)}</ul>)}
          <button type="button" disabled={disabled || busy || uploading || !preview?.ok} onClick={() => void submit()} className="rounded-xl bg-ws-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">{busy ? '만드는 중…' : '일괄 실행 시작'}</button>
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
                    {b.status !== 'running' && b.failed + b.skipped > 0 && <button type="button" disabled={disabled} onClick={() => void retryUnfinished(b)} className="text-ws-accent-text underline disabled:opacity-40">마치지 못한 줄 다시 실행</button>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
