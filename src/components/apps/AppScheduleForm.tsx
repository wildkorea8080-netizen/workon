'use client';
import { useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/work/client';
import { renderAppInput, type AppDefinition } from '@/lib/apps/definition';
import {
  APP_MAX_SCHEDULES_PER_USER, FREQUENCY_LABELS, WEEKDAY_LABELS, describeSchedule, parseScheduleSpec,
  type AppScheduleFrequency, type AppScheduleView,
} from '@/lib/apps/schedule-spec';

/**
 * 실행 화면 아래 '이 입력으로 예약' — 지금 폼의 입력값을 저장해 정해진 시각(한국 시간)에 자동 실행한다.
 * 올린 파일은 예약할 수 없다(첨부는 한 대화에 묶이고 서명 주소가 짧다). 문서함에서 고른 문서는 함께 저장되고, 실행 때마다 그 문서의
 * 지금 판으로 읽는다(0062). 파일이 필수인 앱은 문서를 골랐을 때만 예약할 수 있다. 검사는 서버가 다시 한다
 */
export default function AppScheduleForm({ agentId, appVersion, definition, values, documentIds = [], hasUploads = false, disabled = false }: {
  agentId: string; appVersion: number; definition: AppDefinition; values: Record<string, string>;
  /** 문서함에서 고른 문서 */
  documentIds?: string[];
  /** 올린 파일이 있는가 — 예약에는 실리지 않는다고 알린다 */
  hasUploads?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [frequency, setFrequency] = useState<AppScheduleFrequency>('weekdays');
  const [weekday, setWeekday] = useState(1); const [monthDay, setMonthDay] = useState(1);
  const [hour, setHour] = useState(9); const [minute, setMinute] = useState<0 | 30>(0);
  const [saving, setSaving] = useState(false); const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<AppScheduleView | null>(null);
  const library = definition.attachments?.library === true;
  const filesRequired = Boolean(definition.attachments?.required) && !library;
  const needsDocument = Boolean(definition.attachments?.required) && library && documentIds.length === 0;
  const spec = parseScheduleSpec({ frequency, weekday, month_day: monthDay, hour, minute });

  async function save() {
    setError(null); setSaved(null);
    const input = renderAppInput(definition, values);
    if (!input.ok) { setError(`예약할 입력을 먼저 채워 주세요 — ${input.message}`); return; }
    if (!spec.ok) { setError(spec.message); return; }
    if (needsDocument) { setError('이 앱은 파일이 필요합니다 — 예약하려면 문서함에서 문서를 골라 주세요(올린 파일은 예약에 쓸 수 없습니다).'); return; }
    setSaving(true);
    const result = await api<AppScheduleView>('/api/apps/schedules', { method: 'POST', json: { agent_id: agentId, app_version: appVersion, inputs: values, ...(documentIds.length ? { document_ids: documentIds } : {}), frequency, weekday, month_day: monthDay, hour, minute } });
    setSaving(false);
    if (result.ok) setSaved(result.data); else setError(result.error.message);
  }

  if (filesRequired) return <p className="mt-4 text-xs leading-5 text-slate-500">이 앱은 파일 첨부가 필수라 예약 실행을 걸 수 없습니다.</p>;
  if (!open) return <button type="button" disabled={disabled} onClick={() => setOpen(true)} className="mt-4 text-sm font-semibold text-[#087581] disabled:opacity-40">이 입력으로 예약 실행 걸기</button>;
  return <fieldset disabled={disabled || saving} className="mt-4 space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
    <legend className="px-1 text-sm font-semibold">예약 실행 (한국 시간)</legend>
    {library && <p className="text-xs leading-5 text-slate-600">{documentIds.length ? `문서함에서 고른 문서 ${documentIds.length}개를 함께 저장합니다 — 실행 때마다 그 문서의 지금 판(새 판이 시행되면 새 판)으로 읽습니다.` : '문서함에서 문서를 고르면 함께 저장됩니다.'}{hasUploads ? ' 올린 파일은 예약에 실리지 않습니다.' : ''}</p>}
    <p className="text-xs leading-5 text-slate-600">지금 입력한 값을 저장해 정해진 시각마다 자동으로 실행합니다. 결과는 내 앱 실행 기록에 <span className="font-semibold">[예약]</span> 제목으로 남고, 실행마다 내 사용량이 기록됩니다. 한 사람당 {APP_MAX_SCHEDULES_PER_USER}개까지.</p>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="text-sm">주기<select aria-label="예약 주기" className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2" value={frequency} onChange={e => setFrequency(e.target.value as AppScheduleFrequency)}>{(Object.keys(FREQUENCY_LABELS) as AppScheduleFrequency[]).map(f => <option key={f} value={f}>{FREQUENCY_LABELS[f]}</option>)}</select></label>
      {frequency === 'weekly' && <label className="text-sm">요일<select aria-label="요일" className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2" value={weekday} onChange={e => setWeekday(Number(e.target.value))}>{WEEKDAY_LABELS.map((label, i) => <option key={label} value={i}>{label}요일</option>)}</select></label>}
      {frequency === 'monthly' && <label className="text-sm">날<select aria-label="날" className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2" value={monthDay} onChange={e => setMonthDay(Number(e.target.value))}>{Array.from({ length: 28 }, (_, i) => i + 1).map(d => <option key={d} value={d}>{d}일</option>)}</select></label>}
      <label className="text-sm">시각<span className="mt-1 flex gap-2"><select aria-label="시" className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2" value={hour} onChange={e => setHour(Number(e.target.value))}>{Array.from({ length: 24 }, (_, i) => i).map(h => <option key={h} value={h}>{String(h).padStart(2, '0')}시</option>)}</select><select aria-label="분" className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2" value={minute} onChange={e => setMinute(Number(e.target.value) === 30 ? 30 : 0)}><option value={0}>00분</option><option value={30}>30분</option></select></span></label>
    </div>
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" onClick={() => void save()} className="rounded-xl bg-[#087f8c] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{saving ? '저장 중…' : `${spec.ok ? describeSchedule(spec.value) : '예약'}에 실행 예약`}</button>
      <button type="button" onClick={() => setOpen(false)} className="text-sm text-slate-500">닫기</button>
    </div>
    {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
    {saved && <p role="status" className="text-xs text-teal-800">예약했습니다 — {saved.description}, 다음 실행 {new Date(saved.nextRunAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}. <Link href="/apps/schedules" className="font-semibold underline">앱 예약 목록</Link></p>}
  </fieldset>;
}
