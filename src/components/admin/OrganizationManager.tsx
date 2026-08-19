'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

interface ModelInfo {
  id: string;
  label: string;
  provider: string;
  inputPerMTok: number;
  outputPerMTok: number;
}

interface OrgInfo {
  id: string;
  name: string;
  slug: string | null;
  logo_url: string | null;
  ai_notice: string | null;
  domain: string | null;
  type: string | null;
  allowed_models: string[] | null;
  /** 정책을 거쳐 실제로 적용 중인 목록. 저장값과 다를 수 있다. */
  effectiveModels: string[];
  availableModels: ModelInfo[];
}

interface BudgetInfo {
  billingType: string | null;
  allowed: boolean;
  reason: string | null;
  usedTokens: number;
  limitTokens: number;
  budget: {
    totalKrw: number;
    usedKrw: number;
    percent: number;
    warning: boolean;
    contractEndsAt: string | null;
  } | null;
  contractEndsAt: string | null;
  daysLeft: number | null;
}

export default function OrganizationManager() {
  const [org, setOrg] = useState<OrgInfo | null>(null);
  const [budget, setBudget] = useState<BudgetInfo | null>(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [aiNotice, setAiNotice] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [logoVersion, setLogoVersion] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const [orgRes, budgetRes] = await Promise.all([
      fetch('/api/admin/organization').then((r) => r.json()),
      fetch('/api/admin/budget').then((r) => r.json()),
    ]);

    if (orgRes.ok) {
      setOrg(orgRes.data);
      setName(orgRes.data.name ?? '');
      setSlug(orgRes.data.slug ?? '');
      setAiNotice(orgRes.data.ai_notice ?? '');
      // 저장값이 아니라 정책이 확정한 목록을 보여준다. 레지스트리에서 사라진
      // 모델이 저장값에 남아 있으면 화면과 실제가 어긋난다.
      setModels(orgRes.data.effectiveModels ?? []);
    } else {
      setError(orgRes.error?.message ?? '기관 정보를 불러오지 못했습니다.');
    }
    if (budgetRes.ok) setBudget(budgetRes.data);
  }, []);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  const notify = (text: string) => {
    setMessage(text);
    setTimeout(() => setMessage(null), 4000);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/organization', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, slug, ai_notice: aiNotice, allowed_models: models }),
      });
      const result = await res.json();
      if (!result.ok) throw new Error(result.error?.message);
      setOrg(result.data);
      notify('저장했습니다.');
    } catch (err) {
      setError(err instanceof Error ? err.message : '저장에 실패했습니다.');
    } finally {
      setSaving(false);
    }
  };

  const handleLogoUpload = async (file: File) => {
    setSaving(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('logo', file);
      const res = await fetch('/api/admin/organization', { method: 'PATCH', body: form });
      const result = await res.json();
      if (!result.ok) throw new Error(result.error?.message);
      setOrg(result.data);
      // 같은 주소에 덮어쓰므로 브라우저 캐시를 우회할 값이 필요하다
      setLogoVersion((v) => v + 1);
      notify('로고를 변경했습니다.');
    } catch (err) {
      setError(err instanceof Error ? err.message : '로고 업로드에 실패했습니다.');
    } finally {
      setSaving(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleLogoRemove = async () => {
    if (!confirm('로고를 제거할까요?')) return;
    setSaving(true);
    try {
      const res = await fetch('/api/admin/organization', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logo_url: null }),
      });
      const result = await res.json();
      if (!result.ok) throw new Error(result.error?.message);
      setOrg(result.data);
      notify('로고를 제거했습니다.');
    } catch (err) {
      setError(err instanceof Error ? err.message : '제거에 실패했습니다.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <p className="text-sm text-slate-400">불러오는 중...</p>;
  }

  const input =
    'w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#003087]/20';
  const label = 'block text-xs font-medium text-slate-500 mb-1';
  const loginUrl = slug ? `${typeof window !== 'undefined' ? window.location.origin : ''}/signin/${slug}` : null;

  return (
    <section className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">기관 정보</h1>
        <p className="text-sm text-slate-500 mt-1">
          직원 화면에 표시되는 기관명과 로고입니다.
        </p>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-600">{error}</div>
      )}
      {message && (
        <div className="p-3 bg-green-50 border border-green-200 rounded-xl text-sm text-green-700">{message}</div>
      )}

      {/* ── 예산·한도 현황 ── */}
      {budget && <BudgetCard budget={budget} />}

      {/* ── 기관 정보 ── */}
      <div className="p-5 bg-white border border-slate-100 rounded-xl space-y-4">
        <div>
          <label className={label}>기관명</label>
          <input value={name} onChange={(e) => setName(e.target.value)} className={input} maxLength={60} />
          <p className="mt-1 text-[11px] text-slate-400">
            직원 화면 상단과 로그인 화면에 표시됩니다.
          </p>
        </div>

        <div>
          <label className={label}>로고</label>
          {/* 미리보기는 직원 화면의 헤더와 같은 조건으로 보여준다.
              정사각형 상자에 축소해 보여주면 실제로 어떻게 보이는지 알 수 없어
              올려보고 직원 화면까지 가서 확인하는 왕복이 생긴다. */}
          <div className="mb-3 rounded-xl border border-slate-200 overflow-hidden">
            <div className="h-16 bg-white flex items-center px-5 gap-2.5">
              {org?.logo_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`/api/branding/logo?org=${org.id}&v=${logoVersion}`}
                  alt="기관 로고"
                  className="h-12 max-w-[280px] object-contain object-left"
                />
              ) : (
                <>
                  <span className="text-2xl">🏛️</span>
                  <span className="text-slate-900 font-bold text-lg tracking-tight">
                    {org?.name ?? '기관명'}
                  </span>
                </>
              )}
            </div>
            <p className="bg-slate-50 border-t border-slate-200 px-5 py-1.5 text-[11px] text-slate-400">
              직원 화면 좌측 상단에 이렇게 보입니다
            </p>
          </div>

          <div className="flex items-center gap-4">
            <div className="space-y-2">
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/svg+xml,image/webp"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleLogoUpload(file);
                }}
                className="block text-xs text-slate-500 file:mr-3 file:px-3 file:py-1.5 file:rounded-lg file:border-0 file:bg-slate-100 file:text-slate-700 file:text-xs file:font-medium hover:file:bg-slate-200"
              />
              <p className="text-[11px] text-slate-400">
                PNG · JPG · SVG · WEBP, 500KB 미만
              </p>
              {/* 흰 헤더에 높이 40px로 얹는다. 세로형 엠블럼만 올리면 아주
                  작게 보이므로 가로형 CI(엠블럼+기관명)를 권한다. */}
              <p className="text-[11px] text-slate-400">
                높이 48px로 표시됩니다. <span className="text-slate-500">가로형 CI</span>와
                배경이 투명한 PNG·SVG를 권합니다.
              </p>
              {org?.logo_url && (
                <button
                  onClick={handleLogoRemove}
                  className="text-[11px] text-red-500 hover:underline"
                >
                  로고 제거
                </button>
              )}
            </div>
          </div>
        </div>

        <div>
          <label className={label}>기관 전용 로그인 경로</label>
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-400 whitespace-nowrap">/signin/</span>
            <input
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              placeholder="my-agency"
              className={input}
              maxLength={40}
            />
          </div>
          <p className="mt-1 text-[11px] text-slate-400">
            영문 소문자·숫자·하이픈. 직원에게 이 주소를 안내하면 기관명과 로고가 표시된 로그인 화면이 열립니다.
          </p>
          {loginUrl && (
            <p className="mt-1 text-[11px] text-[#003087] font-mono break-all">{loginUrl}</p>
          )}
        </div>

        <div>
          <label className={label}>AI 고지 문구</label>
          <textarea
            value={aiNotice}
            onChange={(e) => setAiNotice(e.target.value)}
            rows={2}
            placeholder="비워 두면 기본 문구가 표시됩니다."
            className={`${input} resize-none`}
            maxLength={200}
          />
          <p className="mt-1 text-[11px] text-slate-400">
            대화 화면 하단에 항상 표시됩니다. 생성 결과를 그대로 신뢰하면 안 된다는 안내입니다.
          </p>
        </div>

        {/* ── 허용 모델 (0021) ──
            모델을 늘리기 전에 정책을 먼저 넣는다. 순서가 반대면 정책이 붙기까지
            쌓인 사용 내역을 보안성 검토에서 설명할 수 없다. */}
        <div>
          <label className={label}>사용 허용 모델</label>
          <div className="border border-slate-200 rounded-xl divide-y divide-slate-100">
            {(org?.availableModels ?? []).map((m) => {
              const checked = models.includes(m.id);
              return (
                <label key={m.id} className="flex items-start gap-2.5 px-3 py-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) =>
                      setModels((prev) =>
                        e.target.checked ? [...prev, m.id] : prev.filter((id) => id !== m.id)
                      )
                    }
                    className="mt-0.5 w-4 h-4 rounded border-slate-300 text-[#003087] focus:ring-[#003087]"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-slate-800">{m.label}</span>
                    <span className="block text-[11px] text-slate-400">
                      {m.provider} · 100만 토큰당 입력 ${m.inputPerMTok} / 출력 ${m.outputPerMTok}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
          <p className="mt-1 text-[11px] text-slate-400">
            직원이 대화에 쓸 수 있는 모델입니다. 모두 끄면 기본 모델만 사용됩니다.
            변경 이력은 감사 대비로 기록됩니다.
          </p>
        </div>

        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={handleSave}
            disabled={saving || !name.trim()}
            className="px-4 py-2 bg-[#003087] hover:bg-[#002070] text-white text-sm font-semibold rounded-xl disabled:bg-slate-300"
          >
            {saving ? '저장 중...' : '변경하기'}
          </button>
          {org?.domain && (
            <span className="text-xs text-slate-400">
              가입 도메인 <span className="font-mono">@{org.domain}</span>
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

/** 예산·한도 현황. 계약 형태에 따라 보여줄 것이 다르다. */
function BudgetCard({ budget }: { budget: BudgetInfo }) {
  const isAnnual = budget.billingType === 'annual_fixed' && budget.budget;

  if (isAnnual && budget.budget) {
    const { totalKrw, usedKrw, percent, warning } = budget.budget;
    const blocked = !budget.allowed;
    // 소진율은 100을 넘을 수 있다. 막대는 100에서 멈추되 숫자는 그대로 보여준다.
    const barWidth = Math.min(100, Math.max(0, percent));

    return (
      <div
        className={`p-5 rounded-xl border ${
          blocked
            ? 'bg-red-50 border-red-200'
            : warning
              ? 'bg-amber-50 border-amber-200'
              : 'bg-white border-slate-100'
        }`}
      >
        <div className="flex items-baseline justify-between mb-2 flex-wrap gap-2">
          <h2 className="text-sm font-bold text-slate-800">연간 계약 예산</h2>
          <span className="text-xs text-slate-500">
            {budget.daysLeft != null ? `계약 종료까지 ${budget.daysLeft}일` : '계약 기간 미설정'}
          </span>
        </div>

        <div className="flex items-baseline gap-2 mb-2">
          <span className="text-2xl font-bold text-slate-900">
            {Math.round(usedKrw).toLocaleString()}원
          </span>
          <span className="text-sm text-slate-500">/ {Math.round(totalKrw).toLocaleString()}원</span>
          <span
            className={`ml-auto text-sm font-semibold ${
              blocked ? 'text-red-600' : warning ? 'text-amber-600' : 'text-slate-600'
            }`}
          >
            {Math.round(percent)}%
          </span>
        </div>

        <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${
              blocked ? 'bg-red-500' : warning ? 'bg-amber-500' : 'bg-[#003087]'
            }`}
            style={{ width: `${barWidth}%` }}
          />
        </div>

        {blocked && (
          <p className="mt-3 text-xs text-red-700">
            계약 금액을 모두 사용해 <strong>이용이 중단된 상태</strong>입니다. 계약 담당자에게 문의하세요.
          </p>
        )}
        {!blocked && warning && (
          <p className="mt-3 text-xs text-amber-700">
            경고 기준을 넘었습니다. 남은 기간과 소진 속도를 확인하세요.
          </p>
        )}
      </div>
    );
  }

  // 종량제 — 이번 달 토큰
  const limit = budget.limitTokens;
  const unlimited = !limit || limit <= 0;
  const percent = unlimited ? 0 : Math.round((budget.usedTokens / limit) * 100);
  const blocked = !budget.allowed;

  return (
    <div
      className={`p-5 rounded-xl border ${
        blocked ? 'bg-red-50 border-red-200' : 'bg-white border-slate-100'
      }`}
    >
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-sm font-bold text-slate-800">이번 달 사용량</h2>
        <span className="text-xs text-slate-500">종량제</span>
      </div>
      <div className="flex items-baseline gap-2 mb-2">
        <span className="text-2xl font-bold text-slate-900">{budget.usedTokens.toLocaleString()}</span>
        <span className="text-sm text-slate-500">
          {unlimited ? '토큰 (한도 없음)' : `/ ${limit.toLocaleString()} 토큰`}
        </span>
        {!unlimited && <span className="ml-auto text-sm font-semibold text-slate-600">{percent}%</span>}
      </div>
      {!unlimited && (
        <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full ${blocked ? 'bg-red-500' : 'bg-[#003087]'}`}
            style={{ width: `${Math.min(100, percent)}%` }}
          />
        </div>
      )}
      {blocked && (
        <p className="mt-3 text-xs text-red-700">
          한도를 모두 사용해 <strong>이용이 중단된 상태</strong>입니다. 관리자에게 문의하세요.
        </p>
      )}
    </div>
  );
}
