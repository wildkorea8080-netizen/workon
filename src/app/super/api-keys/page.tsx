'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';

type Tab = 'system' | 'organizations';
const fmtDate = (s?: string | null) => s ? new Date(s).toLocaleDateString('ko-KR') : '—';
const fmt = (n: number) => n >= 1_000_000 ? `${(n/1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n/1_000).toFixed(0)}K` : String(n);

// ═══════════════════════════════════════════════════════════
export default function ApiKeysPage() {
  const [tab, setTab]   = useState<Tab>('system');
  const [toast, setToast] = useState<string | null>(null);
  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(null), 3000); };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">API 관리</h1>
        <p className="text-slate-400 text-sm mt-1">시스템 API 키 및 기관별 키 현황</p>
      </div>

      <div className="flex gap-1 border-b border-slate-700/50">
        {([['system','시스템 기본 키'],['organizations','기관별 키 현황']] as [Tab,string][]).map(([k,l]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-4 py-2.5 text-sm font-semibold rounded-t-lg transition-colors border-b-2 ${
              tab === k ? 'border-[#7C3AED] text-[#A78BFA] bg-[#7C3AED]/10' : 'border-transparent text-slate-500 hover:text-slate-300'
            }`}>
            {l}
          </button>
        ))}
      </div>

      {tab === 'system'        && <SystemKeysTab onToast={showToast} />}
      {tab === 'organizations' && <OrgKeysTab onToast={showToast} />}

      {toast && (
        <div className="fixed bottom-6 right-6 px-5 py-3 bg-[#7C3AED] text-white text-sm font-semibold rounded-xl shadow-lg z-50">{toast}</div>
      )}
    </div>
  );
}

// ─── 시스템 기본 키 탭 ───────────────────────────────────────
const PROVIDER_META = {
  anthropic: { icon: '🤖', label: 'Anthropic API Key',  placeholder: 'sk-ant-api03-...' },
  voyage:    { icon: '🚀', label: 'Voyage AI Key',       placeholder: 'pa-...' },
};

function SystemKeysTab({ onToast }: { onToast: (m: string) => void }) {
  const [data, setData]     = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [inputVal, setInputVal] = useState('');
  const [saving, setSaving]   = useState(false);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [verifyResult, setVerifyResult] = useState<Record<string, any>>({});

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch('/api/super/api-keys/system');
    const d   = await res.json();
    if (d.ok) setData(d.data);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSave = async (provider: string) => {
    if (!inputVal.trim()) return;
    setSaving(true);
    // 저장 전 검증
    const vr = await fetch('/api/super/api-keys/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyType: provider, keyValue: inputVal }),
    }).then(r => r.json());

    if (!vr.valid) {
      onToast(`❌ 유효하지 않은 키: ${vr.error ?? '인증 실패'}`);
      setSaving(false);
      return;
    }

    const res = await fetch('/api/super/api-keys/system', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, keyValue: inputVal }),
    });
    const d = await res.json();
    if (d.ok) { onToast('✅ 키가 저장됐습니다.'); setEditing(null); setInputVal(''); load(); }
    else onToast(d.error);
    setSaving(false);
  };

  const handleVerify = async (provider: string) => {
    setVerifying(provider);
    const res = await fetch('/api/super/api-keys/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyType: provider, keyValue: inputVal || data?.keys?.[provider]?.masked }),
    });
    const d = await res.json();
    setVerifyResult(r => ({ ...r, [provider]: d }));
    setVerifying(null);
  };

  if (loading) return (
    <div className="flex justify-center py-12">
      <div className="w-6 h-6 border-2 border-[#7C3AED]/30 border-t-[#7C3AED] rounded-full animate-spin" />
    </div>
  );

  const stats = data?.stats ?? {};

  return (
    <div className="space-y-6">
      {/* 안내 박스 */}
      <div className="flex items-start gap-3 p-4 bg-blue-950/30 border border-blue-700/30 rounded-2xl">
        <span className="text-xl flex-shrink-0">ℹ️</span>
        <div className="text-sm text-slate-300">
          <p className="font-semibold text-white mb-1">시스템 기본 키 안내</p>
          <p>자체 API 키를 설정하지 않은 기관에서 공용으로 사용됩니다.<br/>발생 비용은 운영사(WORKON)에서 부담합니다.</p>
        </div>
      </div>

      {/* 키 카드 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {(['anthropic', 'voyage'] as const).map(provider => {
          const meta    = PROVIDER_META[provider];
          const keyInfo = data?.keys?.[provider] ?? {};
          const vr      = verifyResult[provider];
          const isEdit  = editing === provider;

          return (
            <div key={provider} className="bg-[#1E293B] border border-slate-700/50 rounded-2xl p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-2xl">{meta.icon}</span>
                  <p className="text-sm font-bold text-white">{meta.label}</p>
                </div>
                {keyInfo.hasKey && !isEdit && (
                  <span className="px-2 py-0.5 bg-emerald-900/40 text-emerald-400 text-xs rounded-full">✅ 등록됨</span>
                )}
              </div>

              {/* 현재 키 표시 */}
              <div className="p-3 bg-[#0F172A] rounded-xl">
                <p className="text-xs text-slate-500 mb-1">현재 키</p>
                <code className="text-sm text-slate-300 font-mono">{keyInfo.masked ?? '(미설정)'}</code>
                {keyInfo.updatedAt && (
                  <p className="text-xs text-slate-600 mt-1">마지막 업데이트: {fmtDate(keyInfo.updatedAt)}</p>
                )}
              </div>

              {/* 검증 결과 */}
              {vr && (
                <div className={`px-3 py-2 rounded-xl text-xs font-medium ${vr.valid ? 'bg-emerald-900/30 text-emerald-400' : 'bg-red-900/30 text-red-400'}`}>
                  {vr.valid ? `✅ 유효한 키${vr.model ? ` (${vr.model})` : ''}` : `❌ ${vr.error ?? '유효하지 않은 키'}`}
                </div>
              )}

              {/* 수정 입력 */}
              {isEdit && (
                <div className="space-y-2">
                  <input value={inputVal} onChange={e => setInputVal(e.target.value)} type="password"
                    placeholder={meta.placeholder}
                    className="w-full px-4 py-3 bg-[#0F172A] border border-slate-700 rounded-xl text-sm text-white font-mono placeholder-slate-600 focus:outline-none focus:border-[#7C3AED]" />
                </div>
              )}

              {/* 버튼 */}
              <div className="flex gap-2">
                {isEdit ? (
                  <>
                    <button onClick={() => handleVerify(provider)} disabled={!inputVal || verifying === provider}
                      className="px-3 py-2 bg-slate-700 hover:bg-slate-600 text-white text-xs font-medium rounded-lg transition-colors disabled:opacity-50">
                      {verifying === provider ? '검증 중...' : '검증'}
                    </button>
                    <button onClick={() => handleSave(provider)} disabled={saving || !inputVal}
                      className="px-4 py-2 bg-[#7C3AED] hover:bg-[#6D28D9] disabled:bg-slate-700 text-white text-xs font-semibold rounded-lg transition-colors ml-auto">
                      {saving ? '저장 중...' : '저장'}
                    </button>
                    <button onClick={() => { setEditing(null); setInputVal(''); setVerifyResult(r => ({ ...r, [provider]: null })); }}
                      className="px-3 py-2 border border-slate-700 text-slate-400 text-xs rounded-lg hover:text-white transition-colors">
                      취소
                    </button>
                  </>
                ) : (
                  <>
                    <button onClick={() => { setEditing(provider); setInputVal(''); setVerifyResult(r => ({ ...r, [provider]: null })); }}
                      className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white text-xs font-semibold rounded-lg transition-colors">
                      수정
                    </button>
                    {keyInfo.hasKey && (
                      <button onClick={() => handleVerify(provider)} disabled={verifying === provider}
                        className="px-4 py-2 bg-[#7C3AED]/20 hover:bg-[#7C3AED]/40 text-violet-300 text-xs font-semibold rounded-lg transition-colors disabled:opacity-50">
                        {verifying === provider ? '검증 중...' : '검증'}
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* 이번달 사용 현황 */}
      <div className="bg-[#1E293B] border border-slate-700/50 rounded-2xl p-6">
        <h3 className="text-sm font-bold text-white mb-4">이번달 시스템 키 사용 현황</h3>
        <div className="grid grid-cols-3 gap-4">
          {[
            { label: '시스템 키 사용 기관',   value: `${stats.systemKeyOrgCount ?? 0}개` },
            { label: '총 사용 토큰',          value: fmt(stats.totalTokensThisMonth ?? 0) },
            { label: '예상 비용 (Claude+Voyage)', value: `$${stats.estimatedCostUsd ?? 0}` },
          ].map(s => (
            <div key={s.label} className="p-4 bg-[#0F172A] rounded-xl">
              <p className="text-lg font-bold text-white">{s.value}</p>
              <p className="text-xs text-slate-500 mt-0.5">{s.label}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── 기관별 키 현황 탭 ──────────────────────────────────────
function OrgKeysTab({ onToast: _ }: { onToast: (m: string) => void }) {
  const [rows, setRows]     = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch('/api/super/api-keys/organizations')
      .then(r => r.json())
      .then(d => { if (d.ok) setRows(d.data); })
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-500">
          ✅ 자체 키 &nbsp; 🔄 시스템 키 사용 중 &nbsp; ❌ 미설정
        </p>
        <p className="text-xs text-slate-500">총 {rows.length}개 기관</p>
      </div>

      <div className="bg-[#1E293B] border border-slate-700/50 rounded-2xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-700/50">
            <tr>
              {['기관명', 'Anthropic키', 'Voyage키', '자체 키', '마지막 업데이트', '이번달 호출', '관리'].map(h => (
                <th key={h} className="px-5 py-3 text-left text-xs font-semibold text-slate-500">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700/30">
            {loading ? (
              Array.from({length:3}).map((_,i) => (
                <tr key={i}>{Array.from({length:7}).map((_,j) => (
                  <td key={j} className="px-5 py-4"><div className="h-3 bg-slate-700/50 rounded animate-pulse"/></td>
                ))}</tr>
              ))
            ) : rows.length === 0 ? (
              <tr><td colSpan={7} className="px-5 py-10 text-center text-slate-500">기관이 없습니다.</td></tr>
            ) : (
              rows.map(row => (
                <tr key={row.id} className="hover:bg-slate-700/20 transition-colors">
                  <td className="px-5 py-3.5 font-semibold text-white">{row.name}</td>
                  <td className="px-5 py-3.5">
                    {row.anthropicMasked
                      ? <code className="text-xs text-slate-400 font-mono">{row.anthropicMasked}</code>
                      : <span className="text-xs text-slate-600">—</span>}
                  </td>
                  <td className="px-5 py-3.5">
                    {row.voyageMasked
                      ? <code className="text-xs text-slate-400 font-mono">{row.voyageMasked}</code>
                      : <span className="text-xs text-slate-600">—</span>}
                  </td>
                  <td className="px-5 py-3.5 text-center text-lg">
                    {row.hasOwnKey ? '✅' : '🔄'}
                  </td>
                  <td className="px-5 py-3.5 text-slate-500 text-xs">{fmtDate(row.lastUpdated)}</td>
                  <td className="px-5 py-3.5 text-slate-400">{row.callsThisMonth.toLocaleString()}회</td>
                  <td className="px-5 py-3.5">
                    <Link
                      href={`/super/organizations/${row.id}?tab=apikeys`}
                      className="px-3 py-1.5 bg-[#7C3AED]/20 hover:bg-[#7C3AED]/40 text-violet-300 text-xs font-medium rounded-lg transition-colors"
                    >
                      키 설정
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
