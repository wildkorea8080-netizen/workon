'use client';
import { useCallback, useEffect, useState } from 'react';
import type { PresetStatusItem } from '@/lib/preset-install-admin';

/** 아직 없는 것만 고를 수 있다. 고른 것만 보낸다 */
export function missingPresets(items: PresetStatusItem[]): PresetStatusItem[] {
  return items.filter((i) => !i.installed);
}

export function installSummary(data: { installed: string[]; skipped: string[]; failed: string[] }): string {
  const parts = [`${data.installed.length}개를 설치했습니다`];
  if (data.skipped.length) parts.push(`이미 있는 ${data.skipped.length}개는 건너뛰었습니다`);
  if (data.failed.length) parts.push(`설치하지 못함: ${data.failed.join(', ')}`);
  return parts.join(' · ');
}

/**
 * 기본 비서·앱 세트(2026-11-07) — 이 기관에 아직 없는 기본 비서·입력형 앱을 골라 설치한다.
 * 설치는 기관 전체 관리자만(서버가 다시 본다). 설치한 비서는 기관 전체에 공개되고 '공식 비서' 목록에 나온다
 */
export default function PresetSetPanel() {
  const [items, setItems] = useState<PresetStatusItem[] | null>(null);
  const [canInstall, setCanInstall] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/admin/preset-agents', { cache: 'no-store' });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) throw new Error(body?.error?.message ?? '기본 세트를 불러오지 못했습니다.');
      setItems(body.data.items);
      setCanInstall(Boolean(body.data.canInstall));
    } catch (e) {
      setError(e instanceof Error ? e.message : '기본 세트를 불러오지 못했습니다.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (!items) return error ? <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-600">{error}</div> : null;
  const missing = missingPresets(items);
  const toggle = (name: string) => setChosen((prev) => { const next = new Set(prev); if (next.has(name)) next.delete(name); else next.add(name); return next; });

  const install = async () => {
    if (!chosen.size) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      const res = await fetch('/api/admin/preset-agents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ names: [...chosen] }) });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) throw new Error(body?.error?.message ?? '설치하지 못했습니다.');
      setMessage(`${installSummary(body.data)}. 공식 비서 목록은 새로 고침하면 보입니다.`);
      setChosen(new Set());
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '설치하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="기본 비서·앱 세트" className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">기본 비서·앱 세트</h2>
          <p className="mt-1 text-xs text-slate-500">
            {missing.length ? `이 기관에 아직 없는 기본 비서·앱이 ${missing.length}개 있습니다.` : '기본 세트가 모두 설치되어 있습니다.'}
          </p>
        </div>
        {missing.length > 0 && <button type="button" className="text-xs font-semibold text-brand-700" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? '접기' : '살펴보기'}</button>}
      </div>
      {open && missing.length > 0 && (
        <div className="mt-3 space-y-3">
          <ul className="space-y-2">
            {missing.map((item) => (
              <li key={item.name}>
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" aria-label={`${item.name} 설치`} disabled={!canInstall || busy} checked={chosen.has(item.name)} onChange={() => toggle(item.name)} className="mt-1" />
                  <span>
                    <span className="font-medium text-slate-800">{item.icon} {item.name}</span>
                    <span className="ml-2 text-xs text-slate-500">{item.kind === 'form' ? '입력형 앱' : 'AI 비서'} · {item.category}</span>
                    <span className="block text-xs text-slate-500">{item.description}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {canInstall
            ? <div className="flex flex-wrap items-center gap-3">
                <button type="button" onClick={install} disabled={!chosen.size || busy} className="rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">{busy ? '설치 중…' : `고른 ${chosen.size}개 설치`}</button>
                <button type="button" onClick={() => setChosen(new Set(missing.map((m) => m.name)))} disabled={busy} className="text-xs text-brand-700">모두 고르기</button>
                <span className="text-xs text-slate-500">설치한 비서·앱은 기관 전체에 바로 공개됩니다. 필요 없으면 공식 비서 목록에서 노출을 끄세요.</span>
              </div>
            : <p className="text-xs text-slate-500">설치는 기관 전체를 관리하는 관리자(최상위 부서 소속)만 할 수 있습니다.</p>}
        </div>
      )}
      {message && <p role="status" className="mt-3 text-xs text-slate-600">{message}</p>}
      {error && <p role="alert" className="mt-3 text-xs text-red-600">{error}</p>}
    </section>
  );
}
