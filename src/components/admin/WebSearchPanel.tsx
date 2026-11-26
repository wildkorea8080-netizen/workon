'use client';

import { useEffect, useState } from 'react';
import { requestJson, serverErrorText } from '@/lib/ok-json';
import { useInFlight } from '@/lib/use-in-flight';

type View = { enabled: boolean; enabledAt: string | null; reason: string | null; canChange: boolean };

/**
 * 기관 웹 검색(2026-11-26, 0124) — 비서의 '웹 검색' 능력은 검색어를 기관 밖(Anthropic 웹 검색)으로 보낸다. 기본은 꺼짐이고
 * 기관 전체 관리자가 사유와 함께 켜고 끈다(보안 로그). 못 읽으면 '꺼짐'으로 보이지 않고 단추를 막는다
 */
export default function WebSearchPanel() {
  const [view, setView] = useState<View | null>(null);
  const [unread, setUnread] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const { running, run } = useInFlight();

  useEffect(() => {
    void requestJson('/api/admin/web-search').then((r) => {
      if (r.ok) { setView((r.body as { data: View }).data); setUnread(false); return; }
      // 권한이 없어 거절된 것(401·403)은 칸을 보이지 않는다 — 못 읽은 것만 알린다
      if (r.status !== 401 && r.status !== 403) setUnread(true);
    });
  }, []);

  if (unread) {
    return (
      <section className="mt-6 rounded-2xl border border-slate-100 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">웹 검색</h2>
        <p role="alert" className="mt-2 text-sm text-amber-700">지금 설정을 불러오지 못했습니다. 화면을 새로 고쳐 주세요.</p>
      </section>
    );
  }
  if (!view) return null;

  const change = (enabled: boolean) => run('switch', async () => {
    const question = enabled
      ? '웹 검색을 켜면 웹 검색 능력을 켠 비서가 직원의 질문에서 만든 검색어를 Anthropic 웹 검색으로 보냅니다(기관 밖). 켜는 사유를 적어 주세요(5자 이상).'
      : '웹 검색을 끄는 사유를 적어 주세요(5자 이상).';
    const reason = window.prompt(question, '');
    if (reason === null) return;
    setMsg(null);
    const r = await requestJson('/api/admin/web-search', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled, reason }) });
    if (!r.ok) { setMsg({ ok: false, text: serverErrorText(r.body, enabled ? '웹 검색을 켜지 못했습니다.' : '웹 검색을 끄지 못했습니다.') }); return; }
    setView((r.body as { data: View }).data);
    setMsg({ ok: true, text: enabled ? '웹 검색을 켰습니다.' : '웹 검색을 껐습니다.' });
  });

  return (
    <section className="mt-6 rounded-2xl border border-slate-100 bg-white p-6 shadow-sm">
      <h2 className="text-base font-semibold text-slate-900">웹 검색</h2>
      <p className="mt-1 text-sm text-slate-500">
        켜면 &lsquo;웹 검색&rsquo; 능력을 켠 비서가 최신 정보·공개 자료를 웹에서 찾아 출처와 함께 답합니다. 검색어는 기관 밖(Anthropic 웹 검색)으로 가고,
        검색 한 번에 $0.01(약 14원)이 사용량에 더해집니다. 비서마다 찾을 곳(예: go.kr)을 좁힐 수 있습니다.
      </p>
      <p className="mt-3 text-sm">
        지금: {view.enabled
          ? <strong className="text-emerald-700">켜짐</strong>
          : <strong className="text-slate-700">꺼짐</strong>}
        {view.enabled && view.enabledAt ? <span className="text-slate-500">{` · ${new Date(view.enabledAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}에 켬`}</span> : null}
        {view.enabled && view.reason ? <span className="text-slate-500">{` · 사유: ${view.reason}`}</span> : null}
      </p>
      {view.canChange ? (
        <button
          type="button"
          disabled={running !== null}
          onClick={() => change(!view.enabled)}
          className="mt-3 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {view.enabled ? '웹 검색 끄기' : '웹 검색 켜기'}
        </button>
      ) : (
        <p className="mt-3 text-xs text-slate-400">켜고 끄기는 기관 전체를 관리하는 관리자(최상위 부서 소속)만 할 수 있습니다.</p>
      )}
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={`mt-2 text-sm ${msg.ok ? 'text-emerald-700' : 'text-red-600'}`}>{msg.text}</p>}
    </section>
  );
}
