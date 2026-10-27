'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * 기관 관리자 — 업무 관리. 업무 비서 켜고 끄기 · 기관 업무 양식(등록·시험 생성·한글 확인 기록·사용 중지) · 업무 현황(숫자만).
 * 직원 작업의 원문·파일은 보이지 않는다.
 */
interface Installation { key: string; name: string; implemented: boolean; status: 'preparing' | 'available' | 'disabled' }
interface AdminTemplate {
  id: string;
  name: string;
  fileName: string;
  format: string;
  source: string;
  status: string;
  label: string;
  slots: { label: string; kind: string }[];
  createdAt: string;
  fit: { key: string; name: string; missing: string[] }[];
}
interface ChatTemplate { id: string; name: string; fileName: string; agentName: string; imported: boolean }
interface Overview { workflow_key: string; name: string; tasks: number; completed: number; needs_review: number; failed_runs_30d: number; top_error: string | null }

async function call<T>(url: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  try {
    const res = await fetch(url, init);
    const body = await res.json().catch(() => null);
    if (body?.ok) return { ok: true, data: body.data as T };
    return { ok: false, message: body?.error?.message ?? '요청을 처리하지 못했습니다.' };
  } catch {
    return { ok: false, message: '네트워크 오류가 발생했습니다.' };
  }
}

const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export default function WorkAdmin() {
  const [installs, setInstalls] = useState<Installation[] | null>(null);
  const [templates, setTemplates] = useState<AdminTemplate[]>([]);
  const [chat, setChat] = useState<ChatTemplate[]>([]);
  const [overview, setOverview] = useState<Overview[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [attestFor, setAttestFor] = useState<string | null>(null);
  const [attestNote, setAttestNote] = useState('');

  const load = useCallback(async () => {
    const [i, t, o] = await Promise.all([call<Installation[]>('/api/admin/work-installations'), call<{ templates: AdminTemplate[]; chatTemplates: ChatTemplate[] }>('/api/admin/work-templates'), call<Overview[]>('/api/admin/work-overview')]);
    if (!i.ok) return setError(i.message);
    setInstalls(i.data);
    if (t.ok) {
      setTemplates(t.data.templates);
      setChat(t.data.chatTemplates);
    }
    if (o.ok) setOverview(o.data);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function run(p: Promise<{ ok: true; data: unknown } | { ok: false; message: string }>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const r = await p;
    setBusy(false);
    if (!r.ok) return setError(r.message);
    setNotice(done);
    await load();
  }

  async function upload(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return setError('양식 파일을 골라 주세요.');
    const fd = new FormData();
    fd.set('file', file);
    fd.set('name', name || file.name.replace(/\.[^.]+$/, ''));
    await run(call('/api/admin/work-templates', { method: 'POST', body: fd }), '등록하고 시험 생성까지 마쳤습니다(패키지 검사 — 한글 확인은 아래에서 기록).');
    setFile(null);
    setName('');
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">업무 관리</h1>
        <p className="mt-1 text-sm text-gray-600">업무 비서 사용 여부, 기관 업무 양식, 업무 현황을 관리합니다. 직원 작업의 내용·파일은 여기서 보이지 않습니다.</p>
      </div>
      {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</p>}
      {notice && <p role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">{notice}</p>}

      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <h2 className="text-lg font-semibold">업무 비서 사용</h2>
        <p className="mt-1 text-sm text-gray-600">끄면 직원이 그 업무로 새 작업을 시작할 수 없습니다. 이미 만든 작업과 파일은 그대로 열립니다.</p>
        <ul className="mt-3 divide-y divide-gray-100">
          {installs?.map((w) => (
            <li key={w.key} className="flex items-center justify-between py-2 text-sm">
              <span>{w.name}</span>
              {!w.implemented ? (
                <span className="text-gray-400">준비 중</span>
              ) : (
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={w.status === 'available'} disabled={busy} onChange={(e) => run(call('/api/admin/work-installations', json('PATCH', { key: w.key, enabled: e.target.checked })), `${w.name}: ${e.target.checked ? '사용' : '사용 안 함'}으로 바꿨습니다.`)} />
                  {w.status === 'available' ? '사용' : '사용 안 함'}
                </label>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <h2 className="text-lg font-semibold">기관 업무 양식</h2>
        <p className="mt-1 text-sm text-gray-600">
          HWPX·DOCX(4MB까지). 올리면 채울 자리를 찾고 자리마다 시험 글을 넣어 파일을 만들어 검사합니다(패키지 검사). 한글에서 열어 본 확인은 관리자가 직접 기록하며, 자동 검증으로 표시하지 않습니다.
        </p>
        <form onSubmit={upload} className="mt-3 flex flex-wrap items-end gap-2 text-sm">
          <label className="flex flex-col">
            <span className="text-gray-700">양식 이름</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} className="mt-1 rounded border border-gray-300 px-2 py-1.5" placeholder="예: 우리 기관 결과보고서" />
          </label>
          <label className="flex flex-col">
            <span className="text-gray-700">파일</span>
            <input type="file" accept=".hwpx,.docx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="mt-1" />
          </label>
          <button type="submit" disabled={busy || !file} className="rounded bg-[#003087] px-4 py-2 font-semibold text-white disabled:bg-gray-300">
            등록·시험 생성
          </button>
        </form>
        {chat.filter((c) => !c.imported).length > 0 && (
          <div className="mt-4 text-sm">
            <p className="font-medium">대화 비서에 올린 기관 양식에서 가져오기</p>
            <ul className="mt-1 space-y-1">
              {chat.filter((c) => !c.imported).map((c) => (
                <li key={c.id} className="flex items-center justify-between rounded border border-gray-100 px-2 py-1">
                  <span>{c.name} <span className="text-gray-500">({c.agentName} · {c.fileName})</span></span>
                  <button disabled={busy} onClick={() => run(call('/api/admin/work-templates', json('POST', { agentTemplateId: c.id })), `${c.name}을(를) 업무 양식으로 가져왔습니다.`)} className="text-[#003087] underline">가져오기</button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <ul className="mt-4 space-y-3">
          {templates.length === 0 && <li className="text-sm text-gray-500">등록한 기관 업무 양식이 없습니다. 표준 양식은 그대로 쓸 수 있습니다.</li>}
          {templates.map((t) => (
            <li key={t.id} className={`rounded-lg border px-3 py-2 text-sm ${t.status === 'retired' ? 'border-gray-100 bg-gray-50 text-gray-500' : 'border-gray-200'}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{t.name}</span>
                <span className="text-xs text-gray-500">{t.fileName}</span>
                <span className="rounded bg-gray-100 px-2 py-0.5 text-xs">{t.label}</span>
              </div>
              <div className="mt-1 text-xs text-gray-600">채울 자리 {t.slots.length}곳: {t.slots.slice(0, 12).map((s) => s.label).join(', ')}{t.slots.length > 12 ? ' …' : ''}</div>
              <div className="mt-1 text-xs text-gray-600">
                {t.fit.map((f) => (
                  <span key={f.key} className="mr-3">{f.name}: {f.missing.length ? <span className="text-amber-700">필요한 칸 없음({f.missing.join(', ')})</span> : <span className="text-emerald-700">쓸 수 있음</span>}</span>
                ))}
              </div>
              {t.status !== 'retired' && (
                <div className="mt-2 flex flex-wrap gap-3 text-xs">
                  <button disabled={busy} onClick={() => run(call(`/api/admin/work-templates/${t.id}`, json('PATCH', { action: 'test' })), '시험 생성을 다시 했습니다.')} className="text-[#003087] underline">시험 생성 다시</button>
                  {t.status === 'mapped' && <button disabled={busy} onClick={() => { setAttestFor(t.id); setAttestNote(''); }} className="text-[#003087] underline">한글에서 확인함 기록</button>}
                  <button disabled={busy} onClick={() => run(call(`/api/admin/work-templates/${t.id}`, json('PATCH', { action: 'retire' })), '사용 중지했습니다. 이 양식으로 만든 작업은 그대로입니다.')} className="text-red-700 underline">사용 중지</button>
                </div>
              )}
              {attestFor === t.id && (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  <label htmlFor={`att-${t.id}`}>무엇을 확인했나요?</label>
                  <input id={`att-${t.id}`} value={attestNote} onChange={(e) => setAttestNote(e.target.value)} maxLength={300} className="min-w-[260px] rounded border border-gray-300 px-2 py-1" placeholder="예: 한글 2022에서 시험 파일을 열어 쪽 배치·글꼴 확인" />
                  <button disabled={busy} onClick={() => run(call(`/api/admin/work-templates/${t.id}`, json('PATCH', { action: 'attest', note: attestNote })), '관리자 확인을 기록했습니다.').then(() => setAttestFor(null))} className="rounded bg-[#003087] px-2 py-1 text-white">기록</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <h2 className="text-lg font-semibold">업무 현황</h2>
        <p className="mt-1 text-sm text-gray-600">업무별 건수와 최근 30일 실패한 실행입니다(내용·파일 없음).</p>
        {overview.length === 0 ? (
          <p className="mt-2 text-sm text-gray-500">아직 업무 작업이 없습니다.</p>
        ) : (
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="border-b text-left text-gray-600">
                <th scope="col" className="py-1.5">업무</th>
                <th scope="col" className="py-1.5 text-right">작업</th>
                <th scope="col" className="py-1.5 text-right">완료</th>
                <th scope="col" className="py-1.5 text-right">검토 대기</th>
                <th scope="col" className="py-1.5 text-right">실패(30일)</th>
                <th scope="col" className="py-1.5">많은 실패</th>
              </tr>
            </thead>
            <tbody>
              {overview.map((o) => (
                <tr key={o.workflow_key} className="border-b border-gray-50">
                  <td className="py-1.5">{o.name}</td>
                  <td className="py-1.5 text-right">{o.tasks}</td>
                  <td className="py-1.5 text-right">{o.completed}</td>
                  <td className="py-1.5 text-right">{o.needs_review}</td>
                  <td className={`py-1.5 text-right ${o.failed_runs_30d ? 'text-red-700' : ''}`}>{o.failed_runs_30d}</td>
                  <td className="py-1.5 text-gray-600">{o.top_error ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
