'use client';
import { useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/work/client';
import { APP_MAX_FILES, renderAppInput, type AppDefinition } from '@/lib/apps/definition';
import {
  APP_MAX_SCHEDULES_PER_USER, FREQUENCY_LABELS, PAUSED_BY_USER, WEEKDAY_LABELS, describeSchedule, parseScheduleSpec,
  type AppScheduleFrequency, type AppScheduleView,
} from '@/lib/apps/schedule-spec';

/**
 * 실행 화면 아래 '이 입력으로 예약' — 지금 폼의 입력값을 저장해 정해진 시각(한국 시간)에 자동 실행한다.
 * 지금 붙인(읽힌) 파일은 예약에 사본으로 저장되고 실행마다 새로 붙는다(0073). 문서함에서 고른 문서는 함께 저장되고, 실행 때마다 그 문서의
 * 지금 판으로 읽는다(0062). 파일·문서는 합쳐 3개까지, 파일이 필수인 앱은 둘 중 하나가 있어야 예약할 수 있다. 검사는 서버가 다시 한다
 */
export default function AppScheduleForm({ agentId, appVersion, definition, values, documentIds = [], attachmentIds = [], hasUploads = false, disabled = false, editing = null }: {
  agentId: string; appVersion: number; definition: AppDefinition; values: Record<string, string>;
  /** 고칠 예약 — 있으면 새로 만들지 않고 이 예약을 지금 입력·문서·시각·앱 판으로 고친다(PUT) */
  editing?: AppScheduleView | null;
  /** 문서함에서 고른 문서 */
  documentIds?: string[];
  /** 지금 붙인 읽힌 첨부 — 예약에 사본으로 저장한다(0073) */
  attachmentIds?: string[];
  /** 올린 파일이 있는가(읽는 중 포함) — 읽기를 마친 것만 저장된다고 알린다 */
  hasUploads?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(Boolean(editing));
  const [frequency, setFrequency] = useState<AppScheduleFrequency>(editing?.spec.frequency ?? 'weekdays');
  const [weekday, setWeekday] = useState(editing?.spec.weekday ?? 1); const [monthDay, setMonthDay] = useState(editing?.spec.monthDay ?? 1);
  const [hour, setHour] = useState(editing?.spec.hour ?? 9); const [minute, setMinute] = useState<0 | 30>(editing?.spec.minute ?? 0);
  const [notifyOnSuccess, setNotifyOnSuccess] = useState(editing?.notifyOnSuccess ?? false);
  const [exportHwpx, setExportHwpx] = useState(editing?.exportHwpx ?? false);
  const [saving, setSaving] = useState(false); const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<AppScheduleView | null>(null);
  // 고치기 — 예약에 저장한 파일 중 남길 것(처음엔 모두)
  const [keepIds, setKeepIds] = useState<string[]>(editing?.files.map(f => f.id) ?? []);
  const library = definition.attachments?.library === true;
  const acceptsFiles = Boolean(definition.attachments);
  const fileCount = keepIds.length + attachmentIds.length;
  const needsFile = Boolean(definition.attachments?.required) && documentIds.length === 0 && fileCount === 0;
  const tooMany = fileCount + documentIds.length > APP_MAX_FILES;
  const spec = parseScheduleSpec({ frequency, weekday, month_day: monthDay, hour, minute });

  async function save() {
    setError(null); setSaved(null);
    const input = renderAppInput(definition, values);
    if (!input.ok) { setError(`예약할 입력을 먼저 채워 주세요 — ${input.message}`); return; }
    if (!spec.ok) { setError(spec.message); return; }
    if (needsFile) { setError(library ? '이 앱은 파일이 필요합니다 — 예약하려면 파일을 붙이거나 문서함에서 문서를 골라 주세요.' : '이 앱은 파일이 필요합니다 — 예약하려면 위에서 파일을 붙여 주세요.'); return; }
    if (tooMany) { setError(`예약에는 파일·문서를 합쳐 ${APP_MAX_FILES}개까지 저장할 수 있습니다.`); return; }
    setSaving(true);
    const result = await api<AppScheduleView>(editing ? `/api/apps/schedules/${encodeURIComponent(editing.id)}` : '/api/apps/schedules', { method: editing ? 'PUT' : 'POST', json: { agent_id: agentId, app_version: appVersion, inputs: values, ...(documentIds.length ? { document_ids: documentIds } : {}), ...(attachmentIds.length ? { attachment_ids: attachmentIds } : {}), ...(editing ? { file_ids: keepIds } : {}), frequency, weekday, month_day: monthDay, hour, minute, notify_on_success: notifyOnSuccess, export_hwpx: exportHwpx } });
    setSaving(false);
    if (result.ok) setSaved(result.data); else setError(result.error.message);
  }

  if (!open) return <button type="button" disabled={disabled} onClick={() => setOpen(true)} className="mt-4 text-sm font-semibold text-ws-accent-text disabled:opacity-40">이 입력으로 예약 실행 걸기</button>;
  return <fieldset disabled={disabled || saving} className="mt-4 space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
    <legend className="px-1 text-sm font-semibold">{editing ? '예약 고치기 (한국 시간)' : '예약 실행 (한국 시간)'}</legend>
    {editing && <p className="text-xs leading-5 text-slate-600">지금 입력{library ? '·고른 문서' : ''}·시각과 지금 앱 판으로 이 예약을 고칩니다. 다음 실행 시각은 저장한 때부터 다시 셉니다. {editing.status === 'paused' && editing.pausedReason === PAUSED_BY_USER ? '직접 멈춘 예약이라 고친 뒤에도 멈춰 있습니다 — 목록에서 다시 켜 주세요.' : editing.status === 'paused' ? '고쳐 저장하면 다시 켜집니다.' : ''}</p>}
    {library && <p className="text-xs leading-5 text-slate-600">{documentIds.length ? `문서함에서 고른 문서 ${documentIds.length}개를 함께 저장합니다 — 실행 때마다 그 문서의 지금 판(새 판이 시행되면 새 판)으로 읽습니다.` : '문서함에서 문서를 고르면 함께 저장됩니다.'}</p>}
    {acceptsFiles && <p className="text-xs leading-5 text-slate-600">{attachmentIds.length ? `지금 붙인 파일 ${attachmentIds.length}개를 예약에 사본으로 저장합니다 — 실행 때마다 이 파일을 새로 붙여 실행합니다(나중에 원래 파일을 고쳐도 예약은 저장한 사본을 씁니다).` : hasUploads ? '파일을 읽는 중입니다 — 읽기를 마친 파일만 예약에 저장됩니다.' : '위에서 파일을 붙이면 예약에 함께 저장됩니다.'} 파일·문서는 합쳐 {APP_MAX_FILES}개까지.</p>}
    {editing && editing.files.length > 0 && <div className="space-y-1"><p className="text-xs font-semibold text-slate-700">예약에 저장한 파일 — 체크를 풀면 저장할 때 뺍니다</p>{editing.files.map(f => <label key={f.id} className="flex items-center gap-2 text-xs text-slate-700"><input type="checkbox" aria-label={`예약 파일 ${f.name} 남기기`} checked={keepIds.includes(f.id)} onChange={e => setKeepIds(p => e.target.checked ? [...p, f.id] : p.filter(id => id !== f.id))} /><span className="break-all">{f.name}</span><span className="text-slate-400">{Math.max(1, Math.round(f.size / 1024))}KB</span></label>)}</div>}
    <p className="text-xs leading-5 text-slate-600">지금 입력한 값을 저장해 정해진 시각마다 자동으로 실행합니다. 결과는 내 앱 실행 기록에 <span className="font-semibold">[예약]</span> 제목으로 남고, 실행마다 내 사용량이 기록됩니다. 한 사람당 {APP_MAX_SCHEDULES_PER_USER}개까지.</p>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="text-sm">주기<select aria-label="예약 주기" className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2" value={frequency} onChange={e => setFrequency(e.target.value as AppScheduleFrequency)}>{(Object.keys(FREQUENCY_LABELS) as AppScheduleFrequency[]).map(f => <option key={f} value={f}>{FREQUENCY_LABELS[f]}</option>)}</select></label>
      {frequency === 'weekly' && <label className="text-sm">요일<select aria-label="요일" className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2" value={weekday} onChange={e => setWeekday(Number(e.target.value))}>{WEEKDAY_LABELS.map((label, i) => <option key={label} value={i}>{label}요일</option>)}</select></label>}
      {frequency === 'monthly' && <label className="text-sm">날<select aria-label="날" className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2" value={monthDay} onChange={e => setMonthDay(Number(e.target.value))}>{Array.from({ length: 28 }, (_, i) => i + 1).map(d => <option key={d} value={d}>{d}일</option>)}</select></label>}
      <label className="text-sm">시각<span className="mt-1 flex gap-2"><select aria-label="시" className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2" value={hour} onChange={e => setHour(Number(e.target.value))}>{Array.from({ length: 24 }, (_, i) => i).map(h => <option key={h} value={h}>{String(h).padStart(2, '0')}시</option>)}</select><select aria-label="분" className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2" value={minute} onChange={e => setMinute(Number(e.target.value) === 30 ? 30 : 0)}><option value={0}>00분</option><option value={30}>30분</option></select></span></label>
    </div>
    <label className="flex items-start gap-2 text-xs leading-5 text-slate-700"><input type="checkbox" className="mt-0.5" checked={notifyOnSuccess} onChange={e => setNotifyOnSuccess(e.target.checked)} /><span>실행을 마치면 메일로 알림 받기 — 앱·시각과 결과 보기 링크만 보냅니다(결과 글은 메일에 싣지 않음). 실패·멈춤 메일은 이 칸과 상관없이 갑니다.</span></label>
    <label className="flex items-start gap-2 text-xs leading-5 text-slate-700"><input type="checkbox" className="mt-0.5" checked={exportHwpx} onChange={e => setExportHwpx(e.target.checked)} /><span>결과를 한글(HWPX) 파일로도 만들기 — 실행마다 표준 보고서 파일을 만들어 결과물 화면 '대화에서 만든 파일'에 둡니다(완료 메일을 받으면 파일 받기 단추도 붙습니다).</span></label>
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" onClick={() => void save()} className="rounded-xl bg-ws-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{saving ? '저장 중…' : editing ? '예약 고치기 저장' : `${spec.ok ? describeSchedule(spec.value) : '예약'}에 실행 예약`}</button>
      {editing ? <Link href="/apps/schedules" className="text-sm text-slate-500">예약 목록으로</Link> : <button type="button" onClick={() => setOpen(false)} className="text-sm text-slate-500">닫기</button>}
    </div>
    {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
    {saved && <p role="status" className="text-xs text-teal-800">{editing ? '예약을 고쳤습니다' : '예약했습니다'} — {saved.description}{saved.status === 'paused' ? '(멈춰 있음)' : ''}, 다음 실행 {new Date(saved.nextRunAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}. <Link href="/apps/schedules" className="font-semibold underline">앱 예약 목록</Link></p>}
  </fieldset>;
}
