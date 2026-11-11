'use client';

import { useCallback, useEffect, useState } from 'react';
import { parseAdminReason, type AdminAutomationList, type AdminBatchView, type AdminScheduleView, type AdminWebhookView } from '@/lib/apps/automation-admin-spec';
import type { WebhookSwitchView } from '@/lib/apps/webhook-spec';

const kst = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ') : '—');

const WEBHOOK_STATE: Record<AdminWebhookView['state'], { label: string; className: string }> = {
  active: { label: '쓰는 중', className: 'bg-emerald-50 text-emerald-800' },
  expired: { label: '만료', className: 'bg-slate-100 text-slate-600' },
  revoked: { label: '회수함', className: 'bg-slate-100 text-slate-600' },
};

function scheduleState(s: AdminScheduleView): { label: string; className: string } {
  if (s.overdue) return { label: '실행 지연', className: 'bg-red-50 text-red-800' };
  if (s.adminPaused) return { label: '관리자가 멈춤', className: 'bg-red-50 text-red-800' };
  if (s.status === 'paused') return { label: '멈춤', className: 'bg-amber-50 text-amber-900' };
  if (s.lastStatus === 'failed') return { label: `실패 ${s.consecutiveFailures}회`, className: 'bg-amber-50 text-amber-900' };
  return { label: '예약 중', className: 'bg-emerald-50 text-emerald-800' };
}

const BATCH_STATE: Record<AdminBatchView['status'], { label: string; className: string }> = {
  running: { label: '실행 중', className: 'bg-emerald-50 text-emerald-800' },
  done: { label: '마침', className: 'bg-slate-100 text-slate-600' },
  cancelled: { label: '직원이 그만둠', className: 'bg-slate-100 text-slate-600' },
  stopped: { label: '멈춤', className: 'bg-red-50 text-red-800' },
};

/** 사유를 받는다(취소하면 null). 규칙은 서버와 같은 parseAdminReason — 서버가 다시 본다 */
function askReason(question: string): string | null {
  const raw = window.prompt(`${question}\n\n사유(5자 이상)는 보안 로그에 남고 직원 화면에도 보입니다.`);
  if (raw === null) return null;
  const parsed = parseAdminReason(raw);
  if (!parsed.ok) { window.alert(parsed.message); return null; }
  return parsed.reason;
}

const SWITCH_TEXT = {
  webhooks: {
    name: '외부 연동', subject: '외부 연동이', on: '외부 연동: 켜짐',
    offDetail: '외부 호출은 모두 거절되고 새 연동을 만들 수 없습니다. 토큰은 그대로라 다시 켜면 이어 씁니다.',
    onDetail: '보안 점검·사고 대응 때 기관의 모든 외부 호출을 한 번에 막을 수 있습니다(토큰은 회수하지 않음). 하나씩 영구히 막으려면 아래에서 회수하세요.',
  },
  schedules: {
    name: '앱 예약', subject: '앱 예약 실행이', on: '앱 예약 실행: 켜짐',
    offDetail: '예약은 실행되지 않고 다음 차례로 넘어갑니다(실패로 세지 않음). 새 예약은 만들 수 없습니다. 직원의 예약 설정은 그대로라 다시 켜면 다음 차례부터 돕니다.',
    onDetail: '비용 점검·모델 장애·사고 대응 때 기관의 모든 예약 실행을 한 번에 멈출 수 있습니다(예약은 지우지 않음). 하나씩 멈추려면 아래 목록에서 멈추세요.',
  },
} as const;

/**
 * 기관 전체 자동 실행 스위치 — 외부 연동(0068)·앱 예약(0070). 켜짐·꺼짐(끈 때·사유)을 보이고, 기관 전체를 관리하는 관리자만 끄고 켠다(서버가 다시 본다).
 * 꺼도 토큰·예약은 지우지 않는다
 */
export function OrgAutomationSwitch({ kind, view, busy, onToggle }: { kind: 'webhooks' | 'schedules'; view: WebhookSwitchView; busy: boolean; onToggle: (enable: boolean) => void }) {
  const t = SWITCH_TEXT[kind];
  return (
    <div role="group" aria-label={`기관 전체 ${t.name}`} className={`mb-4 rounded-xl border p-4 text-sm ${view.disabled ? 'border-red-200 bg-red-50 text-red-900' : 'border-slate-200 bg-white text-slate-700'}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="font-semibold">{view.disabled ? `기관 전체 ${t.subject} 꺼져 있습니다` : `기관 전체 ${t.on}`}</p>
        {view.canChange && (
          <button type="button" disabled={busy} onClick={() => onToggle(view.disabled)}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-40 ${view.disabled ? 'bg-[#003087] text-white' : 'border border-red-300 text-red-700'}`}>
            {busy ? '처리 중…' : view.disabled ? '다시 켜기' : '기관 전체 끄기'}
          </button>
        )}
      </div>
      {view.disabled
        ? <p className="mt-1 text-xs leading-5">{kst(view.disabledAt)}에 껐습니다 — {view.reason ?? '사유 없음'}. {t.offDetail}</p>
        : <p className="mt-1 text-xs leading-5 text-slate-500">{t.onDetail}</p>}
      {!view.canChange && <p className="mt-1 text-xs text-slate-500">끄고 켜기는 기관 전체를 관리하는 관리자(최상위 부서 소속)만 할 수 있습니다.</p>}
    </div>
  );
}

/** 기관 전체 외부 연동 스위치(0068) — `OrgAutomationSwitch`의 연동 쪽 */
export function OrgWebhookSwitch(props: { view: WebhookSwitchView; busy: boolean; onToggle: (enable: boolean) => void }) {
  return <OrgAutomationSwitch kind="webhooks" {...props} />;
}

/** 관리자용 앱 예약·연동 현황 — 회수·멈춤·잠금 풀기 */
export default function AppAutomationAdmin() {
  const [data, setData] = useState<AdminAutomationList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [onlyLive, setOnlyLive] = useState(true);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/admin/app-automations', { cache: 'no-store' });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) setError(body?.error?.message ?? '앱 예약·연동을 불러오지 못했습니다.');
      else setData(body.data as AdminAutomationList);
    } catch { setError('앱 예약·연동을 불러오지 못했습니다.'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function act<T>(id: string, url: string, payload: Record<string, unknown>, apply: (item: T) => void) {
    setBusy(id); setError(null);
    try {
      const res = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) setError(body?.error?.message ?? '처리하지 못했습니다.');
      else apply(body.data as T);
    } catch { setError('처리하지 못했습니다.'); }
    setBusy(null);
  }

  async function toggleOrgSwitch(kind: 'webhooks' | 'schedules', enable: boolean) {
    const reason = askReason(kind === 'webhooks'
      ? (enable
        ? '기관 전체 외부 연동(Webhook)을 다시 켤까요? 쓰는 중인 연동 토큰이 곧바로 다시 실행됩니다.'
        : '기관 전체 외부 연동(Webhook)을 끌까요? 모든 외부 호출이 거절되고 새 연동도 만들 수 없습니다. 토큰은 회수하지 않아 다시 켜면 그대로 씁니다.')
      : (enable
        ? '기관 전체 앱 예약 실행을 다시 켤까요? 켜진 예약이 다음 차례부터 다시 돕니다.'
        : '기관 전체 앱 예약 실행을 끌까요? 모든 예약이 실행되지 않고 다음 차례로 넘어가며 새 예약도 만들 수 없습니다. 예약은 지우지 않습니다.'));
    if (!reason) return;
    setBusy(`org-${kind}`); setError(null);
    try {
      const res = await fetch(`/api/admin/app-automations/${kind === 'webhooks' ? 'webhook' : 'schedule'}-switch`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: enable, reason }) });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) setError(body?.error?.message ?? '처리하지 못했습니다.');
      else setData((d) => (d ? { ...d, [kind === 'webhooks' ? 'webhookSwitch' : 'scheduleSwitch']: body.data } : d));
    } catch { setError('처리하지 못했습니다.'); }
    setBusy(null);
  }

  function revoke(w: AdminWebhookView) {
    const reason = askReason(`${w.ownerName}의 '${w.name}' 연동을 회수할까요? 이 토큰으로는 더 실행할 수 없고 되돌릴 수 없습니다.`);
    if (!reason) return;
    void act<AdminWebhookView>(w.id, `/api/admin/app-automations/webhooks/${encodeURIComponent(w.id)}`, { action: 'revoke', reason },
      (item) => setData((d) => (d ? { ...d, webhooks: d.webhooks.map((x) => (x.id === item.id ? item : x)) } : d)));
  }
  function schedule(s: AdminScheduleView, action: 'pause' | 'unlock') {
    const reason = askReason(action === 'pause'
      ? `${s.ownerName}의 '${s.appName}' 예약(${s.description})을 멈출까요? 직원은 관리자가 잠금을 풀 때까지 다시 켜지 못합니다.`
      : `${s.ownerName}의 '${s.appName}' 예약의 잠금을 풀까요? 예약은 멈춘 채로 남고 직원이 다시 켤 수 있게 됩니다.`);
    if (!reason) return;
    void act<AdminScheduleView>(s.id, `/api/admin/app-automations/schedules/${encodeURIComponent(s.id)}`, { action, reason },
      (item) => setData((d) => (d ? { ...d, schedules: d.schedules.map((x) => (x.id === item.id ? item : x)) } : d)));
  }

  async function changeBatchLimit() {
    const current = data?.batchLimit;
    if (!current) return;
    const raw = window.prompt(`일괄 실행 한 번에 실행할 최대 줄 수(1~100, 비우면 기본 100줄). 지금: ${current.maxRows ?? '기본 100'}줄. 이미 만든 일괄 실행은 그대로 돕니다.`, current.maxRows ? String(current.maxRows) : '');
    if (raw === null) return;
    const trimmed = raw.trim();
    const value = trimmed === '' ? null : Number(trimmed);
    if (value !== null && (!Number.isInteger(value) || value < 1 || value > 100)) { window.alert('1~100 사이 정수로 적어 주세요(비우면 기본 100줄).'); return; }
    const reason = askReason(`일괄 실행 상한을 ${value ?? '기본 100'}줄로 바꿀까요?`);
    if (!reason) return;
    setBusy('batch-limit'); setError(null);
    try {
      const res = await fetch('/api/admin/app-automations/batch-limit', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ max_rows: value, reason }) });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) setError(body?.error?.message ?? '처리하지 못했습니다.');
      else setData((d) => (d ? { ...d, batchLimit: body.data } : d));
    } catch { setError('처리하지 못했습니다.'); }
    setBusy(null);
  }

  function stopBatch(b: AdminBatchView) {
    const reason = askReason(`${b.ownerName}의 '${b.name}' 일괄 실행을 멈출까요? 남은 ${b.pending}줄은 실행하지 않습니다(실행 중인 줄은 끝까지 갑니다). 되돌릴 수 없습니다.`);
    if (!reason) return;
    void act<AdminBatchView>(b.id, `/api/admin/app-automations/batches/${encodeURIComponent(b.id)}`, { action: 'stop', reason },
      (item) => setData((d) => (d ? { ...d, batches: d.batches.map((x) => (x.id === item.id ? item : x)) } : d)));
  }

  if (!data) return error ? <p role="alert" className="text-sm text-red-700">{error}</p> : <p role="status" className="text-sm text-slate-500">불러오는 중…</p>;
  const webhooks = onlyLive ? data.webhooks.filter((w) => w.state === 'active') : data.webhooks;
  const schedules = onlyLive ? data.schedules.filter((s) => s.status === 'active' || s.adminPaused) : data.schedules;
  const batches = onlyLive ? (data.batches ?? []).filter((b) => b.status === 'running') : (data.batches ?? []);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={onlyLive} onChange={(e) => setOnlyLive(e.target.checked)} />
          쓰는 연동·켜진 예약·실행 중인 일괄 실행만 보기
        </label>
        <button type="button" onClick={() => void load()} className="text-sm text-[#003087]">새로고침</button>
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {data.truncated && <p className="text-xs text-amber-700">항목이 많아 최근 것만 보입니다.</p>}
      {data.runner && data.runner.problems.length > 0 && (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">
          <p className="font-semibold">예약 실행기를 확인해야 합니다</p>
          <ul className="mt-1 list-disc pl-5">{data.runner.problems.map((p) => <li key={p}>{p}</li>)}</ul>
          <p className="mt-2 text-xs text-red-800">실행기 마지막 호출: {kst(data.runner.lastRunAt)} · 서비스 운영자(슈퍼관리자)에게 알려 주세요. 하루 한 번 점검에서도 운영자에게 메일이 갑니다.</p>
        </div>
      )}
      {data.runner && !data.runner.problems.length && (
        <p className="text-xs text-slate-500">예약 실행기 {data.runner.alive ? '정상' : '소식 없음'} · 마지막 호출 {kst(data.runner.lastRunAt)}</p>
      )}

      <div>
        <h2 className="text-lg font-semibold text-slate-900">외부 시스템 연동(Webhook)</h2>
        <p className="text-sm text-slate-500 mt-0.5 mb-3">외부 시스템이 이 토큰으로 직원 권한으로 앱을 실행합니다. 퇴사·유출·용도 종료 때 회수하세요.</p>
        {data.webhookSwitch && <OrgAutomationSwitch kind="webhooks" view={data.webhookSwitch} busy={busy === 'org-webhooks'} onToggle={(enable) => void toggleOrgSwitch('webhooks', enable)} />}
        {webhooks.length ? (
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-3 py-2">연동</th><th className="px-3 py-2">앱</th><th className="px-3 py-2">직원·부서</th><th className="px-3 py-2">토큰</th>
                  <th className="px-3 py-2">상태</th><th className="px-3 py-2">만료</th><th className="px-3 py-2 text-right">실행</th><th className="px-3 py-2">마지막 실행</th><th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {webhooks.map((w) => (
                  <tr key={w.id} className="border-t border-slate-100 align-top">
                    <td className="px-3 py-2 font-medium text-slate-900">{w.name}</td>
                    <td className="px-3 py-2 text-slate-600">{w.appName}</td>
                    <td className="px-3 py-2 text-slate-600">{w.ownerName}<br /><span className="text-xs text-slate-400">{w.departmentName ?? '—'}</span></td>
                    <td className="px-3 py-2"><code className="text-xs">{w.tokenPrefix}…</code></td>
                    <td className="px-3 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs ${WEBHOOK_STATE[w.state].className}`}>{WEBHOOK_STATE[w.state].label}</span>
                      {w.revokedReason && <p className="mt-1 max-w-xs text-xs text-slate-500">{w.revokedReason}</p>}
                    </td>
                    <td className="px-3 py-2 text-slate-600 whitespace-nowrap">{kst(w.expiresAt)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{w.useCount.toLocaleString('ko-KR')}</td>
                    <td className="px-3 py-2 text-slate-600 whitespace-nowrap">{kst(w.lastUsedAt)}{w.lastStatus === 'failed' ? ' · 실패' : ''}</td>
                    <td className="px-3 py-2">{w.state === 'active' && <button type="button" disabled={busy === w.id} onClick={() => revoke(w)} className="rounded-lg border border-red-200 px-3 py-1 text-xs text-red-700 disabled:opacity-40">회수</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="text-sm text-slate-500">{onlyLive ? '쓰는 연동이 없습니다.' : '연동이 없습니다.'}</p>}
      </div>

      <div>
        <h2 className="text-lg font-semibold text-slate-900">앱 예약</h2>
        <p className="text-sm text-slate-500 mt-0.5 mb-3">직원이 저장한 입력으로 정해진 시각에 앱이 돕니다. 관리자가 멈추면 직원은 다시 켜지 못하고, 잠금을 풀면 직원이 다시 켤 수 있습니다.</p>
        {data.scheduleSwitch && <OrgAutomationSwitch kind="schedules" view={data.scheduleSwitch} busy={busy === 'org-schedules'} onToggle={(enable) => void toggleOrgSwitch('schedules', enable)} />}
        {schedules.length ? (
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-3 py-2">앱</th><th className="px-3 py-2">직원·부서</th><th className="px-3 py-2">일정</th><th className="px-3 py-2">상태</th>
                  <th className="px-3 py-2">다음 실행</th><th className="px-3 py-2 text-right">실행</th><th className="px-3 py-2">마지막 실행</th><th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {schedules.map((s) => {
                  const state = scheduleState(s);
                  return (
                    <tr key={s.id} className="border-t border-slate-100 align-top">
                      <td className="px-3 py-2 font-medium text-slate-900">{s.appName}</td>
                      <td className="px-3 py-2 text-slate-600">{s.ownerName}<br /><span className="text-xs text-slate-400">{s.departmentName ?? '—'}</span></td>
                      <td className="px-3 py-2 text-slate-600">{s.description}</td>
                      <td className="px-3 py-2">
                        <span className={`rounded-full px-2 py-0.5 text-xs ${state.className}`}>{state.label}</span>
                        {s.status === 'paused' && s.pausedReason && <p className="mt-1 max-w-xs text-xs text-slate-500">{s.pausedReason}</p>}
                      </td>
                      <td className="px-3 py-2 text-slate-600 whitespace-nowrap">{s.status === 'active' ? kst(s.nextRunAt) : '—'}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{s.runCount.toLocaleString('ko-KR')}</td>
                      <td className="px-3 py-2 text-slate-600 whitespace-nowrap">{kst(s.lastRunAt)}</td>
                      <td className="px-3 py-2">
                        {s.adminPaused
                          ? <button type="button" disabled={busy === s.id} onClick={() => schedule(s, 'unlock')} className="rounded-lg border border-slate-200 px-3 py-1 text-xs text-slate-700 disabled:opacity-40">잠금 풀기</button>
                          : <button type="button" disabled={busy === s.id} onClick={() => schedule(s, 'pause')} className="rounded-lg border border-red-200 px-3 py-1 text-xs text-red-700 disabled:opacity-40">멈추기</button>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <p className="text-sm text-slate-500">{onlyLive ? '켜진 예약이 없습니다.' : '예약이 없습니다.'}</p>}
      </div>

      <div>
        <h2 className="text-lg font-semibold text-slate-900">앱 일괄 실행</h2>
        {data.batchLimit && (
          <p className="mt-1 text-sm text-slate-700">
            기관 상한: 한 번에 <strong>{data.batchLimit.effective}줄</strong>{data.batchLimit.maxRows === null ? '(기본)' : ''}
            {data.batchLimit.canChange && <button type="button" disabled={busy === 'batch-limit'} onClick={() => void changeBatchLimit()} className="ml-2 text-xs text-[#003087] underline disabled:opacity-40">바꾸기</button>}
          </p>
        )}
        <p className="text-sm text-slate-500 mt-0.5 mb-3">직원이 여러 건(표·파일)을 한 번에 맡긴 실행입니다(최근 50개). 줄마다 AI 사용량이 듭니다. 입력·결과는 보이지 않습니다. 멈추면 남은 줄은 실행하지 않고 되돌릴 수 없습니다(직원이 새로 만듭니다).</p>
        {batches.length ? (
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-3 py-2">일괄 실행</th><th className="px-3 py-2">앱</th><th className="px-3 py-2">직원·부서</th><th className="px-3 py-2">상태</th>
                  <th className="px-3 py-2 text-right">줄</th><th className="px-3 py-2">만든 때</th><th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.id} className="border-t border-slate-100 align-top">
                    <td className="px-3 py-2 font-medium text-slate-900">{b.name}</td>
                    <td className="px-3 py-2 text-slate-600">{b.appName}</td>
                    <td className="px-3 py-2 text-slate-600">{b.ownerName}<br /><span className="text-xs text-slate-400">{b.departmentName ?? '—'}</span></td>
                    <td className="px-3 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs ${BATCH_STATE[b.status].className}`}>{BATCH_STATE[b.status].label}</span>
                      {b.stopReason && <p className="mt-1 max-w-xs text-xs text-slate-500">{b.stopReason}</p>}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">완료 {b.done}/{b.total}{b.failed ? ` · 실패 ${b.failed}` : ''}{b.skipped ? ` · 건너뜀 ${b.skipped}` : ''}</td>
                    <td className="px-3 py-2 text-slate-600 whitespace-nowrap">{kst(b.createdAt)}</td>
                    <td className="px-3 py-2">{b.status === 'running' && <button type="button" disabled={busy === b.id} onClick={() => stopBatch(b)} className="rounded-lg border border-red-200 px-3 py-1 text-xs text-red-700 disabled:opacity-40">멈추기</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="text-sm text-slate-500">{onlyLive ? '실행 중인 일괄 실행이 없습니다.' : '일괄 실행이 없습니다.'}</p>}
      </div>
    </div>
  );
}
