'use client';

import { useEffect, useState } from 'react';
import { requestJson, serverErrorText } from '@/lib/ok-json';
import { useInFlight } from '@/lib/use-in-flight';
import { SSO_DEFAULT_LABEL, SSO_LABEL_MAX, SSO_MAX_DOMAINS, SSO_MAX_ADMIN_GROUPS, SSO_MAX_GROUP_MAPPINGS, type SsoConfigView, type SsoGroupMapping } from '@/lib/org-sso-spec';

type Loaded = { config: SsoConfigView | null; redirectUri: string; backchannelUri?: string; loginPath: string | null; canManage: boolean; departments: { id: string; name: string }[] };

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
  const [singleLogout, setSingleLogout] = useState(false);
  const [groupClaim, setGroupClaim] = useState('');
  const [mappings, setMappings] = useState<SsoGroupMapping[]>([]);
  const [adminGroups, setAdminGroups] = useState('');
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
    setSingleLogout(c?.singleLogout ?? false);
    setGroupClaim(c?.groupClaim ?? '');
    setMappings(c?.groupMappings ?? []);
    setAdminGroups((c?.adminGroups ?? []).join('\n'));
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
      body: JSON.stringify({ issuer, clientId, clientSecret: secret || undefined, emailDomains: domains, buttonLabel: label, enabled, ssoOnly: enabled && ssoOnly, singleLogout: enabled && singleLogout, groupClaim, groupMappings: mappings, adminGroups }),
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
      {/* 함께 로그아웃(0111) — 켜진 SSO에만. 계정 서비스의 로그아웃 주소(end_session_endpoint)가 있어야 저장된다 */}
      <label className="mt-3 flex items-start gap-2 text-sm text-slate-700">
        <input type="checkbox" className="mt-1" checked={enabled && singleLogout} onChange={(e) => setSingleLogout(e.target.checked)} disabled={disabled || !enabled} />
        <span>
          로그아웃할 때 계정 서비스에서도 로그아웃
          <span className="block text-xs leading-5 text-slate-500">
            기관 계정으로 들어온 직원이 로그아웃하면 계정 서비스의 로그인도 끝내, 공용 PC에서 다음 사람이 앞사람 계정으로 들어가지 않게 합니다.
            Microsoft Entra ID는 그 브라우저의 Microsoft 365 로그인도 함께 끝냅니다.
            {loaded.loginPath && <> 계정 서비스 앱에 로그아웃 뒤 돌아올 주소로 <code className="break-all">{loaded.redirectUri.replace(/\/api\/sso\/callback$/, '')}{loaded.loginPath}</code> 을 등록하세요.</>}
          </span>
        </span>
      </label>
      {/* 계정 서비스가 먼저 로그아웃할 때(back-channel, 0114) — 설정 칸 없음, 계정 서비스 쪽에 주소만 등록 */}
      {loaded.backchannelUri && (
        <p className="mt-3 text-xs leading-5 text-slate-500">
          <b className="font-medium text-slate-700">계정 서비스에서 먼저 로그아웃할 때:</b> 계정 서비스 앱의 Back-Channel Logout 주소로 <code className="break-all">{loaded.backchannelUri}</code> 을 등록하면,
          직원이 계정 서비스에서 로그아웃하거나 그쪽 관리자가 세션을 끊을 때 기관 계정으로 들어온 WORKON 로그인도 1분 안에 끝납니다(비밀번호 로그인은 그대로).
          Keycloak처럼 이 방식(OpenID Connect Back-Channel Logout)을 지원하는 계정 서비스만 보냅니다. 로그아웃 알림에는 이메일 없이 계정 서비스의 사용자 번호만 오므로, 이 기능이 생긴 뒤 기관 계정으로 한 번 이상 로그인한 직원부터 적용됩니다.
        </p>
      )}
      {/* 그룹 → 부서 맞추기(0110) — 기관 계정으로 로그인할 때 일반 직원의 소속을 계정 서비스의 그룹에 맞춘다 */}
      <div className="mt-5 border-t border-slate-100 pt-4">
        <h3 className="text-sm font-semibold text-slate-800">계정 서비스 그룹 → 부서 맞추기(선택)</h3>
        <p className="mt-1 text-xs leading-5 text-slate-500">
          기관 계정으로 로그인할 때 id_token의 이 클레임(예: <code>groups</code>·<code>department</code>) 값 중 아래 목록에서 위에서부터 처음 맞는 부서로 <b>일반 직원</b>의 소속을 옮깁니다.
          인사 이동을 계정 서비스에서만 고치면 됩니다. 관리자의 소속은 옮기지 않고, 맞는 값이 없으면 소속을 그대로 둡니다. 계정 서비스가 그 클레임을 id_token에 넣도록 설정해야 합니다.
        </p>
        <label className="mt-2 block text-sm text-slate-700">부서를 정할 클레임 이름
          <input value={groupClaim} onChange={(e) => setGroupClaim(e.target.value)} disabled={disabled} placeholder="groups" className={field + ' md:max-w-xs'} />
        </label>
        {mappings.map((m, i) => (
          <div key={i} className="mt-2 flex flex-wrap items-center gap-2">
            <input value={m.value} aria-label={`그룹 값 ${i + 1}`} placeholder="계정 서비스의 그룹 값(이름 또는 ID)" disabled={disabled}
              onChange={(e) => setMappings(mappings.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
              className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50" />
            <span className="text-slate-400">→</span>
            <select value={m.departmentId} aria-label={`부서 ${i + 1}`} disabled={disabled}
              onChange={(e) => setMappings(mappings.map((x, j) => (j === i ? { ...x, departmentId: e.target.value } : x)))}
              className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50">
              <option value="">부서 고르기</option>
              {loaded.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              {m.departmentId && !loaded.departments.some((d) => d.id === m.departmentId) && <option value={m.departmentId}>(지금 없는 부서)</option>}
            </select>
            <button type="button" disabled={disabled} onClick={() => setMappings(mappings.filter((_, j) => j !== i))} className="text-xs text-slate-500 hover:text-red-600 disabled:opacity-40">빼기</button>
          </div>
        ))}
        {loaded.canManage && mappings.length < SSO_MAX_GROUP_MAPPINGS && (
          <button type="button" disabled={disabled} onClick={() => setMappings([...mappings, { value: '', departmentId: '' }])}
            className="mt-2 text-sm font-medium text-[#003087] disabled:opacity-40">+ 그룹 더하기</button>
        )}
      </div>
      {/* 그룹 → 관리자 역할(0115) — 같은 클레임에 이 값이 든 일반 직원을 관리자로 */}
      <div className="mt-5 border-t border-slate-100 pt-4">
        <h3 className="text-sm font-semibold text-slate-800">계정 서비스 그룹 → 관리자(선택)</h3>
        <p className="mt-1 text-xs leading-5 text-slate-500">
          위 클레임에 아래 값(줄마다 하나, {SSO_MAX_ADMIN_GROUPS}개까지) 중 하나가 든 <b>일반 직원</b>을 기관 계정으로 로그인할 때 그 소속 부서의 <b>관리자</b>로 올립니다.
          이렇게 올린 관리자가 그 그룹에서 빠진 채 다시 로그인하면 일반 직원으로 내립니다. 여기서 손으로 지정한 관리자는 그룹과 상관없이 그대로 둡니다.
          목록을 비우면 아무도 올리거나 내리지 않습니다(이미 올린 관리자는 그대로).
        </p>
        <p className="mt-1 text-xs leading-5 text-red-600">
          관리자는 그 부서와 하위 부서의 직원·문서·기록을 다룹니다(최상위 부서 소속이면 기관 전체). 계정 서비스의 이 그룹을 고칠 수 있는 사람이 곧 WORKON 관리자를 정하게 됩니다.
        </p>
        <label className="mt-2 block text-sm text-slate-700">관리자로 들일 그룹 값
          <textarea value={adminGroups} onChange={(e) => setAdminGroups(e.target.value)} disabled={disabled} rows={3} placeholder="workon-admins"
            className={field + ' font-mono'} />
        </label>
      </div>
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={`mt-3 text-sm ${msg.ok ? 'text-emerald-700' : 'text-red-600'}`}>{msg.text}</p>}
      {loaded.canManage && (
        <button type="button" disabled={disabled || !issuer.trim() || !clientId.trim()} onClick={() => void save()}
          className="mt-4 rounded-lg bg-[#003087] px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">{saving.running ? '저장 중…' : '저장'}</button>
      )}
    </section>
  );
}
