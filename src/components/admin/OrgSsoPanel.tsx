'use client';

import { useEffect, useState } from 'react';
import { requestJson, serverErrorText } from '@/lib/ok-json';
import { useInFlight } from '@/lib/use-in-flight';
import { SSO_DEFAULT_LABEL, SSO_LABEL_MAX, SSO_MAX_DOMAINS, type SsoConfigView } from '@/lib/org-sso-spec';

type Loaded = { config: SsoConfigView | null; redirectUri: string; loginPath: string | null; canManage: boolean };

/**
 * 기관 SSO(OIDC, 2026-11-25, 0107) — 기관 전체 관리자가 계정 서비스(Entra ID·Google Workspace·Keycloak·사내 SSO)를 적어 켜면
 * 기관 전용 로그인 화면에 '기관 계정으로 로그인' 단추가 생긴다. 계정은 만들지 않는다 — 같은 이메일로 이미 등록된 직원만 들어온다
 */
export default function OrgSsoPanel() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [unread, setUnread] = useState(false);
  const [issuer, setIssuer] = useState('');
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [domains, setDomains] = useState('');
  const [label, setLabel] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [ssoOnly, setSsoOnly] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const saving = useInFlight();

  const fill = (data: Loaded) => {
    setLoaded(data);
    const c = data.config;
    setIssuer(c?.issuer ?? '');
    setClientId(c?.clientId ?? '');
    setDomains((c?.emailDomains ?? []).join(', '));
    setLabel(c && c.buttonLabel !== SSO_DEFAULT_LABEL ? c.buttonLabel : '');
    setEnabled(c?.enabled ?? false);
    setSsoOnly(c?.ssoOnly ?? false);
    setSecret('');
  };

  useEffect(() => {
    void requestJson('/api/admin/sso').then((r) => {
      // 권한이 없어 거절된 것(401·403)은 칸을 보이지 않는다 — 못 읽은 것만 알린다
      if (!r.ok) { if (r.status !== 401 && r.status !== 403) setUnread(true); return; }
      fill((r.body as { data: Loaded }).data);
    });
  }, []);

  if (unread) {
    return (
      <section className="mt-6 rounded-2xl border border-slate-100 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">기관 계정 로그인(SSO)</h2>
        <p role="alert" className="mt-2 text-sm text-amber-700">지금 설정을 불러오지 못했습니다. 화면을 새로 고쳐 주세요.</p>
      </section>
    );
  }
  if (!loaded) return null;

  const save = () => saving.run('save', async () => {
    setMsg(null);
    const r = await requestJson('/api/admin/sso', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issuer, clientId, clientSecret: secret || undefined, emailDomains: domains, buttonLabel: label, enabled, ssoOnly: enabled && ssoOnly }),
    });
    if (!r.ok) { setMsg({ ok: false, text: serverErrorText(r.body, 'SSO 설정을 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.') }); return; }
    fill({ ...loaded, config: (r.body as { data: { config: SsoConfigView } }).data.config });
    setMsg({ ok: true, text: !enabled ? '저장했습니다(꺼짐).' : enabled && ssoOnly ? '저장했습니다. 직원은 이제 기관 계정으로만 로그인하고, 비밀번호로 들어와 있던 직원 로그인은 곧 끝납니다.' : '저장했습니다. 기관 로그인 화면에 단추가 보입니다.' });
  });

  const disabled = !loaded.canManage || saving.running !== null;
  const field = 'mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50';
  return (
    <section className="mt-6 rounded-2xl border border-slate-100 bg-white p-6 shadow-sm">
      <h2 className="text-base font-semibold text-slate-900">기관 계정 로그인(SSO)</h2>
      <p className="mt-1 text-sm leading-6 text-slate-600">
        기관이 쓰는 계정 서비스(Microsoft Entra ID·Google Workspace·Keycloak 등 OpenID Connect)로 로그인합니다. 켜면 기관 로그인 화면{loaded.loginPath ? <> (<code>{loaded.loginPath}</code>)</> : ''}에 단추가 생기고,
        아래 &apos;직원은 기관 계정으로만&apos;을 고르지 않으면 비밀번호 로그인도 그대로 됩니다. <b>계정을 새로 만들지 않습니다</b> — 계정 서비스의 이메일과 같은 이메일로 이 기관에 이미 등록된 직원만 들어옵니다.
      </p>
      <div className="mt-3 rounded-lg bg-slate-50 p-3 text-xs leading-5 text-slate-600">
        계정 서비스에 앱(클라이언트)을 만들 때 돌아올 주소(Redirect URI)로 <code className="break-all">{loaded.redirectUri}</code> 을 등록하세요. 권한 범위는 <code>openid email profile</code>, 인증 방식은 클라이언트 비밀값(POST)입니다.
      </div>
      {!loaded.canManage && <p className="mt-3 text-sm text-slate-500">기관 전체 관리자(최상위 부서 소속)만 바꿀 수 있습니다{loaded.config ? '' : ' — 아직 설정이 없습니다'}.</p>}
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <label className="text-sm text-slate-700">발급자(issuer) 주소
          <input value={issuer} onChange={(e) => setIssuer(e.target.value)} disabled={disabled} placeholder="https://login.microsoftonline.com/{테넌트 ID}/v2.0" className={field} />
        </label>
        <label className="text-sm text-slate-700">클라이언트 ID
          <input value={clientId} onChange={(e) => setClientId(e.target.value)} disabled={disabled} className={field} />
        </label>
        <label className="text-sm text-slate-700">클라이언트 비밀값 {loaded.config?.hasSecret && <span className="text-xs text-slate-500">(저장돼 있음 — 바꿀 때만 적기)</span>}
          <input type="password" autoComplete="new-password" value={secret} onChange={(e) => setSecret(e.target.value)} disabled={disabled} className={field} />
        </label>
        <label className="text-sm text-slate-700">허용 이메일 도메인(선택, {SSO_MAX_DOMAINS}개까지)
          <input value={domains} onChange={(e) => setDomains(e.target.value)} disabled={disabled} placeholder="예: agency.go.kr" className={field} />
        </label>
        <label className="text-sm text-slate-700">단추 글(선택, {SSO_LABEL_MAX}자)
          <input value={label} maxLength={SSO_LABEL_MAX} onChange={(e) => setLabel(e.target.value)} disabled={disabled} placeholder={SSO_DEFAULT_LABEL} className={field} />
        </label>
        <label className="flex items-center gap-2 self-end text-sm text-slate-700">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={disabled} />
          켜기 — 켤 때 발급자 주소의 OIDC 문서를 실제로 읽어 봅니다
        </label>
      </div>
      {/* SSO 전용(0109) — 켜진 SSO에만. 관리자는 비밀번호도 된다(계정 서비스 장애 때 설정을 고칠 사람이 남게) */}
      <label className="mt-3 flex items-start gap-2 text-sm text-slate-700">
        <input type="checkbox" className="mt-1" checked={enabled && ssoOnly} onChange={(e) => setSsoOnly(e.target.checked)} disabled={disabled || !enabled} />
        <span>
          직원은 기관 계정으로만 로그인(직원 비밀번호 로그인 끄기)
          <span className="block text-xs leading-5 text-slate-500">
            켜면 직원은 이메일·비밀번호로 로그인할 수 없고, 비밀번호로 들어와 있던 직원 로그인은 1분 안에 끝납니다. 기관 관리자는 계정 서비스가 고장 났을 때 설정을 고칠 수 있게 비밀번호 로그인을 그대로 씁니다.
            먼저 관리자 한 명이 기관 계정 로그인으로 실제로 들어와 보고 켜세요.
          </span>
        </span>
      </label>
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={`mt-3 text-sm ${msg.ok ? 'text-emerald-700' : 'text-red-600'}`}>{msg.text}</p>}
      {loaded.canManage && (
        <button type="button" disabled={disabled || !issuer.trim() || !clientId.trim()} onClick={() => void save()}
          className="mt-4 rounded-lg bg-[#003087] px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">{saving.running ? '저장 중…' : '저장'}</button>
      )}
    </section>
  );
}
