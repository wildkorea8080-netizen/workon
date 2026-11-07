'use client';
import { useCallback, useEffect, useState } from 'react';
import type { PresetStatusItem } from '@/lib/preset-install-admin';

/** 아직 없는 것만 설치할 수 있다 */
export function missingPresets(items: PresetStatusItem[]): PresetStatusItem[] {
  return items.filter((i) => !i.installed);
}

/** 사람이 고치지 않았는데 지금 세트와 내용이 다른 것만 갱신할 수 있다 */
export function outdatedPresets(items: PresetStatusItem[]): PresetStatusItem[] {
  return items.filter((i) => i.state === 'outdated');
}

export function installSummary(data: { installed: string[]; skipped: string[]; failed: string[] }): string {
  const parts = [`${data.installed.length}개를 설치했습니다`];
  if (data.skipped.length) parts.push(`이미 있는 ${data.skipped.length}개는 건너뛰었습니다`);
  if (data.failed.length) parts.push(`설치하지 못함: ${data.failed.join(', ')}`);
  return parts.join(' · ');
}

export function updateSummary(data: { updated: string[]; skipped: string[]; failed: string[] }): string {
  const parts = [`${data.updated.length}개를 새 내용으로 바꿨습니다`];
  if (data.skipped.length) parts.push(`바꿀 필요가 없거나 바꾸지 않는 ${data.skipped.length}개는 건너뛰었습니다`);
  if (data.failed.length) parts.push(`바꾸지 못함: ${data.failed.join(', ')} — 그 사이 다른 분이 고쳤을 수 있습니다`);
  return parts.join(' · ');
}

type Mode = 'install' | 'update';

/**
 * 기본 비서·앱 세트(2026-11-07) — 이 기관에 아직 없는 기본 비서·입력형 앱을 골라 설치하고,
 * 사람이 고치지 않았는데 지금 세트와 내용이 다른 것은 새 내용으로 바꾼다(판으로 남는다 — 되돌리기는 비서 편집 창의 변경 기록).
 * 설치·갱신은 기관 전체 관리자만(서버가 다시 본다). 관리자가 고친 비서는 바꾸지 않는다
 */
export default function PresetSetPanel() {
  const [items, setItems] = useState<PresetStatusItem[] | null>(null);
  const [canInstall, setCanInstall] = useState(false);
  const [chosen, setChosen] = useState<Record<Mode, Set<string>>>({ install: new Set(), update: new Set() });
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
  const outdated = outdatedPresets(items);
  const edited = items.filter((i) => i.state === 'edited').length;
  const toggle = (mode: Mode, name: string) => setChosen((prev) => {
    const next = new Set(prev[mode]); if (next.has(name)) next.delete(name); else next.add(name);
    return { ...prev, [mode]: next };
  });

  const run = async (mode: Mode) => {
    const names = [...chosen[mode]];
    if (!names.length) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      const res = await fetch('/api/admin/preset-agents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ names, mode }) });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) throw new Error(body?.error?.message ?? (mode === 'install' ? '설치하지 못했습니다.' : '바꾸지 못했습니다.'));
      setMessage(`${mode === 'install' ? installSummary(body.data) : updateSummary(body.data)}. 공식 비서 목록은 새로 고침하면 보입니다.`);
      setChosen((prev) => ({ ...prev, [mode]: new Set() }));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '처리하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };

  const summary = [
    missing.length ? `아직 없는 기본 비서·앱 ${missing.length}개` : null,
    outdated.length ? `새 내용으로 바꿀 수 있는 것 ${outdated.length}개` : null,
  ].filter(Boolean).join(' · ');

  const group = (mode: Mode, list: PresetStatusItem[], title: string, action: string, note: string) => (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold text-slate-700">{title}</h3>
      <ul className="space-y-2">
        {list.map((item) => (
          <li key={item.name}>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" aria-label={`${item.name} ${mode === 'install' ? '설치' : '갱신'}`} disabled={!canInstall || busy} checked={chosen[mode].has(item.name)} onChange={() => toggle(mode, item.name)} className="mt-1" />
              <span>
                <span className="font-medium text-slate-800">{item.icon} {item.name}</span>
                <span className="ml-2 text-xs text-slate-500">{item.kind === 'form' ? '입력형 앱' : 'AI 비서'} · {item.category}</span>
                <span className="block text-xs text-slate-500">{item.description}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      {canInstall && (
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => void run(mode)} disabled={!chosen[mode].size || busy} className="rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">{busy ? '처리 중…' : `고른 ${chosen[mode].size}개 ${action}`}</button>
          <button type="button" onClick={() => setChosen((prev) => ({ ...prev, [mode]: new Set(list.map((m) => m.name)) }))} disabled={busy} className="text-xs text-brand-700">모두 고르기</button>
          <span className="text-xs text-slate-500">{note}</span>
        </div>
      )}
    </div>
  );

  return (
    <section aria-label="기본 비서·앱 세트" className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">기본 비서·앱 세트</h2>
          <p className="mt-1 text-xs text-slate-500">{summary ? `${summary}가 있습니다.` : '기본 세트가 모두 설치되어 있고 최신입니다.'}</p>
        </div>
        {(missing.length > 0 || outdated.length > 0) && <button type="button" className="text-xs font-semibold text-brand-700" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? '접기' : '살펴보기'}</button>}
      </div>
      {open && (
        <div className="mt-3 space-y-4">
          {missing.length > 0 && group('install', missing, '아직 없는 것', '설치', '설치한 비서·앱은 기관 전체에 바로 공개됩니다. 필요 없으면 공식 비서 목록에서 노출을 끄세요.')}
          {outdated.length > 0 && group('update', outdated, '새 내용으로 바꿀 수 있는 것', '갱신', '설명·지시문·입력 폼만 바꿉니다(노출·공개 범위·정렬은 그대로). 바꾸기 전 내용은 비서 편집 창의 변경 기록에 남습니다.')}
          {edited > 0 && <p className="text-xs text-slate-500">관리자가 고친 기본 비서 {edited}개는 고친 내용을 지키려고 바꾸지 않습니다.</p>}
          {!canInstall && <p className="text-xs text-slate-500">설치·갱신은 기관 전체를 관리하는 관리자(최상위 부서 소속)만 할 수 있습니다.</p>}
        </div>
      )}
      {message && <p role="status" className="mt-3 text-xs text-slate-600">{message}</p>}
      {error && <p role="alert" className="mt-3 text-xs text-red-600">{error}</p>}
    </section>
  );
}
