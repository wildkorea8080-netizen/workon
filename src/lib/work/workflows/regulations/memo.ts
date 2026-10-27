// src/lib/work/workflows/regulations/memo.ts
import { evidenceLine, isUsable, KIND_LABEL, type RegulationEvidence } from './evidence';

/**
 * 모델 초안 → 확정한 검토 의견·유보(순수 함수).
 *
 *  - 의견 한 줄은 **쓸 수 있는 근거 번호가 하나 이상**일 때만 남는다. 근거가 없거나(번호를 안 댐·없는 번호),
 *    댄 근거가 모두 기준일 뒤 시행·다른 기관 자료면 그 문장은 '유보'로 옮긴다 — 근거 없는 판단을 의견에 남기지 않는다
 *  - 시행일을 모르는 근거로만 받친 의견에는 '시행일 확인 필요'를 붙인다
 *  - 의견이 하나도 남지 않으면 '판단 유보'라고 적는다(빈 의견으로 두지 않는다)
 */
export interface RegulationDraft {
  findings: { text: string; evidenceIds: string[] }[];
  reservations: { text: string }[];
}

export interface SettledFinding {
  text: string;
  evidenceIds: string[];
  dateCheck: boolean;
}

export interface Reservation {
  text: string;
  reason: string;
}

export interface RegulationOutcome {
  findings: SettledFinding[];
  reservations: Reservation[];
}

const MAX_FINDINGS = 12;
const MAX_TEXT = 600;

function cleanText(s: string): string {
  // 모델이 문장에 붙인 [E1] 표시는 떼고 프로그램이 다시 붙인다(없는 번호가 글에 남지 않게)
  return s.replace(/\[E\d{1,3}\]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

export function settleFindings(draft: RegulationDraft, evidence: RegulationEvidence[]): RegulationOutcome {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const findings: SettledFinding[] = [];
  const reservations: Reservation[] = [];
  for (const f of draft.findings.slice(0, MAX_FINDINGS)) {
    const text = cleanText(f.text);
    if (!text) continue;
    const known = [...new Set(f.evidenceIds)].filter((id) => byId.has(id));
    const usable = known.filter((id) => isUsable(byId.get(id)!.applicability));
    if (!usable.length) {
      reservations.push({
        text,
        reason: known.length ? '댄 근거가 기준일 뒤 시행이거나 다른 기관 자료라 근거로 쓸 수 없습니다' : '확인한 근거로 받치지 못한 판단입니다',
      });
      continue;
    }
    findings.push({ text, evidenceIds: usable, dateCheck: usable.every((id) => byId.get(id)!.applicability === 'date_unknown') });
  }
  for (const r of draft.reservations.slice(0, MAX_FINDINGS)) {
    const text = cleanText(r.text);
    if (text) reservations.push({ text, reason: '근거가 부족하거나 서로 다릅니다' });
  }
  return { findings, reservations };
}

export interface MemoInput {
  title: string;
  question: string;
  basisDate: string;
  scope: string;
  departmentName: string | null;
  today: string;
  evidence: RegulationEvidence[];
  outcome: RegulationOutcome;
  /** 쓸 수 없었던 자료 범위(예: '기관 문서 검색을 쓸 수 없음') */
  unavailable: string[];
}

/** 양식 칸 이름 → 글. '검토 의견'만 모델 초안에서 오고 나머지는 프로그램이 찾은 자료로 쓴다 */
export function memoFieldValues(i: MemoInput): { system: Record<string, string>; opinion: string } {
  const used = new Set(i.outcome.findings.flatMap((f) => f.evidenceIds));
  const usable = i.evidence.filter((e) => isUsable(e.applicability));
  const excluded = i.evidence.filter((e) => !isUsable(e.applicability));
  const opinion = i.outcome.findings.length
    ? i.outcome.findings
        .map((f) => `○ ${f.text} ${f.evidenceIds.map((id) => `[${id}]`).join('')}${f.dateCheck ? ' (시행일 확인 필요)' : ''}`)
        .join('\n')
    : '○ 확인한 근거로는 판단할 수 없어 유보합니다. 아래 유보·확인 필요 사항을 담당자가 확인해 주세요.';
  const evidenceText = [
    ...usable.filter((e) => used.has(e.id)).map(evidenceLine),
    ...usable.filter((e) => !used.has(e.id)).map((e) => `${evidenceLine(e)} — 찾았으나 의견에 쓰지 않음`),
    ...excluded.map((e) => `${evidenceLine(e)} — 제외: ${e.note ?? ''}`),
  ];
  const counts = (['org_doc', 'common', 'law', 'ordinance', 'upload'] as const)
    .map((k) => [KIND_LABEL[k], i.evidence.filter((e) => e.kind === k).length] as const)
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `${label} ${n}건`);
  const reservations = i.outcome.reservations.map((r) => `○ ${r.text} — ${r.reason}`);
  return {
    opinion,
    system: {
      제목: i.title,
      작성일: i.today,
      ...(i.departmentName ? { 작성부서: i.departmentName } : {}),
      '검토 질문': i.question,
      '적용 기준': `적용 기준일 ${i.basisDate} · 범위: ${i.scope}`,
      근거: evidenceText.length ? evidenceText.join('\n') : '확인한 근거 없음',
      '유보·확인 필요': reservations.length ? reservations.join('\n') : '없음',
      '검토 범위': [
        `확인한 자료: ${counts.length ? counts.join(' · ') : '없음'}`,
        ...i.unavailable.map((u) => `- ${u}`),
        '이 메모는 찾은 근거를 정리한 검토 의견이며 법률적 최종 판단이 아닙니다. 근거 위치는 찾은 자료가 알려 준 것만 적었습니다.',
      ].join('\n'),
    },
  };
}

/** KST 날짜 'YYYY. M. D.' */
export function kstDate(d: Date): string {
  const k = new Date(d.getTime() + 9 * 3600_000);
  return `${k.getUTCFullYear()}. ${k.getUTCMonth() + 1}. ${k.getUTCDate()}.`;
}
