'use client';

import { useCallback, useEffect, useState } from 'react';
import AgentEditorModal from '@/components/agents/AgentEditorModal';
import PublicAskChat from '@/components/public-ask/PublicAskChat';
import { requestJson, serverErrorText } from '@/lib/ok-json';
import { useInFlight } from '@/lib/use-in-flight';
import { PUBLIC_ASK_CONTACTS_MAX, PUBLIC_ASK_FAQ_MAX, type PublicAskContact } from '@/lib/public-ask/spec';

type Settings = { enabled: boolean; enabledAt: string | null; reason: string | null; notice: string; faq: string[]; contacts: PublicAskContact[]; allowedOrigins: string[]; ipDailyCap: number; orgDailyCap: number };
type Loaded = { settings: Settings; agent: { id: string; name: string; readyDocuments: number | null } | null; slug: string | null; askUrl: string | null; embed: string | null; canManage: boolean };
type Log = { id: string; created_at: string; result: string; question: string | null; answer: string | null; sources: string[] };

const RESULT_LABELS: Record<string, string> = {
  answering: '답하는 중', answered: '답함', no_source: '근거 없음', rejected_pii: '개인정보로 거절', capped_ip: '한 사람 하루 상한', capped_org: '기관 하루 상한', unavailable: '답하지 못함',
};
const kst = (iso: string) => new Date(iso).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' });

/**
 * 관리자 '시민 상담'(2026-11-27, 0136) — 시민 전용 비서·켜고 끄기·안내·자주 묻는 질문·담당 부서 연락처·허용 홈페이지·하루 상한·붙일 코드·최근 질문.
 * 기관 전체 관리자만(서버가 다시 본다). 시민 전용 비서의 문서·지시문은 비서 편집 창에서
 */
export default function PublicAskPanel() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<Settings | null>(null);
  const [origins, setOrigins] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [logs, setLogs] = useState<{ logs: Log[]; last24h: Record<string, number> } | null>(null);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [noSourceOnly, setNoSourceOnly] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const action = useInFlight();

  const load = useCallback(async () => {
    const r = await requestJson('/api/admin/public-ask');
    if (!r.ok) { setLoadError(serverErrorText(r.body, '시민 상담 설정을 지금 불러오지 못했습니다.')); return; }
    const data = (r.body as { data: Loaded }).data;
    setLoadError(null);
    setLoaded(data);
    setForm(data.settings);
    setOrigins(data.settings.allowedOrigins.join('\n'));
  }, []);
  const loadLogs = useCallback(async (noSource: boolean) => {
    const r = await requestJson(`/api/admin/public-ask/logs${noSource ? '?noSource=1' : ''}`);
    if (!r.ok) { setLogsError(serverErrorText(r.body, '시민 상담 기록을 지금 불러오지 못했습니다.')); setLogs(null); return; }
    setLogsError(null);
    setLogs((r.body as { data: { logs: Log[]; last24h: Record<string, number> } }).data);
  }, []);
  useEffect(() => { void load(); void loadLogs(false); }, [load, loadLogs]);

  const createAgent = () => action.run('agent', async () => {
    setMsg(null);
    const r = await requestJson('/api/admin/public-ask/agent', { method: 'POST' });
    if (!r.ok) { setMsg({ ok: false, text: serverErrorText(r.body, '시민 전용 비서를 만들지 못했습니다.') }); return; }
    setMsg({ ok: true, text: '시민 전용 비서를 만들었습니다. 이제 시민에게 공개해도 되는 문서를 올려 주세요.' });
    await load();
  });

  const save = () => action.run('save', async () => {
    if (!form) return;
    setMsg(null);
    const body = { ...form, allowedOrigins: origins.split(/[\s,]+/).map((o) => o.trim()).filter(Boolean) };
    const r = await requestJson('/api/admin/public-ask', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) { setMsg({ ok: false, text: serverErrorText(r.body, '시민 상담 설정을 저장하지 못했습니다.') }); return; }
    setMsg({ ok: true, text: form.enabled ? '저장했습니다. 상담 창이 열려 있습니다.' : '저장했습니다. 상담 창은 닫혀 있습니다.' });
    await load();
  });

  async function copy(text: string, what: string) {
    try { await navigator.clipboard.writeText(text); setCopied(what); } catch { setCopied(`${what}-failed`); }
  }

  if (loadError) return <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{loadError}</p>;
  if (!loaded || !form) return <p role="status" className="text-sm text-slate-500">불러오는 중…</p>;
  const disabled = !loaded.canManage || action.running !== null;
  const set = (patch: Partial<Settings>) => setForm((f) => (f ? { ...f, ...patch } : f));

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">1. 시민 전용 비서</h2>
        <p className="mt-1 text-xs leading-5 text-slate-500">시민 질문에는 이 비서에 올린 문서(와 기관 유형의 공통 자료실)만 근거로 답합니다. 직원 화면에는 나오지 않고, 문서는 기관 전체 관리자만 올립니다. <b>시민에게 공개해도 되는 문서만</b> 올려 주세요.</p>
        {loaded.agent ? (
          <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
            <span className="font-medium text-slate-800">{loaded.agent.name}</span>
            <span className="text-slate-500">읽힌 문서 {loaded.agent.readyDocuments ?? '—'}개</span>
            <button type="button" onClick={() => setEditing(true)} disabled={!loaded.canManage} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40">지시문·문서 고치기</button>
            {loaded.agent.readyDocuments === 0 && <span className="text-xs text-amber-700">문서가 없으면 모든 질문에 '찾지 못했습니다'로 답합니다.</span>}
          </div>
        ) : (
          <button type="button" onClick={() => void createAgent()} disabled={disabled} className="mt-3 rounded-lg bg-ws-accent px-4 py-2 text-sm font-semibold text-white hover:bg-ws-accent-hover disabled:opacity-40">{action.running === 'agent' ? '만드는 중…' : '시민 전용 비서 만들기'}</button>
        )}
      </section>

      <section className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">2. 상담 창 설정</h2>
        <form className="mt-3 space-y-4 text-sm" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <label className="flex items-center gap-2 font-medium text-slate-800">
            <input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} disabled={!loaded.canManage} className="accent-ws-accent" />
            상담 창 열기 (로그인 없이 누구나 물을 수 있습니다)
          </label>
          {form.enabled && (
            <label className="block text-slate-600">여는 사유(보안 기록에 남습니다)
              <input value={form.reason ?? ''} onChange={(e) => set({ reason: e.target.value })} maxLength={300} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" placeholder="예: 체육시설 이용 문의 응대" />
            </label>
          )}
          <label className="block text-slate-600">시민에게 보일 안내 문구(500자)
            <textarea value={form.notice} onChange={(e) => set({ notice: e.target.value })} maxLength={500} rows={2} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" placeholder="예: 평일 09~18시에는 아래 담당 부서로 전화하셔도 됩니다." />
          </label>
          <div>
            <p className="text-slate-600">자주 묻는 질문 단추({PUBLIC_ASK_FAQ_MAX}개까지)</p>
            <div className="mt-1 grid gap-2 sm:grid-cols-2">
              {Array.from({ length: PUBLIC_ASK_FAQ_MAX }).map((_, i) => (
                <input key={i} value={form.faq[i] ?? ''} maxLength={60} onChange={(e) => { const faq = Array.from({ length: Math.max(form.faq.length, i + 1) }, (_, j) => form.faq[j] ?? ''); faq[i] = e.target.value; set({ faq }); }} className="rounded-lg border border-slate-200 px-3 py-2" placeholder={i === 0 ? '예: 수영장 환불은 어떻게 되나요?' : ''} />
              ))}
            </div>
          </div>
          <div>
            <p className="text-slate-600">담당 부서 연락처({PUBLIC_ASK_CONTACTS_MAX}개까지 — 답을 찾지 못하면 시민에게 보입니다)</p>
            <div className="mt-1 space-y-2">
              {[...form.contacts, ...(form.contacts.length < PUBLIC_ASK_CONTACTS_MAX ? [{ name: '', phone: '', note: '' }] : [])].map((c, i) => (
                <div key={i} className="flex flex-wrap gap-2">
                  {(['name', 'phone', 'note'] as const).map((k) => (
                    <input key={k} value={c[k]} maxLength={k === 'note' ? 100 : k === 'name' ? 40 : 30}
                      onChange={(e) => { const list = [...form.contacts]; list[i] = { ...(list[i] ?? { name: '', phone: '', note: '' }), [k]: e.target.value }; set({ contacts: list }); }}
                      placeholder={k === 'name' ? '부서(예: 체육시설팀)' : k === 'phone' ? '전화' : '안내(예: 대관·환불)'}
                      className={`rounded-lg border border-slate-200 px-3 py-2 ${k === 'note' ? 'min-w-[12rem] flex-1' : 'w-40'}`} />
                  ))}
                </div>
              ))}
            </div>
          </div>
          <label className="block text-slate-600">상담 창을 넣을 기관 홈페이지 주소(https, 줄마다 하나·5개까지 — 비우면 홈페이지에 넣지 못하고 별도 주소로만 열림)
            <textarea value={origins} onChange={(e) => setOrigins(e.target.value)} rows={2} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 font-mono text-xs" placeholder="https://www.example.or.kr" />
          </label>
          <div className="flex flex-wrap gap-4">
            <label className="text-slate-600">한 사람(인터넷 주소) 하루 질문 수
              <input type="number" min={1} max={100} value={form.ipDailyCap} onChange={(e) => set({ ipDailyCap: Number(e.target.value) })} className="ml-2 w-20 rounded-lg border border-slate-200 px-2 py-1" />
            </label>
            <label className="text-slate-600">기관 전체 하루 질문 수
              <input type="number" min={1} max={5000} value={form.orgDailyCap} onChange={(e) => set({ orgDailyCap: Number(e.target.value) })} className="ml-2 w-24 rounded-lg border border-slate-200 px-2 py-1" />
            </label>
          </div>
          <p className="text-xs text-slate-500">시민 상담에 쓴 AI 비용은 기관 예산에 들어가고 부서 월 한도에는 들어가지 않습니다. 질문 기록은 30일 동안만 보관합니다.</p>
          <button type="submit" disabled={disabled} className="rounded-lg bg-ws-accent px-4 py-2 font-semibold text-white hover:bg-ws-accent-hover disabled:opacity-40">{action.running === 'save' ? '저장 중…' : '저장'}</button>
          {msg && <p role={msg.ok ? 'status' : 'alert'} className={`text-sm ${msg.ok ? 'text-emerald-700' : 'text-red-600'}`}>{msg.text}</p>}
        </form>
      </section>

      {loaded.agent && loaded.slug && (
        <section className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm">
          <h2 className="text-base font-semibold text-slate-900">미리 물어보기</h2>
          <p className="mb-3 mt-1 text-xs leading-5 text-slate-500">창을 열기 전에 시민 화면과 같은 방식으로 답을 확인합니다(저장한 안내·자주 묻는 질문·연락처 기준). 시민 기록에는 남지 않지만 AI 사용량은 기관 예산에 들어갑니다.</p>
          <PublicAskChat slug={loaded.slug} embed endpoint="/api/admin/public-ask/test" config={{ orgName: '시민 상담 미리 보기', logoUrl: null, themeColor: null, notice: loaded.settings.notice, faq: loaded.settings.faq, contacts: loaded.settings.contacts }} />
        </section>
      )}

      <section className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">3. 상담 주소·홈페이지에 붙이기</h2>
        {loaded.askUrl ? (
          <div className="mt-3 space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <a href={loaded.askUrl} target="_blank" rel="noopener noreferrer" className="break-all font-mono text-xs text-ws-accent-text underline">{loaded.askUrl}</a>
              <button type="button" onClick={() => void copy(loaded.askUrl!, 'url')} className="whitespace-nowrap rounded border border-slate-200 px-2 py-1 text-xs">주소 복사</button>
              {copied === 'url' && <span className="text-xs text-emerald-700">복사했습니다</span>}
            </div>
            <p className="text-xs text-slate-500">아래 한 줄을 기관 홈페이지의 &lt;/body&gt; 앞에 넣으면 오른쪽 아래에 'AI 상담' 단추가 생깁니다(위에 적은 홈페이지에서만 열립니다).</p>
            <code className="block select-all break-all rounded-lg bg-slate-50 p-3 text-xs text-slate-700">{loaded.embed}</code>
            <button type="button" onClick={() => void copy(loaded.embed!, 'embed')} className="whitespace-nowrap rounded border border-slate-200 px-2 py-1 text-xs">코드 복사</button>
            {copied === 'embed' && <span className="ml-2 text-xs text-emerald-700">복사했습니다</span>}
            {copied?.endsWith('-failed') && <span className="ml-2 text-xs text-amber-700">이 브라우저에서는 복사하지 못했습니다 — 위 글을 직접 골라 복사해 주세요.</span>}
          </div>
        ) : (
          <p className="mt-2 text-sm text-amber-700">기관 로그인 경로(주소)가 없어 상담 주소를 만들 수 없습니다. 운영자에게 기관 주소를 정해 달라고 요청해 주세요.</p>
        )}
      </section>

      <section className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-slate-900">4. 최근 시민 질문(30일 보관)</h2>
          <label className="flex items-center gap-2 text-xs text-slate-600">
            <input type="checkbox" checked={noSourceOnly} onChange={(e) => { setNoSourceOnly(e.target.checked); void loadLogs(e.target.checked); }} className="accent-ws-accent" />
            근거를 찾지 못한 질문만(문서를 보강할 곳)
          </label>
        </div>
        {logsError && <p role="alert" className="mt-2 text-sm text-amber-700">{logsError}</p>}
        {logs && (
          <>
            <p className="mt-2 text-xs text-slate-500">최근 24시간: {Object.entries(logs.last24h).filter(([, n]) => n > 0).map(([k, n]) => `${RESULT_LABELS[k] ?? k} ${n}`).join(' · ') || '없음'}</p>
            {logs.logs.length === 0 ? <p className="mt-3 text-sm text-slate-500">아직 시민 질문이 없습니다.</p> : (
              <ul className="mt-3 divide-y divide-slate-100 text-sm">
                {logs.logs.map((l) => (
                  <li key={l.id} className="py-2">
                    <p className="text-xs text-slate-400">{kst(l.created_at)} · {RESULT_LABELS[l.result] ?? l.result}</p>
                    {l.question ? <p className="text-slate-800">{l.question}</p> : <p className="text-slate-400">(질문 글을 남기지 않음)</p>}
                    {l.answer && <p className="mt-1 line-clamp-2 text-xs text-slate-500">{l.answer}</p>}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      {editing && loaded.agent && <AgentEditorModal agentId={loaded.agent.id} onClose={() => { setEditing(false); void load(); }} onSaved={() => void load()} />}
    </div>
  );
}
