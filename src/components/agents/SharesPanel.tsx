'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchOkJson, requestJson, serverErrorText } from '@/lib/ok-json';
import { latestGate } from '@/lib/latest-request';
import { useInFlight } from '@/lib/use-in-flight';

/** 함께 쓰는 사람(0128) — 화면 꼴 */
export type ShareRow = { id: string; email: string; name: string | null; department: string | null; role?: 'viewer' | 'editor' };

/** 지금 목록 → 저장 몸(이메일·함께 고칠 사람) — 바꿀 줄만 고쳐 통째로 보낸다 */
export function sharesBody(rows: ShareRow[], change: { remove?: string; add?: string[]; editor?: { id: string; on: boolean } } = {}): { emails: string[]; editors: string[] } {
  const kept = rows.filter((r) => r.id !== change.remove).map((r) => ({ email: r.email, editor: change.editor?.id === r.id ? change.editor.on : r.role === 'editor' }));
  for (const e of change.add ?? []) if (!kept.some((k) => k.email === e)) kept.push({ email: e, editor: false });
  return { emails: kept.map((k) => k.email), editors: kept.filter((k) => k.editor).map((k) => k.email) };
}

/** 함께 쓰는 부서(0130) */
export type ShareDept = { id: string; name: string; parent_id: string | null };

export const SHARES_UNREAD = '함께 쓰는 사람을 지금 불러오지 못했습니다 — 화면을 새로 고쳐 주세요.';

/** 적은 글 → 이메일 목록(쉼표·줄바꿈·공백으로 나눔, 겹친 것은 한 번) */
export function splitShareEmails(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/[\s,;]+/)) {
    const e = part.trim().toLowerCase();
    if (e && !out.includes(e)) out.push(e);
  }
  return out;
}

/**
 * 나만의 비서 함께 쓰기(2026-11-26) — 주인이 같은 기관 동료를 이메일로 골라 함께 쓰게 하고(0128), 그중 고른 사람은 함께 고친다(0129).
 * 목록을 못 읽었으면 저장을 막는다(통째로 바꾸는 저장이라 빈 목록으로 덮으면 이미 고른 사람이 빠진다)
 */
export default function SharesPanel({ agentId }: { agentId: string }) {
  const [rows, setRows] = useState<ShareRow[] | null>(null);
  const [max, setMax] = useState(20);
  const [depts, setDepts] = useState<ShareDept[]>([]);
  const [deptChoices, setDeptChoices] = useState<ShareDept[]>([]);
  const [unread, setUnread] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const gate = useRef(latestGate());
  const { running, run } = useInFlight();

  const load = useCallback(async () => {
    const ticket = gate.current.begin();
    const body = await fetchOkJson<{ data: { shares: ShareRow[]; max: number; departments?: ShareDept[]; departmentChoices?: ShareDept[] } }>(`/api/agents/${encodeURIComponent(agentId)}/shares`);
    if (!gate.current.isLatest(ticket)) return;
    if (!body) { setUnread(true); return; }
    setUnread(false); setRows(body.data.shares); setMax(body.data.max); setDepts(body.data.departments ?? []); setDeptChoices(body.data.departmentChoices ?? []);
  }, [agentId]);
  useEffect(() => { void load(); }, [load]);

  const save = (payload: { emails?: string[]; editors?: string[]; departments?: string[] }) => run('save', async () => {
    setError(null); setNotice(null);
    const reply = await requestJson(`/api/agents/${encodeURIComponent(agentId)}/shares`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!reply.ok) { setError(serverErrorText(reply.body, '함께 쓸 사람을 저장하지 못했습니다.')); return; }
    setRows(reply.body.data.shares); setDepts(reply.body.data.departments ?? []); setDeptChoices(reply.body.data.departmentChoices ?? deptChoices); setText(''); setNotice('저장했습니다.');
  });

  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs leading-5 text-slate-500">
        같은 기관 동료를 이메일로 골라 이 비서를 함께 쓰게 합니다({max}명까지). 함께 쓰는 사람은 <strong>쓰기만</strong> 합니다 — 대화·앱 실행·예약을 할 수 있고,
        이 비서의 지시문과 문서함 문서를 근거로 한 답을 봅니다. '함께 고치기'를 켠 사람은 설정·문서·양식까지 고칩니다. 지우기·공유 바꾸기·부서 비서로 올리기·공식 신청은 만든 사람만 합니다.
      </p>
      {unread && <p role="alert" className="text-xs text-amber-700">{SHARES_UNREAD}</p>}
      {rows && (rows.length === 0 ? <p className="text-xs text-slate-500">아직 함께 쓰는 사람이 없습니다.</p> : (
        <ul className="space-y-1">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-2 rounded border border-slate-100 px-2 py-1">
              <span>{r.name ?? r.email}<span className="ml-1 text-xs text-slate-500">{r.email}{r.department ? ` · ${r.department}` : ''}</span></span>
              <span className="flex items-center gap-3">
                <label className="flex items-center gap-1 text-xs text-slate-600"><input type="checkbox" checked={r.role === 'editor'} disabled={running !== null} onChange={(e) => void save(sharesBody(rows, { editor: { id: r.id, on: e.target.checked } }))} />함께 고치기</label>
                <button type="button" disabled={running !== null} onClick={() => void save(sharesBody(rows, { remove: r.id }))} className="text-xs text-red-600 underline disabled:opacity-40">빼기</button>
              </span>
            </li>
          ))}
        </ul>
      ))}
      <label className="block text-xs font-medium text-slate-500">
        더할 동료 이메일(쉼표·줄바꿈으로 여럿)
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} disabled={!rows || running !== null} className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
      </label>
      <button type="button" disabled={!rows || running !== null || !splitShareEmails(text).length}
        onClick={() => rows && void save(sharesBody(rows, { add: splitShareEmails(text) }))}
        className="rounded-xl bg-ws-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">{running ? '저장 중…' : '함께 쓰게 하기'}</button>
      <div className="space-y-2 border-t border-slate-100 pt-3">
        <p className="text-xs font-medium text-slate-500">부서로 함께 쓰기 — 고른 부서와 그 하위 부서 사람 모두 쓰기만({max}곳까지). 고치기는 위에서 사람마다 켭니다.</p>
        {depts.length === 0 ? <p className="text-xs text-slate-500">함께 쓰는 부서가 없습니다.</p> : (
          <ul className="space-y-1">
            {depts.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-2 rounded border border-slate-100 px-2 py-1">
                <span>{d.name}</span>
                <button type="button" disabled={running !== null} onClick={() => void save({ departments: depts.filter((x) => x.id !== d.id).map((x) => x.id) })} className="text-xs text-red-600 underline disabled:opacity-40">빼기</button>
              </li>
            ))}
          </ul>
        )}
        {rows && depts.length < max && deptChoices.some((c) => !depts.some((d) => d.id === c.id)) && (
          <select aria-label="함께 쓸 부서 더하기" value="" disabled={running !== null} onChange={(e) => { if (e.target.value) void save({ departments: [...depts.map((d) => d.id), e.target.value] }); }} className="block w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">
            <option value="">+ 부서 더하기</option>
            {deptChoices.filter((c) => !depts.some((d) => d.id === c.id)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
      </div>
      {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
      {notice && <p role="status" className="text-xs text-emerald-700">{notice}</p>}
    </div>
  );
}
