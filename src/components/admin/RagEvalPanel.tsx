'use client';

import { useEffect, useState } from 'react';
import type { Agent } from '@/lib/db';
import {
  RAG_EVAL_MAX_QUESTIONS, RAG_EVAL_VERDICT_LABELS, answerNote, compareRagEvalRuns, parseRagEvalSet, ragEvalCsv, ragEvalSetText, scopeChangeNote,
  type AcrossEntry, type RagEvalResult, type RagEvalSummary,
} from '@/lib/rag-eval';
import { RAG_EVAL_ANSWER_MAX_QUESTIONS, compareAnswers } from '@/lib/rag-eval-answer';
import { RAG_EVAL_GRADES, RAG_EVAL_JUDGE_LABELS, agreementNote, isJudgeGrade, judgeNote, type RagEvalJudgeGrade } from '@/lib/rag-eval-judge';

type RunRow = { id: string; agent_id: string; agent_version: number; created_at: string; question_count: number; status: 'done' | 'partial'; summary: RagEvalSummary; results?: RagEvalResult[] };

const EXAMPLE = '질문\t기대 문서\t기대 쪽\n출장 일비는 하루 얼마인가요?\t여비 규정\t12\n연가 사용 신청은 언제까지 하나요?\t복무 규정\t\n점심 메뉴 추천해 줘\t\t';
const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);
const kst = (iso: string) => new Date(Date.parse(iso) + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');

type SetRow = { id: string; name: string; question_count: number; created_by: string | null; updated_at: string; set_text?: string };

async function call<T>(url: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; message: string; code?: string }> {
  try {
    const res = await fetch(url, init);
    const body = await res.json().catch(() => null);
    return body?.ok ? { ok: true, data: body.data as T } : { ok: false, message: body?.error?.message ?? '요청을 처리하지 못했습니다.', code: body?.error?.code };
  } catch {
    return { ok: false, message: '네트워크 오류가 발생했습니다.' };
  }
}

/** 같은 세트로 잰 다른 비서가 없을 때 */
export const acrossEmptyNote = '이 세트로 잰 다른 비서가 아직 없습니다. 위에서 비서를 바꾸고 같은 세트로 평가하면 여기서 함께 봅니다.';

/** 요약 한 줄 — 실행 결과와 기록 목록이 함께 쓴다 */
export function summaryLine(s: RagEvalSummary): string {
  const parts = [`찾음 ${s.hits}/${s.expected} (${pct(s.hitRate)})`];
  if (s.withPage) parts.push(`쪽 맞음 ${s.pageHits}/${s.withPage} (${pct(s.pageHitRate)})`);
  if (s.mrr !== null) parts.push(`평균 순위 점수 ${s.mrr.toFixed(2)}`);
  if (s.offTopic) parts.push(`엉뚱한 질문 걸러짐 ${s.offTopicRejected}/${s.offTopic} (${pct(s.offTopicRejectRate)})`);
  if (s.errors) parts.push(`찾기 실패 ${s.errors}`);
  if (s.commonEvidenceQuestions) parts.push(`공통 자료 근거 ${s.commonEvidenceQuestions}개 질문`);
  if (!s.searchScope) parts.push('비서 문서만 찾음');
  const a = s.answers;
  if (a) {
    parts.push(`답변 맞음 ${a.passed}/${a.evaluated} (${pct(a.passRate)})`);
    if (a.expected) parts.push(`기대 문서 인용 ${a.grounded}/${a.expected}`);
    if (a.keywordRows) parts.push(`핵심어 ${a.keywordPasses}/${a.keywordRows}`);
    if (a.numberIssues) parts.push(`확인 안 된 숫자가 있는 답 ${a.numberIssues}`);
    if (a.errors) parts.push(`답 못 만듦 ${a.errors}`);
    if (a.judge) {
      parts.push(`AI 채점(참고) 맞음 ${a.judge.correct} · 일부 ${a.judge.partial} · 틀림 ${a.judge.incorrect}${a.judge.unfaithful ? ` · 근거 밖 내용 ${a.judge.unfaithful}` : ''}${a.judge.errors ? ` · 채점 못 함 ${a.judge.errors}` : ''}`);
    }
    if (typeof a.toolAnswers === 'number') parts.push(`도구 쓴 답 ${a.toolAnswers}/${a.evaluated}`);
    if (a.agreement) parts.push(agreementNote(a.agreement));
    const cost = Math.round((a.costKrw + (a.judge?.costKrw ?? 0)) * 100) / 100;
    parts.push(`AI 사용 ${cost.toLocaleString('ko-KR')}원`);
  }
  return parts.join(' · ');
}

/**
 * 배치 문서 찾기 평가(0054) — 관리자 문서 화면. 질문·기대 문서·기대 쪽 세트를 붙여 넣으면 대화와 같은 규칙으로 찾아 판정하고,
 * 실행을 남겨 지난번과 비교한다. 기본은 검색만 잰다 — 'AI 답변까지 평가'(2026-11-08)를 고르면 답도 한 번 만들어 프로그램이 판정한다.
 */
export default function RagEvalPanel() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentId, setAgentId] = useState('');
  const [set, setSet] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<RunRow | null>(null);
  const [history, setHistory] = useState<RunRow[]>([]);
  // 이름 붙인 세트(0059) — 기관 단위라 비서를 바꿔도 같은 세트를 쓴다
  const [sets, setSets] = useState<SetRow[]>([]);
  const [setId, setSetId] = useState('');
  const [setName, setSetName] = useState('');
  const [setNotice, setSetNotice] = useState<string | null>(null);
  const [compare, setCompare] = useState<{ base: RunRow; improved: RagEvalResult[]; regressed: RagEvalResult[]; unmatched: number; note: string | null; answerImproved: RagEvalResult[]; answerRegressed: RagEvalResult[] } | null>(null);
  // 답변까지 평가(2026-11-08) — 질문마다 대화와 같은 프롬프트로 답을 한 번 만든다(모델 사용량)
  const [withAnswers, setWithAnswers] = useState(false);
  // AI 채점(2026-11-09, 참고) — 답변까지 평가할 때만, 기대 문서가 있는 질문의 답마다 AI를 한 번 더 부른다
  const [withJudge, setWithJudge] = useState(false);
  // 도구를 쓰는 답(2026-11-09) — 대화처럼 그 비서의 공공 데이터 도구(법령·통계 등)를 쓰게 한다
  const [withTools, setWithTools] = useState(false);

  useEffect(() => {
    void call<SetRow[]>('/api/admin/rag-eval/sets').then((r) => { if (r.ok) setSets(r.data); });
  }, []);
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
  const tooManyForAnswers = withAnswers && Boolean(preview?.ok && preview.rows.length > RAG_EVAL_ANSWER_MAX_QUESTIONS);

  async function evaluate() {
    if (!agentId || running || !preview?.ok || tooManyForAnswers) return;
    setRunning(true); setError(null); setCompare(null);
    const r = await call<RunRow>('/api/admin/rag-eval', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId, set, ...(withAnswers ? { answers: true, ...(withJudge ? { judge: true } : {}), ...(withTools ? { tools: true } : {}) } : {}) }) });
    if (r.ok) { setRun(r.data); setHistory((h) => [{ ...r.data, results: undefined }, ...h].slice(0, 20)); }
    else setError(r.message);
    setRunning(false);
  }
  // 사람 판정(2026-11-09) — 답 한 줄을 맞음·일부·틀림으로 매겨 AI 채점과 맞대 본다(모델 호출 없음)
  const [labeling, setLabeling] = useState<number | null>(null);
  async function labelAnswer(line: number, grade: RagEvalJudgeGrade | null) {
    if (!run || labeling !== null) return;
    setLabeling(line); setError(null);
    const r = await call<RunRow>('/api/admin/rag-eval', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: run.id, line, grade }) });
    if (r.ok) { setRun(r.data); setHistory((h) => h.map((x) => (x.id === r.data.id ? { ...r.data, results: undefined } : x))); }
    else setError(r.message);
    setLabeling(null);
  }
  /** 세트 칸의 글을 이름 붙여 저장 — 같은 이름이 있으면 덮어쓸지 묻는다 */
  async function saveSet(overwrite = false) {
    if (!setName.trim() || !preview?.ok) return;
    setSetNotice(null); setError(null);
    const r = await call<SetRow>('/api/admin/rag-eval/sets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: setName, set, overwrite }) });
    if (!r.ok) {
      if (r.code === 'exists' && !overwrite && window.confirm(r.message)) return saveSet(true);
      setError(r.message);
      return;
    }
    setSets((list) => [r.data, ...list.filter((x) => x.id !== r.data.id)]);
    setSetId(r.data.id);
    setSetNotice(`'${r.data.name}' 세트를 저장했습니다(질문 ${r.data.question_count}개).`);
  }
  async function loadSet(id: string) {
    setSetId(id); setSetNotice(null);
    if (!id) return;
    const r = await call<SetRow>(`/api/admin/rag-eval/sets?id=${encodeURIComponent(id)}`);
    if (!r.ok || !r.data.set_text) { setError(r.ok ? '세트를 불러오지 못했습니다.' : r.message); return; }
    setSet(r.data.set_text); setSetName(r.data.name); setError(null);
  }
  async function deleteSet() {
    const row = sets.find((x) => x.id === setId);
    if (!row || !window.confirm(`'${row.name}' 세트를 지울까요? 지난 평가 기록은 그대로 남습니다.`)) return;
    const r = await call<{ id: string }>(`/api/admin/rag-eval/sets?id=${encodeURIComponent(row.id)}`, { method: 'DELETE' });
    if (!r.ok) { setError(r.message); return; }
    setSets((list) => list.filter((x) => x.id !== row.id)); setSetId(''); setSetNotice(`'${row.name}' 세트를 지웠습니다.`);
  }
  // 같은 세트로 잰 다른 비서(2026-11-12) — 비서마다 가장 최근 실행의 요약
  const [across, setAcross] = useState<{ runId: string; entries: AcrossEntry[] } | null>(null);
  async function loadAcross(row: RunRow) {
    const r = await call<{ entries: AcrossEntry[] }>(`/api/admin/rag-eval?across=${encodeURIComponent(row.id)}`);
    if (!r.ok) { setError(r.message); return; }
    setAcross({ runId: row.id, entries: r.data.entries });
  }
  async function compareWith(base: RunRow) {
    if (!run?.results) return;
    const r = await call<RunRow>(`/api/admin/rag-eval?id=${encodeURIComponent(base.id)}`);
    if (!r.ok || !r.data.results) { setError(r.ok ? '비교할 기록을 불러오지 못했습니다.' : r.message); return; }
    const answersCompared = compareAnswers(r.data.results, run.results);
    setCompare({ base: r.data, ...compareRagEvalRuns(r.data.results, run.results), note: scopeChangeNote(r.data.summary, run.summary), answerImproved: answersCompared.improved, answerRegressed: answersCompared.regressed });
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
          질문마다 기대하는 문서를 적어 두면, 대화와 같은 규칙(비서 문서 + 기관 유형의 공통 자료실)으로 찾아 맞았는지 한 번에 봅니다. 공통 자료는 상위 문서에 [공통]으로 보입니다. 기본은 찾기만 잽니다(모델 사용량 없음).
          한 줄에 <strong>질문 · 기대 문서 이름(일부만 적어도 됨) · 기대 쪽(선택) · 기대 답 핵심어(선택, ;로 나눔)</strong>를 탭이나 쉼표로 적습니다. 엑셀에서 칸을 복사해 붙여도 됩니다.
          기대 문서를 비운 줄은 <strong>근거가 없어야 맞는 질문</strong>(엉뚱한 질문)입니다. 한 번에 {RAG_EVAL_MAX_QUESTIONS}개까지 평가합니다.
        </p>
      </div>
      <select aria-label="평가할 비서" value={agentId} onChange={(e) => setAgentId(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">
        <option value="">비서를 고르세요</option>
        {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
      <textarea aria-label="평가 세트" value={set} onChange={(e) => setSet(e.target.value)} rows={7} placeholder={EXAMPLE} className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs" />
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <select aria-label="저장한 세트" value={setId} onChange={(e) => void loadSet(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1.5">
          <option value="">저장한 세트 불러오기{sets.length ? ` (${sets.length})` : ''}</option>
          {sets.map((s) => <option key={s.id} value={s.id}>{s.name} · 질문 {s.question_count}</option>)}
        </select>
        {setId && <button type="button" onClick={() => void deleteSet()} className="text-slate-500 underline">이 세트 지우기</button>}
        <input aria-label="세트 이름" value={setName} maxLength={60} onChange={(e) => setSetName(e.target.value)} placeholder="세트 이름(예: 여비 규정 기본 질문)" className="min-w-[14rem] flex-1 rounded-lg border border-slate-300 px-2 py-1.5" />
        <button type="button" disabled={!setName.trim() || !preview?.ok} onClick={() => void saveSet()} className="rounded-lg border border-[#003087] px-3 py-1.5 font-semibold text-[#003087] disabled:opacity-40">세트 저장</button>
      </div>
      {setNotice && <p role="status" className="text-xs text-emerald-700">{setNotice}</p>}
      {preview && (preview.ok
        ? <p className="text-xs text-slate-600">질문 {preview.rows.length}개 — 기대 문서 있음 {preview.rows.filter((r) => r.expected).length} · 엉뚱한 질문 {preview.rows.filter((r) => !r.expected).length}</p>
        : <ul role="alert" className="list-disc pl-5 text-xs text-red-700">{preview.errors.map((e) => <li key={e}>{e}</li>)}</ul>)}
      <label className="flex items-start gap-2 text-sm text-slate-700">
        <input type="checkbox" checked={withAnswers} onChange={(e) => setWithAnswers(e.target.checked)} className="mt-1" />
        <span>
          <strong>AI 답변까지 평가</strong> — 질문마다 대화와 같은 지시문·참고 자료로 답을 한 번 만들고, 기대 문서를 [번호]로 인용했는지·답의 숫자가 근거에 있는지·기대 답 핵심어가 모두 들었는지를 프로그램이 봅니다(엉뚱한 질문은 문서를 인용하지 않아야 맞음).
          <span className="block text-xs text-slate-500">질문 {RAG_EVAL_ANSWER_MAX_QUESTIONS}개까지 · 질문마다 AI를 한 번 불러 사용량(기관 한도)이 듭니다 · 공공 데이터 도구는 아래에서 고를 때만, 첨부·앱 단계·파일 만들기는 쓰지 않습니다 · 답이 맞는 말인지까지는 모릅니다 — 핵심어를 적어 두면 그만큼 더 봅니다.</span>
        </span>
      </label>
      {withAnswers && (
        <label className="ml-6 flex items-start gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={withTools} onChange={(e) => setWithTools(e.target.checked)} className="mt-1" />
          <span>
            <strong>도구도 쓰기</strong> — 대화처럼 이 비서에 켜진 공공 데이터 도구(법령·통계·입찰·공시)를 AI가 필요하면 불러 답합니다. 도구가 보여 준 숫자는 숫자 확인에서 '본 숫자'로 칩니다.
            <span className="block text-xs text-slate-500">도구를 부를 때마다 AI를 한 번 더 부르고 바깥 조회가 있어 느려지고 사용량이 늘어납니다 · 켜진 공공 데이터 도구가 없는 비서는 고를 수 없습니다(평가 실행 때 안내) · 파일을 만드는 도구는 쓰지 않습니다.</span>
          </span>
        </label>
      )}
      {withAnswers && (
        <label className="ml-6 flex items-start gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={withJudge} onChange={(e) => setWithJudge(e.target.checked)} className="mt-1" />
          <span>
            <strong>AI 채점도(참고)</strong> — 기대 문서가 있는 질문의 답마다 AI가 근거 글과 맞대 맞음·일부 맞음·틀림과 근거 밖 내용이 있는지를 한두 문장 이유와 함께 적습니다.
            <span className="block text-xs text-slate-500">채점하는 AI도 틀릴 수 있어 '답변 맞음'(프로그램 판정)은 바꾸지 않고 따로 보입니다 · 질문마다 AI를 한 번 더 불러 사용량이 늘어납니다 · 평가 뒤 답마다 '사람 판정'을 매기면 AI 채점이 사람과 얼마나 맞는지(일치율·후하게 본 답)를 셉니다.</span>
          </span>
        </label>
      )}
      {tooManyForAnswers && <p role="alert" className="text-xs text-red-700">답변까지 평가할 때는 질문 {RAG_EVAL_ANSWER_MAX_QUESTIONS}개까지입니다(지금 {preview?.ok ? preview.rows.length : 0}개).</p>}
      <button type="button" disabled={!agentId || running || !preview?.ok || tooManyForAnswers} onClick={() => void evaluate()} className="rounded-lg bg-[#003087] px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">{running ? (withAnswers ? '평가 중… (질문당 십여 초)' : '평가 중… (질문당 몇 초)') : '평가 실행'}</button>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}

      {run?.results && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-slate-800">{kst(run.created_at)} · 판 {run.agent_version} — {summaryLine(run.summary)}</p>
            <span className="flex gap-3">
              <button type="button" onClick={() => void loadAcross(run)} className="text-xs text-[#003087] underline">같은 세트로 잰 다른 비서</button>
              <button type="button" onClick={download} className="text-xs text-[#003087] underline">결과 CSV 내려받기</button>
            </span>
          </div>
          {across?.runId === run.id && (
            <div aria-label="같은 세트로 잰 비서" className="rounded-lg bg-slate-50 p-3 text-xs leading-6">
              {across.entries.length <= 1
                ? <p className="text-slate-600">{acrossEmptyNote}</p>
                : <ul className="space-y-0.5">{across.entries.map((e) => (
                  <li key={e.runId} className={e.current ? 'font-semibold text-slate-900' : 'text-slate-700'}>{e.agentName || '(이름 없음)'} · 판 {e.agentVersion} · {kst(e.createdAt)}{e.current ? ' (지금 보는 실행)' : ''} — {summaryLine(e.summary)}</li>))}</ul>}
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-slate-500"><tr><th className="py-1 pr-2">질문</th><th className="pr-2">기대</th><th className="pr-2">판정</th><th className="pr-2">순위</th><th className="pr-2">쪽</th><th className="pr-2">상위 문서</th>{run.results.some((r) => r.answer) && <th>답변</th>}</tr></thead>
              <tbody>{run.results.map((r) => (
                <tr key={r.line} className="border-t border-slate-100 align-top">
                  <td className="py-1 pr-2">{r.question}</td>
                  <td className="pr-2">{r.expected ?? '(근거 없어야 함)'}{r.page !== null ? ` · p.${r.page}` : ''}</td>
                  <td className={`pr-2 font-semibold ${r.verdict === 'hit' || r.verdict === 'correct_empty' ? 'text-emerald-700' : 'text-red-700'}`}>{RAG_EVAL_VERDICT_LABELS[r.verdict]}</td>
                  <td className="pr-2">{r.rank ?? '—'}</td>
                  <td className="pr-2">{r.pageMatch === null ? '—' : r.pageMatch ? '맞음' : '다름'}</td>
                  <td className="pr-2">{r.topDocuments.join(' · ') || '—'}{r.topSimilarity !== null ? ` (${(r.topSimilarity * 100).toFixed(0)}%)` : ''}</td>
                  {run.results!.some((x) => x.answer) && <td className="min-w-[16rem]">{r.answer ? <>
                    <p className={`font-semibold ${r.answer.passed ? 'text-emerald-700' : 'text-red-700'}`}>{answerNote(r.answer)}</p>
                    {r.keywords?.length ? <p className="text-slate-500">핵심어: {r.keywords.join(', ')}</p> : null}
                    {r.answer.cited.length > 0 && <p className="text-slate-500">인용: {r.answer.cited.join(' · ')}</p>}
                    {typeof r.answer.toolCalls === 'number' && <p className="text-slate-500">도구: {r.answer.toolCalls ? `${r.answer.toolsUsed?.join(', ') ?? ''} (${r.answer.toolCalls}번)` : '부르지 않음'}</p>}
                    {r.answer.judge && <p className={r.answer.judge.grade === 'correct' && r.answer.judge.faithful !== false ? 'text-emerald-700' : 'text-amber-700'}>AI 채점(참고): {judgeNote(r.answer.judge)}{r.answer.judge.reason ? ` — ${r.answer.judge.reason}` : ''}</p>}
                    {r.answer.text && !r.answer.error && <label className="mt-1 flex items-center gap-2 text-slate-600">사람 판정<select aria-label={`${r.line}번 질문 사람 판정`} disabled={labeling !== null} value={r.answer.human?.grade ?? ''} onChange={(e) => void labelAnswer(r.line, isJudgeGrade(e.target.value) ? e.target.value : null)} className="rounded border border-slate-200 px-1 py-0.5 text-xs">
                      <option value="">—</option>
                      {RAG_EVAL_GRADES.map((g) => <option key={g} value={g}>{RAG_EVAL_JUDGE_LABELS[g]}</option>)}
                    </select>{r.answer.human && r.answer.judge?.grade && (r.answer.human.grade === r.answer.judge.grade ? <span className="text-emerald-700">AI 채점과 같음</span> : <span className="text-amber-700">AI 채점과 다름</span>)}</label>}
                    {r.answer.text && <details><summary className="cursor-pointer text-[#003087]">답 보기</summary><p className="mt-1 whitespace-pre-wrap text-slate-700">{r.answer.text}</p></details>}
                  </> : '—'}</td>}
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
          {(compare.answerImproved.length > 0 || compare.answerRegressed.length > 0) && <p className="font-semibold">답변 — 좋아짐 {compare.answerImproved.length} · 나빠짐 {compare.answerRegressed.length}</p>}
          {compare.answerRegressed.map((r) => <p key={`ar${r.line}`} className="text-red-700">답변 나빠짐: {r.question} → {r.answer ? answerNote(r.answer) : ''}</p>)}
          {compare.answerImproved.map((r) => <p key={`ai${r.line}`} className="text-emerald-700">답변 좋아짐: {r.question}</p>)}
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
