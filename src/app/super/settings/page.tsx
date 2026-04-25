'use client';

import { useState, useEffect, useCallback } from 'react';

type Tab = 'basic' | 'maintenance' | 'security';

// ═══════════════════════════════════════════════════════════
export default function SettingsPage() {
  const [tab, setTab]   = useState<Tab>('basic');
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [loading, setLoading]   = useState(true);
  const [toast, setToast]       = useState<string | null>(null);

  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(null), 3000); };

  const loadSettings = useCallback(async () => {
    setLoading(true);
    const res = await fetch('/api/super/settings');
    const d   = await res.json();
    if (d.ok) {
      const map: Record<string, string> = {};
      for (const item of d.data) map[item.key] = item.value;
      setSettings(map);
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadSettings(); }, [loadSettings]);

  const saveSetting = async (key: string, value: string) => {
    const res = await fetch('/api/super/settings', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value }),
    });
    const d = await res.json();
    if (d.ok) { setSettings(s => ({ ...s, [key]: value })); showToast('✅ 저장됐습니다.'); }
    else showToast('❌ ' + d.error);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">시스템 설정</h1>
        <p className="text-slate-400 text-sm mt-1">서비스 전반의 설정을 관리합니다.</p>
      </div>

      <div className="flex gap-1 border-b border-slate-700/50">
        {([['basic','기본 설정'],['maintenance','점검 모드'],['security','슈퍼관리자 보안']] as [Tab,string][]).map(([k,l]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-4 py-2.5 text-sm font-semibold rounded-t-lg transition-colors border-b-2 ${
              tab === k ? 'border-[#7C3AED] text-[#A78BFA] bg-[#7C3AED]/10' : 'border-transparent text-slate-500 hover:text-slate-300'
            }`}>
            {l}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="w-6 h-6 border-2 border-[#7C3AED]/30 border-t-[#7C3AED] rounded-full animate-spin"/>
        </div>
      ) : (
        <>
          {tab === 'basic'       && <BasicTab settings={settings} onSave={saveSetting} />}
          {tab === 'maintenance' && <MaintenanceTab settings={settings} onSave={saveSetting} onToast={showToast} />}
          {tab === 'security'    && <SecurityTab settings={settings} onSave={saveSetting} />}
        </>
      )}

      {toast && (
        <div className="fixed bottom-6 right-6 px-5 py-3 bg-[#1E293B] border border-slate-600 text-white text-sm font-semibold rounded-xl shadow-lg z-50">{toast}</div>
      )}
    </div>
  );
}

// ─── 인라인 편집 행 ──────────────────────────────────────
function SettingRow({ label, settingKey, value, type = 'text', options, onSave }: {
  label: string; settingKey: string; value: string;
  type?: 'text' | 'number' | 'select' | 'textarea';
  options?: { value: string; label: string }[];
  onSave: (key: string, value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal]         = useState(value);

  useEffect(() => setVal(value), [value]);

  return (
    <div className="flex items-start gap-4 py-4 border-b border-slate-700/30 last:border-0">
      <div className="w-48 flex-shrink-0 pt-2.5">
        <p className="text-sm font-medium text-slate-300">{label}</p>
      </div>
      <div className="flex-1 flex items-start gap-3">
        {editing ? (
          <>
            {type === 'select' && options ? (
              <select value={val} onChange={e => setVal(e.target.value)}
                className="flex-1 px-4 py-2.5 bg-[#0F172A] border border-slate-700 rounded-xl text-sm text-white focus:outline-none focus:border-[#7C3AED]">
                {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) : type === 'textarea' ? (
              <textarea value={val} onChange={e => setVal(e.target.value)} rows={3}
                className="flex-1 px-4 py-2.5 bg-[#0F172A] border border-slate-700 rounded-xl text-sm text-white focus:outline-none focus:border-[#7C3AED] resize-none"/>
            ) : (
              <input type={type} value={val} onChange={e => setVal(e.target.value)}
                className="flex-1 px-4 py-2.5 bg-[#0F172A] border border-slate-700 rounded-xl text-sm text-white focus:outline-none focus:border-[#7C3AED]"/>
            )}
            <button onClick={() => { onSave(settingKey, val); setEditing(false); }}
              className="px-4 py-2.5 bg-[#7C3AED] hover:bg-[#6D28D9] text-white text-xs font-semibold rounded-xl transition-colors">저장</button>
            <button onClick={() => { setVal(value); setEditing(false); }}
              className="px-4 py-2.5 border border-slate-700 text-slate-400 text-xs rounded-xl hover:text-white transition-colors">취소</button>
          </>
        ) : (
          <>
            <p className="flex-1 text-sm text-slate-200 px-4 py-2.5 bg-[#0F172A] rounded-xl border border-slate-800 truncate">{val || '(미설정)'}</p>
            <button onClick={() => setEditing(true)}
              className="px-4 py-2.5 bg-slate-700 hover:bg-slate-600 text-white text-xs font-medium rounded-xl transition-colors">수정</button>
          </>
        )}
      </div>
    </div>
  );
}

// ─── 기본 설정 탭 ────────────────────────────────────────
function BasicTab({ settings, onSave }: { settings: Record<string, string>; onSave: (k: string, v: string) => void }) {
  return (
    <div className="bg-[#1E293B] border border-slate-700/50 rounded-2xl px-6 py-4 space-y-0 divide-y divide-slate-700/30">
      <SettingRow label="서비스명" settingKey="service_name" value={settings.service_name ?? ''} onSave={onSave} />
      <SettingRow label="서비스 URL" settingKey="service_url" value={settings.service_url ?? ''} onSave={onSave} />
      <SettingRow label="신규 기관 기본 플랜" settingKey="new_org_default_plan" value={settings.new_org_default_plan ?? 'trial'}
        type="select" options={['trial','basic','pro','enterprise'].map(k => ({ value: k, label: k.charAt(0).toUpperCase()+k.slice(1) }))} onSave={onSave} />
      <SettingRow label="세션 유지 시간 (시간)" settingKey="session_timeout_hours" value={settings.session_timeout_hours ?? '24'} type="number" onSave={onSave} />
      <SettingRow label="최대 파일 크기 (MB)" settingKey="max_file_size_mb" value={settings.max_file_size_mb ?? '50'} type="number" onSave={onSave} />
      <SettingRow label="고객지원 이메일" settingKey="support_email" value={settings.support_email ?? ''} onSave={onSave} />
    </div>
  );
}

// ─── 점검 모드 탭 ────────────────────────────────────────
function MaintenanceTab({ settings, onSave, onToast }: {
  settings: Record<string, string>;
  onSave: (k: string, v: string) => void;
  onToast: (m: string) => void;
}) {
  const isOn = settings.maintenance_mode === 'true';
  const [showConfirm, setShowConfirm] = useState(false);
  const [msg, setMsg] = useState(settings.maintenance_message ?? '');

  useEffect(() => setMsg(settings.maintenance_message ?? ''), [settings.maintenance_message]);

  const handleToggle = () => {
    if (!isOn) setShowConfirm(true);
    else { onSave('maintenance_mode', 'false'); onToast('점검 모드가 해제됐습니다.'); }
  };

  return (
    <div className="space-y-5">
      {/* 현재 상태 */}
      <div className={`p-5 rounded-2xl border flex items-center gap-4 ${isOn ? 'bg-red-950/30 border-red-700/40' : 'bg-emerald-950/20 border-emerald-700/30'}`}>
        <span className="text-3xl">{isOn ? '🔴' : '🟢'}</span>
        <div>
          <p className="font-bold text-white">{isOn ? '점검 모드 활성화' : '정상 운영 중'}</p>
          <p className="text-xs text-slate-400 mt-0.5">{isOn ? '슈퍼관리자를 제외한 모든 접속이 차단됩니다.' : '모든 사용자가 정상 접속 가능합니다.'}</p>
        </div>
        <div className="ml-auto">
          <button onClick={handleToggle}
            className={`w-16 h-8 rounded-full transition-colors relative ${isOn ? 'bg-red-600' : 'bg-slate-700'}`}>
            <div className={`w-6 h-6 bg-white rounded-full absolute top-1 transition-transform ${isOn ? 'translate-x-9' : 'translate-x-1'}`}/>
          </button>
        </div>
      </div>

      {/* 점검 안내 메시지 */}
      <div className="bg-[#1E293B] border border-slate-700/50 rounded-2xl p-5 space-y-3">
        <label className="block text-sm font-semibold text-white">점검 안내 메시지</label>
        <textarea value={msg} onChange={e => setMsg(e.target.value)} rows={3}
          className="w-full px-4 py-3 bg-[#0F172A] border border-slate-700 rounded-xl text-sm text-white focus:outline-none focus:border-[#7C3AED] resize-none"/>
        <button onClick={() => onSave('maintenance_message', msg)}
          className="px-5 py-2.5 bg-[#7C3AED] hover:bg-[#6D28D9] text-white text-sm font-semibold rounded-xl transition-colors">
          메시지 저장
        </button>
      </div>

      {/* 확인 모달 */}
      {showConfirm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4">
          <div className="bg-[#1E293B] border border-red-700/40 rounded-2xl p-6 w-full max-w-sm space-y-4">
            <h3 className="text-base font-bold text-red-400">⚠️ 점검 모드 활성화</h3>
            <p className="text-sm text-slate-300">
              점검 모드를 활성화하면 슈퍼관리자를 제외한 모든 사용자의 접속이 차단됩니다.<br/>계속하시겠습니까?
            </p>
            <div className="flex gap-3">
              <button onClick={() => setShowConfirm(false)}
                className="flex-1 py-2.5 border border-slate-700 rounded-xl text-sm text-slate-400 hover:text-white">취소</button>
              <button onClick={() => { onSave('maintenance_mode', 'true'); setShowConfirm(false); onToast('점검 모드가 활성화됐습니다.'); }}
                className="flex-1 py-2.5 bg-red-600 hover:bg-red-700 text-white font-semibold rounded-xl text-sm">확인</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── 보안 설정 탭 ────────────────────────────────────────
function SecurityTab({ settings, onSave }: { settings: Record<string, string>; onSave: (k: string, v: string) => void }) {
  const [logs, setLogs] = useState<any[]>([]);
  const [myIp, setMyIp] = useState('—');

  useEffect(() => {
    // 슈퍼관리자 최근 활동 로그
    fetch('/api/super/logs?limit=20').then(r => r.json()).then(d => { if (d.ok) setLogs(d.data); }).catch(() => {});
    // 내 IP (공개 API)
    fetch('https://api.ipify.org?format=json').then(r => r.json()).then(d => setMyIp(d.ip ?? '—')).catch(() => {});
  }, []);

  return (
    <div className="space-y-5">
      <div className="bg-[#1E293B] border border-slate-700/50 rounded-2xl px-6 py-4 divide-y divide-slate-700/30">
        <SettingRow label="로그인 실패 허용 횟수" settingKey="max_login_attempts"
          value={settings.max_login_attempts ?? '5'} type="number" onSave={onSave} />
        <div className="py-4">
          <p className="text-xs text-slate-500 mb-1">현재 내 IP: <span className="text-white font-mono">{myIp}</span></p>
          <SettingRow label="허용 IP 목록" settingKey="allowed_ips"
            value={settings.allowed_ips ?? '0.0.0.0/0'} type="textarea" onSave={onSave} />
        </div>
      </div>

      {/* 최근 로그인 이력 */}
      <div className="bg-[#1E293B] border border-slate-700/50 rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-700/50">
          <h3 className="text-sm font-bold text-white">최근 슈퍼관리자 활동 이력</h3>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-700/50">
              {['작업','대상','IP','일시'].map(h => (
                <th key={h} className="px-5 py-2.5 text-left text-xs font-semibold text-slate-500">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700/30">
            {logs.length === 0 ? (
              <tr><td colSpan={4} className="px-5 py-8 text-center text-slate-500">이력이 없습니다.</td></tr>
            ) : (
              logs.map((l, i) => (
                <tr key={i} className="hover:bg-slate-700/20 transition-colors">
                  <td className="px-5 py-2.5 text-slate-300">{l.action}</td>
                  <td className="px-5 py-2.5 text-slate-500 text-xs">{l.target_type ?? '—'}</td>
                  <td className="px-5 py-2.5 text-slate-500 text-xs font-mono">{l.ip_address ?? '—'}</td>
                  <td className="px-5 py-2.5 text-slate-500 text-xs">{new Date(l.created_at).toLocaleString('ko-KR')}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
