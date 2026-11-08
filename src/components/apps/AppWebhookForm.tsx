'use client';
import { useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/work/client';
import type { AppDefinition } from '@/lib/apps/definition';
import {
  APP_MAX_WEBHOOKS_PER_USER, WEBHOOK_DAILY_LIMIT, WEBHOOK_EXPIRY_DAYS, WEBHOOK_MAX_FILES, WEBHOOK_MIN_INTERVAL_SECONDS, webhookCurlExample,
  type AppWebhookView, type WebhookExpiryDays,
} from '@/lib/apps/webhook-spec';

/**
 * 실행 화면 아래 '외부 시스템 연동 만들기' — 연동 토큰을 만들어 외부 시스템이 입력값을 보내 이 앱을 실행하게 한다.
 * 토큰은 만든 직후 한 번만 보인다(서버는 해시만 둔다). 결과 글은 외부로 돌려주지 않고 내 앱 실행 기록에 남는다.
 * 파일을 받는 앱은 외부 시스템이 호출마다 파일을 함께 보낼 수 있다(본문 `files`, 2026-11-08)
 */
export default function AppWebhookForm({ agentId, appVersion, definition, documentIds = [], disabled = false }: {
  agentId: string; appVersion: number; definition: AppDefinition;
  /** 문서함에서 고른 문서 — 연동에 함께 저장한다(0063). 올린 파일은 외부 시스템이 호출마다 보낸다 */
  documentIds?: string[];
  disabled?: boolean;
}) {
  const library = definition.attachments?.library === true;
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(''); const [expiry, setExpiry] = useState<WebhookExpiryDays>(90);
  const [saving, setSaving] = useState(false); const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ webhook: AppWebhookView; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const sampleInputs = Object.fromEntries(definition.fields.map(f => [f.key, f.type === 'select' ? (f.options?.[0] ?? '') : f.type === 'number' ? '0' : f.type === 'date' ? '2026-01-01' : `${f.label} 내용`]));
  const acceptsFiles = Boolean(definition.attachments);
  const example = created ? webhookCurlExample(typeof window === 'undefined' ? '' : window.location.origin, created.token, sampleInputs, acceptsFiles) : '';

  async function save() {
    setError(null);
    setSaving(true);
    const result = await api<{ webhook: AppWebhookView; token: string }>('/api/apps/webhooks', { method: 'POST', json: { agent_id: agentId, app_version: appVersion, name, expiry_days: expiry, ...(documentIds.length ? { document_ids: documentIds } : {}) } });
    setSaving(false);
    if (result.ok) setCreated(result.data); else setError(result.error.message);
  }
  async function copy() {
    try { await navigator.clipboard.writeText(created?.token ?? ''); setCopied(true); } catch { setCopied(false); }
  }

  if (!open) return <button type="button" disabled={disabled} onClick={() => setOpen(true)} className="mt-2 block text-sm font-semibold text-ws-accent-text disabled:opacity-40">외부 시스템 연동(Webhook) 만들기</button>;
  if (created) return <div className="mt-4 space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
    <p className="text-sm font-semibold text-amber-900">연동 토큰 — 지금 한 번만 보입니다. 안전한 곳에 옮겨 두세요.</p>
    <code className="block break-all rounded-lg bg-white p-3 text-xs">{created.token}</code>
    <button type="button" onClick={() => void copy()} className="rounded-xl border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold text-amber-900">{copied ? '복사했습니다' : '토큰 복사'}</button>
    <p className="text-xs leading-5 text-amber-900">외부 시스템은 아래처럼 부릅니다. 입력 키는 이 앱의 항목 키이고, 응답에는 상태와 대화 번호만 옵니다(결과 글은 내 앱 실행 기록에서 봅니다). 같은 연동은 {WEBHOOK_MIN_INTERVAL_SECONDS}초에 한 번, 하루 {WEBHOOK_DAILY_LIMIT}번까지 실행합니다.</p>
    <pre className="overflow-x-auto whitespace-pre rounded-lg bg-white p-3 text-[11px] leading-5">{example}</pre>
    <p className="text-xs text-amber-900">{created.webhook.name} · {new Date(created.webhook.expiresAt).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' })}까지 · <Link href="/apps/webhooks" className="font-semibold underline">앱 연동 목록</Link>에서 회수할 수 있습니다.</p>
  </div>;
  return <fieldset disabled={disabled || saving} className="mt-4 space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
    <legend className="px-1 text-sm font-semibold">외부 시스템 연동(Webhook)</legend>
    <p className="text-xs leading-5 text-slate-600">연동 토큰을 가진 외부 시스템이 입력값을 보내면 <span className="font-semibold">내 권한과 사용량으로</span> 이 앱을 실행합니다. 결과는 내 앱 실행 기록에 <span className="font-semibold">[연동]</span> 제목으로 남고 외부로는 돌려주지 않습니다. 토큰이 새면 누구나 내 이름으로 실행할 수 있으니 회수 방법을 알아 두세요. 한 사람당 {APP_MAX_WEBHOOKS_PER_USER}개까지.</p>
    {library && <p className="text-xs leading-5 text-slate-600">{documentIds.length ? `문서함에서 고른 문서 ${documentIds.length}개를 연동에 함께 저장합니다 — 호출마다 그 문서의 지금 판(새 판이 시행되면 새 판)으로 읽습니다.` : '문서함에서 문서를 고르면 연동에 함께 저장됩니다.'}</p>}
    {acceptsFiles && <p className="text-xs leading-5 text-slate-600">외부 시스템은 호출마다 파일을 함께 보낼 수 있습니다(본문 <code>files</code> — 이름과 base64 내용, {WEBHOOK_MAX_FILES}개·합계 3MB까지{library ? ', 고른 문서와 합쳐 3개' : ''}). 보낸 파일은 그 실행의 대화에 첨부로 남습니다.{definition.attachments?.required ? ' 이 앱은 파일이 필요해 파일·문서 없이 부르면 거절됩니다.' : ''}</p>}
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="text-sm">연동 이름<input aria-label="연동 이름" value={name} maxLength={40} onChange={e => setName(e.target.value)} placeholder="예: 민원 접수 시스템" className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2" /></label>
      <label className="text-sm">유효 기간<select aria-label="유효 기간" value={expiry} onChange={e => setExpiry(Number(e.target.value) as WebhookExpiryDays)} className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2">{WEBHOOK_EXPIRY_DAYS.map(d => <option key={d} value={d}>{d}일</option>)}</select></label>
    </div>
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" onClick={() => void save()} className="rounded-xl bg-ws-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{saving ? '만드는 중…' : '연동 토큰 만들기'}</button>
      <button type="button" onClick={() => setOpen(false)} className="text-sm text-slate-500">닫기</button>
    </div>
    {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
  </fieldset>;
}
