'use client';

import { useEffect, useState } from 'react';
import { requestJson, serverErrorText } from '@/lib/ok-json';
import { useInFlight } from '@/lib/use-in-flight';
import { LIBRARY_MAX_SHARE_FILES, LIBRARY_MAX_SHARES, LIBRARY_SHARE_MAX_DEPARTMENTS, LIBRARY_SHARE_NAME_MAX } from '@/lib/my-library-spec';

type Share = { id: string; name: string; departmentIds: string[]; files: number | null; created_at: string; includeDescendants?: boolean };
type Loaded = { shares: Share[]; departments: { id: string; name: string }[]; canManage: boolean };
type Draft = { id: string | null; name: string; departmentIds: string[]; includeDescendants: boolean };

/**
 * 공유 자료함(2026-11-25, 0116) — 기관 전체 관리자가 이름과 함께 쓸 부서를 골라 만든다. 그 부서에 지금 소속된 직원이
 * 결과물 화면·'지난 파일'에서 공유 자료함 탭으로 함께 담고 다시 붙인다('하위 부서도 함께'를 켜면 그 아래 부서 직원도 — 0132). 관리자는 누구나 본다
 */
export default function LibrarySharesPanel() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  // 목록을 못 읽은 것 — 조작 실패 글과 따로 기억한다(못 읽은 목록을 '없음'으로 보이지 않게)
  const [unread, setUnread] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const action = useInFlight();

  const load = async () => {
    const r = await requestJson('/api/admin/library-shares');
    if (!r.ok) {
      // 권한이 없어 거절된 것(401·403)은 칸을 보이지 않는다
      if (r.status === 401 || r.status === 403) setHidden(true); else { setUnread(true); setLoaded(null); }
      return;
    }
    setUnread(false);
    setLoaded((r.body as { data: Loaded }).data);
  };
  useEffect(() => { void load(); }, []);

  const save = () => action.run('save', async () => {
    if (!draft) return;
    setMsg(null);
    const body = JSON.stringify({ name: draft.name, departmentIds: draft.departmentIds, includeDescendants: draft.includeDescendants });
    const r = draft.id
      ? await requestJson(`/api/admin/library-shares/${encodeURIComponent(draft.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body })
      : await requestJson('/api/admin/library-shares', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    if (!r.ok) { setMsg({ ok: false, text: serverErrorText(r.body, '공유 자료함을 저장하지 못했습니다.') }); return; }
    setMsg({ ok: true, text: draft.id ? `'${draft.name}'을(를) 고쳤습니다.` : `'${draft.name}'을(를) 만들었습니다.` });
    setDraft(null);
    await load();
  });

  const remove = (s: Share) => action.run(`remove:${s.id}`, async () => {
    if (!window.confirm(`공유 자료함 '${s.name}'을(를) 지웁니다. 파일이 남아 있으면 지우지 않습니다.`)) return;
    setMsg(null);
    const r = await requestJson(`/api/admin/library-shares/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
    if (!r.ok) { setMsg({ ok: false, text: serverErrorText(r.body, '공유 자료함을 지우지 못했습니다.') }); return; }
    setMsg({ ok: true, text: `'${s.name}'을(를) 지웠습니다.` });
    await load();
  });

  if (hidden) return null;
  const section = 'mt-6 rounded-2xl border border-slate-100 bg-white p-6 shadow-sm';
  if (unread || !loaded) {
    return (
      <section className={section}>
        <h2 className="text-base font-semibold text-slate-900">공유 자료함</h2>
        {unread
          ? <p role="alert" className="mt-2 text-sm text-amber-700">지금 공유 자료함 목록을 불러오지 못했습니다. 화면을 새로 고쳐 주세요.</p>
          : <p role="status" className="mt-2 text-sm text-slate-500">불러오는 중…</p>}
      </section>
    );
  }
  const deptName = (id: string) => loaded.departments.find((d) => d.id === id)?.name ?? '(지금 없는 부서)';
  const busy = action.running !== null;
  const toggleDept = (id: string) => draft && setDraft({
    ...draft,
    departmentIds: draft.departmentIds.includes(id) ? draft.departmentIds.filter((d) => d !== id) : [...draft.departmentIds, id],
  });

  return (
    <section className={section}>
      <h2 className="text-base font-semibold text-slate-900">공유 자료함</h2>
      <p className="mt-1 text-xs leading-5 text-slate-500">
        여러 부서가 함께 쓰는 자료함입니다. 고른 부서에 지금 소속된 직원이 결과물 화면과 대화·입력형 앱의 ‘지난 파일’에서 함께 담고 다시 붙입니다
        (‘하위 부서도 함께’를 켜면 고른 부서 아래 부서의 직원도 함께 씁니다 — 끄면 하위 부서는 따로 골라야 합니다). 이름·폴더 바꾸기와 지우기는 담은 사람이나 관리자만 합니다. 기관마다 {LIBRARY_MAX_SHARES}개, 한 곳에 부서 {LIBRARY_SHARE_MAX_DEPARTMENTS}곳·파일 {LIBRARY_MAX_SHARE_FILES}개까지.
        부서를 빼면 그 부서 사람은 더 보지 못하고 파일은 남습니다. 파일이 남은 공유 자료함은 지우지 않습니다.
      </p>
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={`mt-3 text-sm ${msg.ok ? 'text-emerald-700' : 'text-red-600'}`}>{msg.text}</p>}
      {loaded.shares.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">아직 만든 공유 자료함이 없습니다.</p>
      ) : (
        <ul className="mt-3 divide-y divide-slate-100 text-sm">
          {loaded.shares.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <span className="font-medium text-slate-800">{s.name}</span>
                <span className="ml-2 text-xs text-slate-500">파일 {s.files === null ? '(세지 못함)' : `${s.files}개`}</span>
                <p className="text-xs text-slate-500">{s.departmentIds.length ? s.departmentIds.map(deptName).join(', ') : '(부서 없음 — 아무도 못 봅니다)'}{s.departmentIds.length && s.includeDescendants ? ' · 하위 부서 포함' : ''}</p>
              </div>
              {loaded.canManage && (
                <div className="flex gap-3 text-xs">
                  <button type="button" disabled={busy} onClick={() => { setMsg(null); setDraft({ id: s.id, name: s.name, departmentIds: s.departmentIds, includeDescendants: s.includeDescendants === true }); }} className="text-slate-600 underline disabled:opacity-40">고치기</button>
                  <button type="button" disabled={busy} onClick={() => void remove(s)} className="text-red-600 underline disabled:opacity-40">{action.running === `remove:${s.id}` ? '지우는 중…' : '지우기'}</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {loaded.canManage && !draft && loaded.shares.length < LIBRARY_MAX_SHARES && (
        <button type="button" disabled={busy} onClick={() => { setMsg(null); setDraft({ id: null, name: '', departmentIds: [], includeDescendants: false }); }}
          className="mt-3 text-sm font-medium text-ws-accent-text disabled:opacity-40">+ 공유 자료함 만들기</button>
      )}
      {!loaded.canManage && <p className="mt-3 text-xs text-slate-500">만들고 고치는 일은 기관 전체 관리자(최상위 부서 소속)만 합니다.</p>}
      {draft && (
        <form aria-label={draft.id ? '공유 자료함 고치기' : '공유 자료함 만들기'} className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-4"
          onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <label className="block text-sm text-slate-700">이름
            <input value={draft.name} maxLength={LIBRARY_SHARE_NAME_MAX} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="예: 예산 협의체"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm md:max-w-sm" />
          </label>
          <fieldset className="mt-3">
            <legend className="text-sm text-slate-700">함께 쓸 부서({draft.departmentIds.length}곳 고름)</legend>
            <div className="mt-1 flex max-h-48 flex-wrap gap-2 overflow-y-auto">
              {loaded.departments.map((d) => (
                <label key={d.id} className="flex items-center gap-1 rounded border border-slate-200 bg-white px-2 py-1 text-xs">
                  <input type="checkbox" checked={draft.departmentIds.includes(d.id)} onChange={() => toggleDept(d.id)} /> {d.name}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="mt-3 flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={draft.includeDescendants} onChange={(e) => setDraft({ ...draft, includeDescendants: e.target.checked })} />
            하위 부서도 함께 — 고른 부서 아래 부서(몇 단계든)의 직원도 쓴다
          </label>
          <div className="mt-3 flex gap-3">
            <button type="submit" disabled={busy || !draft.name.trim() || draft.departmentIds.length === 0}
              className="rounded-lg bg-ws-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">{action.running === 'save' ? '저장 중…' : '저장'}</button>
            <button type="button" disabled={busy} onClick={() => setDraft(null)} className="text-sm text-slate-600 underline disabled:opacity-40">취소</button>
          </div>
        </form>
      )}
    </section>
  );
}
