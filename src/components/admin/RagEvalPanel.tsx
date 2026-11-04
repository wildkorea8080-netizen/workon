'use client';

import { useEffect, useState } from 'react';
import type { Agent } from '@/lib/db';
import {
  RAG_EVAL_MAX_QUESTIONS, RAG_EVAL_VERDICT_LABELS, compareRagEvalRuns, parseRagEvalSet, ragEvalCsv, ragEvalSetText, scopeChangeNote,
  type RagEvalResult, type RagEvalSummary,
} from '@/lib/rag-eval';

type RunRow = { id: string; agent_id: string; agent_version: number; created_at: string; question_count: number; status: 'done' | 'partial'; summary: RagEvalSummary; results?: RagEvalResult[] };

const EXAMPLE = '질문\t기대 문서\t기대 쪽\n출장 일비는 하루 얼마인가요?\t여비 규정\t12\n연가 사용 신청은 언제까지 하나요?\t복무 규정\t\n점심 메뉴 추천해 줘\t\t';
const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);
const kst = (iso: string) => new Date(Date.parse(iso) + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');

async function call<T>(url: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  try {
    const res = await fetch(url, init);
    const body = await res.json().catch(() => null);
    return body?.ok ? { ok: true, data: body.data as T } : { ok: false, message: body?.error?.message ?? '요청을 처리하지 못했습니다.' };
  } catch {
    return { ok: false, message: '네트워크 오류가 발생했습니다.' };
  }
}

/** 요약 한 줄 — 실행 결과와 기록 목록이 함께 쓴다 */
export function summaryLine(s: RagEvalSummary): string {
  const parts = [`찾음 ${s.hits}/${s.expected} (${pct(s.hitRate)})`];
  if (s.withPage) parts.push(`쪽 맞음 ${s.pageHits}/${s.withPage} (${pct(s.pageHitRate)})`);
  if (s.mrr !== null) parts.push(`평균 순위 점수 ${s.mrr.toFixed(2)}`);
  if (s.offTopic) parts.push(`엉뚱한 질문 걸러짐 ${s.offTopicRejected}/${s.offTopic} (${pct(s.offTopicRejectRate)})`);
  if (s.errors) parts.push(`찾기 실패 ${s.errors}`);
  if (s.commonEvidenceQuestions) parts.push(`공통 자료 근거 ${s.commonEvidenceQuestions}개 질문`);
  if (!s.searchScope) parts.push('비서 문서만 찾음');
  return parts.join(' · ');
}

/**
 * 배치 문서 찾기 평가(0054) — 관리자 문서 화면. 질문·기대 문서·기대 쪽 세트를 붙여 넣으면 대화와 같은 규칙으로 찾아 판정하고,
 * 실행을 남겨 지난번과 비교한다. 검색만 잰다(AI 답변 없음).
 */
export default function RagEvalPanel() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentId, setAgentId] = useState('');
  const [set, setSet] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<RunRow | null>(null);
  const [history, setHistory] = useState<RunRow[]>([]);
  const [compare, setCompare] = useState<{ base: RunRow; improved: RagEvalResult[]; regressed: RagEvalResult[]; unmatched: number; note: string | null } | null>(null);

  useEffect(() => {
    void call<Agent[]>('/api/agents?manage=true').then((r) => { if (r.ok) setAgents(r.data.filter((a) => a.agent_type !== 'link' && !a.deleted_at)); });
  }, []);
  useEffect(() => {
    setRun(null); setCompare(null); setHistory([]);
    if (!agentId) return;
    let active = true;
    void call<RunRow[]>(`/api/admin/rag-eval?agentId=${encodeURIComponent(agentId)}`).then((r) => { if (active && r.ok) setHistory(r.data); });
    return () => { active = false; };
  }, [agentId]);

  const preview = set.trim() ? parseRagEvalSet(set) : null;

  async function evaluate() {
    if (!agentId || running || !preview?.ok) return;
    setRunning(true); setError(null); setCompare(null);
    const r = await call<RunRow>('/api/admin/rag-eval', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId, set }) });
    if (r.ok) { setRun(r.data); setHistory((h) => [{ ...r.data, results: undefined }, ...h].slice(0, 20)); }
    else setError(r.message);
    setRunning(false);
  }
  async function compareWith(base: RunRow) {
    if (!run?.results) return;
    const r = await call<RunRow>(`/api/admin/rag-eval?id=${encodeURIComponent(base.id)}`);
    if (!r.ok || !r.data.results) { setError(r.ok ? '비교할 기록을 불러오지 못했습니다.' : r.message); return; }
    setCompare({ base: r.data, ...compareRagEvalRuns(r.data.results, run.results), note: scopeChangeNote(r.data.summary, run.summary) });
  }
  /** 지난 평가의 질문·기대 문서·기대 쪽을 세트 칸에 다시 채운다(문서를 바꾼 뒤 같은 세트로 다시 재기) */
  async function reuseSet(row: RunRow) {
    const r = await call<RunRow>(`/api/admin/rag-eval?id=${encodeURIComponent(row.id)}`);
    if (!r.ok || !r.data.results?.length) { setError(r.ok ? '세트를 불러오지 못했습니다.' : r.message); return; }
    setSet(ragEvalSetText(r.data.results)); setError(null);
  }
  async function open(row: RunRow) {
    const r = await call<RunRow>(`/api/admin/rag-eval?id=${encodeURIComponent(row.id)}`);
    if (r.ok) { setRun(r.data); setCompare(null); } else setError(r.message);
  }
  function download() {
    if (!run?.results) return;
    const url = URL.createObjectURL(new Blob([ragEvalCsv(run.results)], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = `문서찾기평가-${kst(run.created_at).replace(/[: ]/g, '')}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section aria-label="문서 찾기 일괄 평가" className="space-y-4 rounded-xl border border-slate-200 bg-white p-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">문서 찾기 일괄 평가</h2>
        <p className="mt-1 text-sm leading-6 text-slate-600">
          질문마다 기대하는 문서를 적어 두면, 대화와 같은 규칙(비서 문서 + 기관 유형의 공통 자료실)으로 찾아 맞았는지 한 번에 봅니다. 공통 자료는 상위 문서에 [공통]으로 보입니다. AI 답변은 만들지 않습니다(모델 사용량 없음).
          한 줄에 <strong>질문 · 기대 문서 이름(일부만 적어도 됨) · 기대 쪽(선택)</strong>을 탭이나 쉼표로 적습니다. 엑셀에서 세 칸을 복사해 붙여도 됩니다.
          기대 문서를 비운 줄은 <strong>근거가 없어야 맞는 질문</strong>(엉뚱한 질문)입니다. 한 번에 {RAG_EVAL_MAX_QUESTIONS}개까지 평가합니다.
        </p>
      </div>
      <select aria-label="평가할 비서" value={agentId} onChange={(e) => setAgentId(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">
        <option value="">비서를 고르세요</option>
        {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
      <textarea aria-label="평가 세트" value={set} onChange={(e) => setSet(e.target.value)} rows={7} placeholder={EXAMPLE} className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs" />
      {preview && (preview.ok
        ? <p className="text-xs text-slate-600">질문 {preview.rows.length}개 — 기대 문서 있음 {preview.rows.filter((r) => r.expected).length} · 엉뚱한 질문 {preview.rows.filter((r) => !r.expected).length}</p>
        : <ul role="alert" className="list-disc pl-5 text-xs text-red-700">{preview.errors.map((e) => <li key={e}>{e}</li>)}</ul>)}
      <button type="button" disabled={!agentId || running || !preview?.ok} onClick={() => void evaluate()} className="rounded-lg bg-[#003087] px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">{running ? '평가 중… (질문당 몇 초)' : '평가 실행'}</button>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}

      {run?.results && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-slate-800">{kst(run.created_at)} · 판 {run.agent_version} — {summaryLine(run.summary)}</p>
            <button type="button" onClick={download} className="text-xs text-[#003087] underline">결과 CSV 내려받기</button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-slate-500"><tr><th className="py-1 pr-2">질문</th><th className="pr-2">기대</th><th className="pr-2">판정</th><th className="pr-2">순위</th><th className="pr-2">쪽</th><th>상위 문서</th></tr></thead>
              <tbody>{run.results.map((r) => (
                <tr key={r.line} className="border-t border-slate-100 align-top">
                  <td className="py-1 pr-2">{r.question}</td>
                  <td className="pr-2">{r.expected ?? '(근거 없어야 함)'}{r.page !== null ? ` · p.${r.page}` : ''}</td>
                  <td className={`pr-2 font-semibold ${r.verdict === 'hit' || r.verdict === 'correct_empty' ? 'text-emerald-700' : 'text-red-700'}`}>{RAG_EVAL_VERDICT_LABELS[r.verdict]}</td>
                  <td className="pr-2">{r.rank ?? '—'}</td>
                  <td className="pr-2">{r.pageMatch === null ? '—' : r.pageMatch ? '맞음' : '다름'}</td>
                  <td>{r.topDocuments.join(' · ') || '—'}{r.topSimilarity !== null ? ` (${(r.topSimilarity * 100).toFixed(0)}%)` : ''}</td>
                </tr>))}</tbody>
            </table>
          </div>
        </div>
      )}

      {compare && (
        <div className="rounded-lg bg-slate-50 p-3 text-xs leading-6">
          <p className="font-semibold">{kst(compare.base.created_at)}(판 {compare.base.agent_version})과 비교 — 좋아짐 {compare.improved.length} · 나빠짐 {compare.regressed.length}{compare.unmatched ? ` · 그때 없던 질문 ${compare.unmatched}` : ''}</p>
          {compare.note && <p className="text-amber-700">{compare.note}</p>}
          {compare.regressed.map((r) => <p key={`r${r.line}`} className="text-red-700">나빠짐: {r.question} → {RAG_EVAL_VERDICT_LABELS[r.verdict]}</p>)}
          {compare.improved.map((r) => <p key={`i${r.line}`} className="text-emerald-700">좋아짐: {r.question} → {RAG_EVAL_VERDICT_LABELS[r.verdict]}</p>)}
        </div>
      )}

      {history.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-slate-800">지난 평가</h3>
          <ul className="space-y-1 text-xs">{history.map((h) => (
            <li key={h.id} className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => void open(h)} className="text-[#003087] underline">{kst(h.created_at)} · 판 {h.agent_version} · 질문 {h.question_count}</button>
              <span className="text-slate-600">{summaryLine(h.summary)}</span>
              <button type="button" onClick={() => void reuseSet(h)} className="text-slate-500 underline">이 세트 다시 쓰기</button>
              {run?.results && h.id !== run.id && <button type="button" onClick={() => void compareWith(h)} className="text-slate-500 underline">지금 결과와 비교</button>}
            </li>))}</ul>
        </div>
      )}
    </section>
  );
}
