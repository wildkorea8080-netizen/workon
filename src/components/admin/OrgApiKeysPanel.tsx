'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ORG_API_DAILY_LIMIT, ORG_API_ENDPOINTS, ORG_API_EXPIRY_DAYS, ORG_API_MAX_ACTIVE_KEYS, ORG_API_NAME_MAX, ORG_API_SCOPES, ORG_API_SCOPE_LABELS,
  type OrgApiCallView, type OrgApiKeyView, type OrgApiScope,
} from '@/lib/org-api/spec';

const STATUS_LABEL: Record<OrgApiKeyView['status'], string> = { active: '쓰는 중', revoked: '회수됨', expired: '만료됨' };

const kst = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' }) : '—');

/** 호출 예시 — 화면 안내용(키 원문은 만든 직후 한 번만 보인다) */
export function curlExample(origin: string, token: string, path = ORG_API_ENDPOINTS['adoption-report'].path): string {
  return `curl -H "Authorization: Bearer ${token}" "${origin}${path}"`;
}

/**
 * 기관 통계 API 키(0075) — 기관 전체 관리자가 범위를 정해 키를 만들고 회수한다. 기관의 다른 시스템이 이 키로 도입 현황·이용통계의 **숫자만** 읽는다.
 * 기관 전체 관리자가 아니면 안내만 보인다
 */
export default function OrgApiKeysPanel() {
  const [keys, setKeys] = useState<OrgApiKeyView[]>([]);
  const [calls, setCalls] = useState<OrgApiCallView[]>([]);
  const [denied, setDenied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<OrgApiScope[]>(['adoption']);
  const [days, setDays] = useState<number>(90);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/api-keys');
      const body = await res.json().catch(() => null);
      if (res.status === 403) { setDenied(body?.error?.message ?? '기관 전체 관리자만 볼 수 있습니다.'); return; }
      if (!res.ok || !body?.ok) { setError(body?.error?.message ?? 'API 키 목록을 불러오지 못했습니다.'); return; }
      setError(null); setKeys(body.data.keys); setCalls(body.data.calls);
    } catch {
      setError('API 키 목록을 불러오지 못했습니다.');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function create() {
    if (busy || !name.trim() || !scopes.length) return;
    setBusy(true); setError(null); setCreated(null);
    try {
      const res = await fetch('/api/admin/api-keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, scopes, days }) });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) setError(body?.error?.message ?? 'API 키를 만들지 못했습니다.');
      else { setCreated({ name: body.data.key.name, token: body.data.token }); setName(''); await load(); }
    } finally { setBusy(false); }
  }

  async function revoke(key: OrgApiKeyView) {
    if (!window.confirm(`'${key.name}' 키를 회수할까요? 이 키로 부르는 시스템은 곧바로 401을 받습니다. 되돌릴 수 없습니다.`)) return;
    setError(null);
    const res = await fetch(`/api/admin/api-keys/${encodeURIComponent(key.id)}`, { method: 'DELETE' });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.ok) setError(body?.error?.message ?? 'API 키를 회수하지 못했습니다.');
    await load();
  }

  const active = keys.filter((k) => k.status === 'active').length;
  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  return (
    <section aria-label="기관 통계 API 키" className="mt-8 space-y-4 rounded-xl border border-slate-200 bg-white p-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">기관 통계 API 키</h2>
        <p className="mt-1 text-sm leading-6 text-slate-600">
          기관의 다른 시스템(경영정보 대시보드·보고 시스템)이 WORKON의 도입 현황·이용통계를 <strong>숫자만</strong> 읽어 가게 하는 키입니다.
          직원 이름·질문 원문·답변 글은 내보내지 않고, 직원별 이용통계는 API로 내지 않습니다(나만의 비서는 이름 없이 묶음).
          키 하나에 하루 {ORG_API_DAILY_LIMIT.toLocaleString('ko-KR')}번, 기관에 쓸 수 있는 키 {ORG_API_MAX_ACTIVE_KEYS}개까지입니다. 기관의 접속 허용 IP를 정해 두었다면 그 밖에서 부른 호출은 막힙니다.
        </p>
      </div>
      {denied ? <p className="text-sm text-slate-500">{denied}</p> : (
        <>
          <div className="space-y-2 rounded-lg border border-slate-200 p-4">
            <p className="text-sm font-semibold text-slate-800">새 키 만들기</p>
            <input aria-label="키 이름" value={name} maxLength={ORG_API_NAME_MAX} onChange={(e) => setName(e.target.value)} placeholder="키 이름(예: 경영정보 대시보드)" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            <div className="flex flex-wrap gap-4 text-sm text-slate-700">
              {ORG_API_SCOPES.map((s) => (
                <label key={s} className="flex items-center gap-1.5">
                  <input type="checkbox" checked={scopes.includes(s)} onChange={(e) => setScopes((cur) => (e.target.checked ? [...cur, s] : cur.filter((x) => x !== s)))} />
                  {ORG_API_SCOPE_LABELS[s]}
                </label>
              ))}
              <label className="flex items-center gap-1.5">유효 기간
                <select aria-label="유효 기간" value={days} onChange={(e) => setDays(Number(e.target.value))} className="rounded border border-slate-300 px-2 py-1">
                  {ORG_API_EXPIRY_DAYS.map((d) => <option key={d} value={d}>{d}일</option>)}
                </select>
              </label>
            </div>
            <button type="button" disabled={busy || !name.trim() || !scopes.length || active >= ORG_API_MAX_ACTIVE_KEYS} onClick={() => void create()}
              className="rounded-lg bg-[#003087] px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">{busy ? '만드는 중…' : '키 만들기'}</button>
          </div>
          {created && (
            <div role="status" className="space-y-1 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
              <p className="font-semibold text-amber-900">'{created.name}' 키를 만들었습니다 — 이 화면을 닫으면 다시 볼 수 없으니 지금 복사해 연동 시스템에 넣으세요.</p>
              <code className="block break-all rounded bg-white px-2 py-1 font-mono text-xs text-slate-800">{created.token}</code>
              <button type="button" onClick={() => void navigator.clipboard?.writeText(created.token)} className="text-xs text-slate-700 underline">복사</button>
              <p className="text-xs text-slate-600">호출 예: <code className="break-all font-mono">{curlExample(origin, created.token)}</code></p>
            </div>
          )}
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
          <div className="text-xs text-slate-600">
            <p className="font-semibold text-slate-700">부를 수 있는 주소(GET)</p>
            <ul className="mt-1 list-disc pl-5">
              {Object.values(ORG_API_ENDPOINTS).map((e) => <li key={e.path}><code className="font-mono">{e.path}</code> — {e.label} · 범위 {ORG_API_SCOPE_LABELS[e.scope]}</li>)}
            </ul>
          </div>
          <table className="w-full text-left text-xs">
            <thead className="text-slate-500"><tr><th className="py-1 pr-2">이름</th><th className="pr-2">앞부분</th><th className="pr-2">범위</th><th className="pr-2">상태</th><th className="pr-2">만료</th><th className="pr-2">마지막 호출</th><th className="pr-2">호출 수</th><th className="pr-2">만든 사람</th><th /></tr></thead>
            <tbody>
              {keys.length === 0 && <tr><td colSpan={9} className="py-2 text-slate-500">아직 만든 키가 없습니다.</td></tr>}
              {keys.map((k) => (
                <tr key={k.id} className="border-t border-slate-100">
                  <td className="py-1 pr-2 font-medium text-slate-800">{k.name}</td>
                  <td className="pr-2 font-mono">{k.tokenPrefix}…</td>
                  <td className="pr-2">{k.scopes.map((s) => ORG_API_SCOPE_LABELS[s]).join(' · ')}</td>
                  <td className="pr-2">{STATUS_LABEL[k.status]}</td>
                  <td className="pr-2">{kst(k.expiresAt)}</td>
                  <td className="pr-2">{kst(k.lastUsedAt)}</td>
                  <td className="pr-2">{k.useCount.toLocaleString('ko-KR')}</td>
                  <td className="pr-2">{k.createdByName ?? '—'}</td>
                  <td>{k.status === 'active' && <button type="button" onClick={() => void revoke(k)} className="text-red-700 underline">회수</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {calls.length > 0 && (
            <details className="text-xs text-slate-600">
              <summary className="cursor-pointer font-semibold text-slate-700">최근 호출 {calls.length}개</summary>
              <ul className="mt-1 space-y-0.5">
                {calls.map((c, i) => <li key={`${c.keyId}-${c.createdAt}-${i}`}>{kst(c.createdAt)} · {c.keyName} · {ORG_API_ENDPOINTS[c.endpoint]?.label ?? c.endpoint} · {c.httpStatus}</li>)}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}
