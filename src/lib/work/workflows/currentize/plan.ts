// src/lib/work/workflows/currentize/plan.ts
// 현행화 — 앞 단계 결과(연도 밀기·표 열 밀기·고치기·인용 맞대기·숫자 확인)를 변경 목록 하나로 모은다. 순수 함수(입출력 없음).
// 원칙: 프로그램이 확신하는 것만 changed다. 사람이 봐야 하는 것은 needs_check(after 없음이 기본), 모델 제안은 proposed — 둘 다 파일에 넣지 않는다.
import type { Segment } from './segments';
import type { Finding, FindingKind } from './classify';
import type { ShiftedCell } from './tables';
import type { CitationPair } from './citations';
import type { RawRewrite } from './model';

/** structure = 행·구역을 넣거나 빼야 하는 일(글자 단위 적용 밖이라 언제나 needs_check) */
export type ChangeKind = FindingKind | 'table' | 'structure';

export interface Change {
  /** c1, c2 … 계획 순서(같은 입력이면 언제나 같다) */
  id: string;
  /** 작년 파일의 조각 id(`섹션:문단 시작 위치`) */
  segmentId: string;
  kind: ChangeKind;
  before: string;
  /** 넣을 글. 확인 요청은 null일 수 있다 */
  after: string | null;
  status: 'changed' | 'needs_check' | 'proposed';
  /** 근거 — 원자료 id·바뀐 인용의 조각 id·'memo' */
  basis: string[];
  note: string | null;
}

export interface CurrentizeContent {
  schema: 'currentize/1';
  priorSourceId: string;
  priorSha256: string;
  fromYear: number;
  toYear: number;
  changes: Change[];
  citations: CitationPair[];
  truncated: boolean;
  costStopped: boolean;
  mode: 'llm' | 'mock';
}

/** 표 칸 하나. segmentId는 그 칸 문단의 조각 id, uncertain은 단위를 모르는 값에서 온 행 */
export interface PlanTableCell {
  segmentId: string;
  cell: ShiftedCell;
  uncertain: boolean;
}

export interface PlanInput {
  segments: Segment[];
  /** 조각 id → 분류 결과. 지금 규칙은 쓰지 않는다(연도 밀기 결과가 shifted로 온다) — 계획 입력의 계약으로 받는다 */
  findings: Map<string, Finding[]>;
  /** 조각 id → 연도를 민 글 */
  shifted: Map<string, string>;
  tableCells: PlanTableCell[];
  rewrites: { accepted: RawRewrite[]; proposed: RawRewrite[] };
  citations: CitationPair[];
  numberStatus: Map<string, 'ok' | 'needs_check'>;
}

export const NOTE_UNIT_UNKNOWN = '단위를 알 수 없어 그대로 넣었습니다 — 확인하세요';
export const NOTE_CITATION_CHANGED = '근거 조문이 바뀜 — 문장을 확인하세요';
export const NOTE_CITATION_NOT_FOUND = '현재 조문을 찾지 못함';
export const NOTE_NUMBER = '올해 자료에서 확인되지 않은 숫자가 있습니다 — 확인하세요';

type Draft = Omit<Change, 'id'>;

/** 표 칸 → 변경. 단위를 모르는 행은 바뀐 칸이어도 사람이 본다(1000배 어긋날 수 있다) */
function tableChange(t: PlanTableCell): Draft {
  const { cell } = t;
  const unsure = t.uncertain && cell.status === 'changed';
  return {
    segmentId: t.segmentId,
    kind: 'table',
    before: cell.before,
    after: cell.after,
    status: unsure ? 'needs_check' : cell.status,
    basis: [],
    note: unsure ? NOTE_UNIT_UNKNOWN : (cell.note ?? null),
  };
}

/** 표 밖(또는 표 계산이 손대지 않은) 조각 하나의 변경들 */
function segmentChanges(s: Segment, p: PlanInput, accepted: Map<string, RawRewrite>, proposed: Map<string, RawRewrite[]>): Draft[] {
  const base = { segmentId: s.id, before: s.text, basis: [] as string[], note: null as string | null };

  // 1) 받아들인 고치기가 이긴다 — 연도 표지는 검증이 이미 묶어 두었으므로 연도 밀기를 따로 하지 않는다
  const rewrite = accepted.get(s.id);
  if (rewrite) return [{ ...base, kind: 'prose', after: rewrite.text, status: 'changed', basis: [...rewrite.basis] }];

  const out: Draft[] = [];
  // 2) 연도 밀기 — 글이 실제로 바뀐 때만
  const shifted = p.shifted.get(s.id);
  if (shifted !== undefined && shifted !== s.text) out.push({ ...base, kind: 'year', after: shifted, status: 'changed' });
  // 3) 근거가 모자란 고치기는 제안으로만(파일에 넣지 않는다)
  for (const r of proposed.get(s.id) ?? []) out.push({ ...base, kind: 'prose', after: r.text, status: 'proposed', basis: [...r.basis] });
  // 4) 본문 숫자는 프로그램도 모델도 바꾸지 않는다 — 올해 자료에 없는 숫자는 사람이 본다
  if (p.numberStatus.get(s.id) === 'needs_check') out.push({ ...base, kind: 'number', after: null, status: 'needs_check', note: NOTE_NUMBER });
  // 5) 인용 — 같은 조각의 같은 상태는 하나로(바뀜 먼저)
  const statuses = new Set(p.citations.filter((c) => c.segmentId === s.id).map((c) => c.status));
  if (statuses.has('changed')) out.push({ ...base, kind: 'citation', after: null, status: 'needs_check', note: NOTE_CITATION_CHANGED });
  if (statuses.has('not_found')) out.push({ ...base, kind: 'citation', after: null, status: 'needs_check', note: NOTE_CITATION_NOT_FOUND });
  return out;
}

/**
 * 변경 목록. 조각 순서대로, 표 칸 조각은 표 계산 결과만 낸다(같은 칸에 연도 밀기·숫자 확인을 겹쳐 내면 한 문단에 두 번 적용된다).
 * 조각 목록에 없는 칸 조각은 맨 뒤에 입력 순서로 — 적용할 때 풀리지 않으면 PRIOR_MISMATCH로 드러난다.
 */
export function buildPlan(p: PlanInput): Change[] {
  const accepted = new Map<string, RawRewrite>();
  for (const r of p.rewrites.accepted) if (!accepted.has(r.segmentId)) accepted.set(r.segmentId, r);
  const proposed = new Map<string, RawRewrite[]>();
  for (const r of p.rewrites.proposed) proposed.set(r.segmentId, [...(proposed.get(r.segmentId) ?? []), r]);
  const cellsBySegment = new Map<string, PlanTableCell[]>();
  for (const t of p.tableCells) cellsBySegment.set(t.segmentId, [...(cellsBySegment.get(t.segmentId) ?? []), t]);

  const drafts: Draft[] = [];
  const known = new Set<string>();
  for (const s of p.segments) {
    known.add(s.id);
    const cells = cellsBySegment.get(s.id);
    if (cells) drafts.push(...cells.map(tableChange));
    else drafts.push(...segmentChanges(s, p, accepted, proposed));
  }
  for (const t of p.tableCells) if (!known.has(t.segmentId)) drafts.push(tableChange(t));

  return drafts.map((d, i) => ({ id: `c${i + 1}`, ...d }));
}
