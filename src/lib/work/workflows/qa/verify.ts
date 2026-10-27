// src/lib/work/workflows/qa/verify.ts
import { squash, type VerifySource } from '../items/verify';

/**
 * 질문별 답변(민원·문의 회신 / 감사·평가 요구자료) — 공통 검사(순수 함수).
 *
 * 카탈로그 validationRules
 *  - 회신: 질문별 응답 누락 / 근거 없는 조치·기한 약속 / 타 민원인 정보 혼입 / 담당자 사실 확인
 *  - 감사: 질의·증빙 대응 / 연도·대상·지표 기준 혼합 / 과거 수치 차이의 근거 / 증빙 없는 주장 표시
 * 모델은 질문(원문 인용)과 답(근거 번호)만 낸다. 근거 번호는 'F1…'(담당자가 확인한 사실 줄)과 원자료 id.
 */
export type QaKind = 'reply' | 'audit';

export interface RawQa {
  questions: { text: string; quote: string; sourceId: string }[];
  answers: { question: number; text: string; evidence: string[]; status: string }[];
  priorDiffs: { question: number; label: string; current: string; prior: string; reason: string }[];
}

export type AnswerFlag = 'unanswered' | 'needs_info' | 'unsupported' | 'promise_unsupported' | 'pii_removed' | 'year_mismatch' | 'prior_diff_unexplained' | 'quote_not_found';

export interface QaPair {
  /** 'Q1'… */
  id: string;
  question: string;
  quote: string;
  sourceName: string | null;
  answer: string;
  evidence: { id: string; label: string }[];
  priorDiffs: { label: string; current: string; prior: string; reason: string }[];
  flags: AnswerFlag[];
}

export interface QaResult {
  schema: 'qa/1';
  kind: QaKind;
  pairs: QaPair[];
  facts: { id: string; text: string }[];
}

export const MAX_QUESTIONS = 30;

/** 담당자가 확인한 사실 → 줄마다 'F1…'(빈 줄 빼고) */
export function factLines(text: string): { id: string; text: string }[] {
  return text
    .split('\n')
    .map((l) => l.replace(/^\s*[-•○·\d.)]+\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 60)
    .map((t, i) => ({ id: `F${i + 1}`, text: t.slice(0, 400) }));
}

const PROMISE = /(까지\s*(처리|조치|완료|회신|답변|시정|개선|지급|환급)|(조치|처리|시정|개선|보상|환급|지급|해결|반영|교체|수리)\s*하겠|(조치|처리|시정|개선|보상|환급|지급|해결|반영|교체|수리)할\s*예정|약속)/;
/** 다른 사람 개인정보 꼴 — 전화·휴대전화·전자우편·주민등록번호 */
const PII = /(01[016789][-\s.]?\d{3,4}[-\s.]?\d{4}|0\d{1,2}[-\s.]\d{3,4}[-\s.]\d{4}|[\w.+-]+@[\w-]+\.[\w.]+|\d{6}[-\s]?[1-4]\d{6})/g;
const YEAR = /(20\d{2})\s*년?/g;

export function yearsIn(text: string): Set<string> {
  return new Set([...text.matchAll(YEAR)].map((m) => m[1]));
}

/** 답의 다른 사람 개인정보 지우기 — 문의 글 자체에 있는 것(민원인 본인 연락처)은 남긴다 */
export function removeForeignPii(answer: string, allowedText: string): { text: string; removed: number } {
  let removed = 0;
  const allowed = squash(allowedText);
  const text = answer.replace(PII, (m) => {
    if (allowed.includes(squash(m))) return m;
    removed += 1;
    return '[개인정보 삭제]';
  });
  return { text, removed };
}

export function verifyQa(
  raw: RawQa,
  input: {
    kind: QaKind;
    questionSources: VerifySource[];
    evidenceSources: VerifySource[];
    priorSources: VerifySource[];
    facts: { id: string; text: string }[];
    /** 민원인 본인 글(문의 내용) — 그 안의 연락처는 다른 사람 정보가 아니다 */
    inquiryText: string;
    /** 지표·기간 정의 글(감사) — 답의 연도가 여기 없는 해면 기준 혼합 */
    definitionsText: string;
  }
): QaResult {
  const qById = new Map(input.questionSources.map((s) => [s.id, s]));
  const evById = new Map<string, { id: string; label: string; text: string }>([
    ...input.facts.map((f) => [f.id, { id: f.id, label: `담당자 확인 사실 ${f.id}`, text: f.text }] as const),
    ...[...input.evidenceSources, ...input.questionSources].map((s) => [s.id, { id: s.id, label: s.name, text: s.text }] as const),
  ]);
  const factText = input.facts.map((f) => f.text).join('\n');
  const allowedYears = input.kind === 'audit' ? yearsIn(input.definitionsText) : new Set<string>();
  const priorText = input.priorSources.map((s) => s.text).join('\n');
  const evidenceText = [...input.evidenceSources.map((s) => s.text), factText].join('\n');

  const pairs: QaPair[] = raw.questions.slice(0, MAX_QUESTIONS).map((q, i) => {
    const src = qById.get(q.sourceId) ?? null;
    const flags = new Set<AnswerFlag>();
    const quote = q.quote.trim().slice(0, 300);
    if (!quote || !src || !squash(src.text).includes(squash(quote))) flags.add('quote_not_found');
    const ans = raw.answers.find((a) => a.question === i + 1);
    let answer = ans?.text?.trim().slice(0, 3000) ?? '';
    if (!answer) flags.add('unanswered');
    if (ans?.status === 'needs_info') flags.add('needs_info');
    const evidence = [...new Set(ans?.evidence ?? [])].map((id) => evById.get(id)).filter((e): e is { id: string; label: string; text: string } => Boolean(e)).map(({ id, label }) => ({ id, label }));
    if (answer && !evidence.length) flags.add('unsupported');
    if (input.kind === 'reply' && answer && PROMISE.test(answer) && !PROMISE.test(factText)) flags.add('promise_unsupported');
    if (answer) {
      const r = removeForeignPii(answer, input.inquiryText);
      if (r.removed) {
        answer = r.text;
        flags.add('pii_removed');
      }
    }
    if (input.kind === 'audit' && allowedYears.size && [...yearsIn(answer)].some((y) => !allowedYears.has(y))) flags.add('year_mismatch');
    // 과거 수치 차이 — 과거 값은 과거 제출본에, 지금 값은 증빙에 있어야 하고 차이 근거가 있어야 한다
    const priorDiffs = raw.priorDiffs
      .filter((d) => d.question === i + 1)
      .filter((d) => d.prior && squash(priorText).includes(squash(d.prior)))
      .map((d) => ({ label: d.label.slice(0, 80), current: d.current.slice(0, 40), prior: d.prior.slice(0, 40), reason: d.reason.trim().slice(0, 300) }));
    if (priorDiffs.some((d) => !d.reason || !squash(evidenceText).includes(squash(d.current)))) flags.add('prior_diff_unexplained');
    return { id: `Q${i + 1}`, question: q.text.trim().slice(0, 500), quote, sourceName: src?.name ?? null, answer, evidence, priorDiffs, flags: [...flags] };
  });
  return { schema: 'qa/1', kind: input.kind, pairs, facts: input.facts };
}

export const ANSWER_FLAG_LABEL: Record<AnswerFlag, string> = {
  unanswered: '답변 없음',
  needs_info: '사실 확인 필요',
  unsupported: '근거 없음',
  promise_unsupported: '근거 없는 조치·기한 약속',
  pii_removed: '다른 사람 개인정보 지움',
  year_mismatch: '연도·기준 혼합',
  prior_diff_unexplained: '과거 수치 차이 근거 필요',
  quote_not_found: '질문 원문 확인 못함',
};

/** 확인 사항 — 답변 없음은 반드시 고칠 것(질문별 응답 누락), 나머지는 확인 필요 */
export function qaReviewItems(r: QaResult): { severity: 'blocking' | 'warning' | 'info'; code: string; message: string; field_ids: string[] }[] {
  const out: { severity: 'blocking' | 'warning' | 'info'; code: string; message: string; field_ids: string[] }[] = [];
  const by = (f: AnswerFlag) => r.pairs.filter((p) => p.flags.includes(f)).map((p) => p.id);
  const push = (f: AnswerFlag, severity: 'blocking' | 'warning' | 'info', text: string) => {
    const ids = by(f);
    if (ids.length) out.push({ severity, code: `QA_${f.toUpperCase()}`, message: `${text} ${ids.length}건(${ids.slice(0, 6).join(', ')})`, field_ids: [] });
  };
  if (!r.pairs.length) out.push({ severity: 'blocking', code: 'QA_NO_QUESTIONS', message: '질문(요구 항목)을 찾지 못했습니다. 문의 내용·요구서를 확인하세요.', field_ids: [] });
  push('unanswered', 'blocking', '답변이 없는 질문 — 질문별로 빠짐없이 답해야 합니다:');
  push('needs_info', 'warning', '담당자 확인이 더 필요한 답변:');
  push('unsupported', 'warning', r.kind === 'audit' ? '증빙을 대지 못한 답변(증빙 없는 주장):' : '확인한 사실·근거를 대지 못한 답변:');
  push('promise_unsupported', 'warning', '담당자가 확인한 사실에 없는 조치·기한 약속이 들어간 답변 — 지킬 수 있는 약속인지 확인하세요:');
  push('pii_removed', 'warning', '문의에 없던 연락처·주민번호 등을 지운 답변 — 다른 민원인 정보가 섞였는지 확인하세요:');
  push('year_mismatch', 'warning', '지표·기간 정의에 없는 연도가 들어간 답변 — 연도·대상 기준이 섞였는지 확인하세요:');
  push('prior_diff_unexplained', 'warning', '과거 제출 수치와 다른데 차이 근거가 없거나 지금 값이 증빙에 없는 답변:');
  push('quote_not_found', 'info', '질문 인용을 원문에서 찾지 못함:');
  return out;
}
