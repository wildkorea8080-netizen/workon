// src/lib/work/workflows/currentize/plan.ts
// 현행화 — 앞 단계 결과(연도 밀기·표 열 밀기·고치기·인용 맞대기·숫자 확인)를 변경 목록 하나로 모은다. 순수 함수(입출력 없음).
// 원칙: 프로그램이 확신하는 것만 changed다. 사람이 봐야 하는 것은 needs_check(after 없음이 기본), 모델 제안은 proposed — 둘 다 파일에 넣지 않는다.
import type { Segment } from './segments';
import type { Finding, FindingKind } from './classify';
import type { ShiftedCell } from './tables';
import type { CitationPair } from './citations';
import type { RawRewrite } from './model';
import { yearCautions } from './shift';

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
  /** 사람이 읽는 위치(제목 사슬·'표 N (행,열)') — 실행기가 계획 뒤에 채운다(화면 '대조' 보기용) */
  location?: string;
}

/** 종류·상태의 한국어 이름 — 변경 내역표와 작업실 '대조' 보기가 함께 쓴다 */
export const CHANGE_KIND_LABEL: Record<ChangeKind, string> = {
  year: '연도',
  period: '기간',
  number: '수치',
  citation: '근거 인용',
  person: '담당자',
  date: '날짜',
  prose: '문장',
  table: '표 칸',
  structure: '구조',
};
export const CHANGE_STATUS_LABEL: Record<Change['status'], string> = { changed: '바꿈', needs_check: '확인 필요', proposed: '제안' };

export const EDIT_BLANK_CELL = '빈 칸은 한글에서 직접 채워 주세요';
export const EDIT_MULTI_PARAGRAPH_CELL = '여러 줄 칸은 한글에서 직접 고쳐 주세요';
export const EDIT_TABLE = '표는 한글에서 직접 고쳐 주세요';

/**
 * 직원이 이 변경에 올해 글을 넣을 수 없는 이유(없으면 null). 적용은 있는 문단의 글만 바꾼다 —
 * 글 없는 빈 칸(structure, 이웃 조각에 붙어 있음)과 여러 문단 칸은 문단 하나로 쓸 수 없어 파일 만들기가 PRIOR_MISMATCH로 멈춘다.
 */
export function changeEditBlock(c: Pick<Change, 'kind' | 'before'> & { after?: string | null }): string | null {
  // 넣을 값이 없는 구조 확인(열을 가리지 못한 표 등)은 빈 칸이 아니라 표 전체를 사람이 본다
  if (c.kind === 'structure') return c.after === null ? EDIT_TABLE : EDIT_BLANK_CELL;
  if (c.kind === 'table' && c.before.includes('\n')) return EDIT_MULTI_PARAGRAPH_CELL;
  return null;
}

/**
 * 파일에 아무것도 넣지 않는 바꿈 — 올해 글이 작년 글 그대로인 것(직원이 '확인함'으로 넘긴 확인 요청 등).
 * 적용·적용 확인은 이것을 건너뛴다(같은 문단의 다른 바꿈과 겹쳐 '한 문단에 둘'이 되지 않게)
 */
export function isNoopChange(c: Pick<Change, 'status' | 'before' | 'after'>): boolean {
  return c.status === 'changed' && c.after === c.before;
}

export const NOTE_ACKNOWLEDGED = '확인함';

/**
 * 확인 요청 하나를 '확인함'으로 넘긴다(순수, S6-1 I6). 그 행은 바꿈이 되지만 올해 글 = 작년 글이라 파일은 바뀌지 않는다 —
 * 근거 'user', 메모 끝에 '확인함'. 빈 칸·표 구조 확인처럼 글을 넣을 수 없는 행도 이 길로 닫는다. 확인 요청이 아니면 null
 */
export function acknowledgeChange(changes: Change[], change: Change): { changes: Change[]; target: Change } | null {
  if (change.status !== 'needs_check') return null;
  const target: Change = { ...change, status: 'changed', after: change.before, basis: ['user'], note: change.note ? `${change.note} · ${NOTE_ACKNOWLEDGED}` : NOTE_ACKNOWLEDGED };
  return { changes: changes.map((c) => (c.id === change.id ? target : c)), target };
}

/** 직원이 고친 문단의 남은 제안 — 옛 문단을 보고 만든 글이라 그대로 받아들이면 직원 글을 덮는다 */
export const NOTE_PROPOSAL_STALE = '이 문단은 직접 고쳐져 제안이 더 이상 맞지 않습니다';

/**
 * 직원 글 하나를 변경 목록에 넣는다(순수). 한 문단(조각)의 직원 글은 **한 줄뿐**이다:
 *  - 그 문단에 이미 직원이 고친 바꿈(근거 'user')이 있으면 어느 변경으로 저장하든 그 줄의 글을 바꾼다(둘째 줄을 만들지 않는다)
 *  - 없으면 고른 변경이 바꿈·근거 'user'가 된다
 *  - 같은 문단의 다른 바꿈(연도 밀기 등)은 직원 글에 담긴 것이라 빼고, 직원 줄의 메모에 `c1(연도)을 이 글에 담음`으로 남긴다
 *    (한 문단에 두 번 적용하면 XML이 깨진다)
 *  - 같은 문단의 제안은 확인 필요(올해 글 없음)로 내린다 — 옛 문단을 보고 만든 제안을 그대로 받아들이면 직원 글이 사라진다
 * 직원 줄이 이미 같은 글이면 null(새 판을 만들지 않는다).
 */
export function applyUserEdit(changes: Change[], change: Change, after: string): { changes: Change[]; target: Change } | null {
  // '확인함'으로 넘긴 행(작년 글 그대로)은 직원 글 줄이 아니다
  const userRow = changes.find((c) => c.segmentId === change.segmentId && c.status === 'changed' && c.basis.includes('user') && !isNoopChange(c));
  const target = userRow ?? change;
  if (target.status === 'changed' && target.after === after) return null;
  const absorbed = changes.filter((c) => c.segmentId === target.segmentId && c.id !== target.id && c.status === 'changed');
  const absorbedNote = absorbed.length ? `${absorbed.map((c) => `${c.id}(${CHANGE_KIND_LABEL[c.kind] ?? c.kind})`).join(', ')}을 이 글에 담음` : null;
  // 이미 직원 줄이면 앞서 담은 기록을 잇고, 새로 직원 줄이 되면 확인 요청 메모(수치 확인 등)는 끝난 것이라 지운다
  const note = [userRow ? userRow.note : null, absorbedNote].filter((n): n is string => !!n).join(' · ') || null;
  const updated: Change = { ...target, after, status: 'changed', basis: ['user'], note };
  const out = changes
    .filter((c) => !absorbed.includes(c))
    .map((c) => {
      if (c.id === target.id) return updated;
      if (c.segmentId === target.segmentId && c.status === 'proposed') return { ...c, status: 'needs_check' as const, after: null, note: NOTE_PROPOSAL_STALE };
      return c;
    });
  return { changes: out, target: updated };
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
  /** 작년(밀기 전) · 올해 */
  fromYear: number;
  toYear: number;
  /** 조각 id → 분류 결과. 지금 규칙은 쓰지 않는다(연도 밀기 결과가 shifted로 온다) — 계획 입력의 계약으로 받는다 */
  findings: Map<string, Finding[]>;
  /** 조각 id → 연도를 민 글 */
  shifted: Map<string, string>;
  tableCells: PlanTableCell[];
  rewrites: { accepted: RawRewrite[]; proposed: RawRewrite[] };
  citations: CitationPair[];
  numberStatus: Map<string, 'ok' | 'needs_check'>;
  /**
   * 조각 id → 올해 자료에서 확인되지 않은 수치(글 그대로). 받아들인 고치기가 이 수치를 모두 지웠을 때만 수치 확인 요청을 내리지 않는다.
   * 없으면(이 조각에 대한 기록이 없으면) 확인 요청은 언제나 남는다
   */
  numberTokens?: Map<string, string[]>;
  /** 표 계획이 머리글 연도를 민 칸의 조각 — 다른 연도가 함께 있어도(전년도 열 2024 → 2025) 확인 요청으로 내리지 않는다 */
  plannedYearSegments?: Set<string>;
}

export const NOTE_UNIT_UNKNOWN = '단위를 알 수 없어 그대로 넣었습니다 — 확인하세요';
export const NOTE_CITATION_CHANGED = '근거 조문이 바뀜 — 문장을 확인하세요';
export const NOTE_CITATION_NOT_FOUND = '현재 조문을 찾지 못함';
export const NOTE_NUMBER = '올해 자료에서 확인되지 않은 숫자가 있습니다 — 확인하세요';
export const NOTE_STALE_YEAR = '지난해 연도가 남아 있습니다 — 확인하세요';
export const NOTE_DUPLICATE_CELL = '같은 칸에 변경이 둘 이상입니다';
/** 밀린 날짜 — 요일·날짜가 올해에도 맞는지 프로그램은 모른다 */
export const NOTE_DATE = '일정 확인 — 요일·날짜를 확인하세요';
/** fromYear 아닌 연도가 함께 있는 문장 — 한 해만 밀면 비교가 어긋난다 */
export const NOTE_MIXED_YEAR = '다른 연도가 함께 있어 확인하세요';

/** 숫자 덩어리가 글에 (숫자 경계에서) 남아 있는가 — '1,200'은 '11,200'에 들지 않는다 */
function stillHasNumber(text: string, token: string): boolean {
  const escaped = token.replace(/[.,]/g, (c) => `\\${c}`);
  return new RegExp(String.raw`(?<![\d,.])${escaped}(?![\d]|[,.]\d)`).test(text);
}

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

/** 지난해 연도 표지(`2025년` · `'25`)의 개수 */
function staleYearCount(text: string, fromYear: number): number {
  const yy = String(fromYear % 100).padStart(2, '0');
  const full = new RegExp(String.raw`(?<!\d)${fromYear}년`, 'g');
  const short = new RegExp(String.raw`['’‘]\s?${yy}(?!\d)`, 'g');
  return (text.match(full) ?? []).length + (text.match(short) ?? []).length;
}

/**
 * 조각 하나의 변경들. tableCell이면 표 계산이 이 문단의 글을 정하므로 다른 changed(받아들인 고치기·연도 밀기)는 내지 않는다 —
 * 받아들인 고치기는 제안으로 남기고, 확인 요청(숫자·인용)은 그대로 낸다.
 */
function segmentChanges(
  s: Segment,
  p: PlanInput,
  accepted: Map<string, RawRewrite>,
  proposed: Map<string, RawRewrite[]>,
  tableCell: boolean
): Draft[] {
  const base = { segmentId: s.id, before: s.text, basis: [] as string[], note: null as string | null };
  const shifted = p.shifted.get(s.id);
  const shiftedText = shifted ?? s.text;
  // 밀어 둔 글과 같은 고치기는 고치기가 아니다(아무것도 바꾸지 않고 확인 요청만 지운다)
  const noop = (r: RawRewrite) => r.text === shiftedText;
  const acceptedRewrite = accepted.get(s.id);
  const rewrite = acceptedRewrite && !noop(acceptedRewrite) ? acceptedRewrite : undefined;

  // 연도 밀기의 확인 사유 — 밀린 날짜·다른 연도(표 계획이 민 머리글 칸은 계획대로라 빼고)
  const cautions = !tableCell && shiftedText !== s.text && !p.plannedYearSegments?.has(s.id) ? yearCautions(s.text, p.findings.get(s.id) ?? [], p.fromYear) : [];
  const cautionNote = cautions.length ? cautions.map((c) => (c === 'date' ? NOTE_DATE : NOTE_MIXED_YEAR)).join(' · ') : null;

  // 확인 요청(숫자·인용) — 받아들인 고치기가 있어도 그 표지가 고친 글에 남아 있으면 그대로 낸다
  const checks = (text: string | null): Draft[] => {
    const out: Draft[] = [];
    if (p.numberStatus.get(s.id) === 'needs_check') {
      const tokens = p.numberTokens?.get(s.id);
      const stays = text === null || !tokens || tokens.length === 0 || tokens.some((t) => stillHasNumber(text, t));
      if (stays) out.push({ ...base, kind: 'number', after: null, status: 'needs_check', note: NOTE_NUMBER });
    }
    const pairs = p.citations.filter((c) => c.segmentId === s.id);
    const citeStays = (status: CitationPair['status']) =>
      pairs.some((c) => c.status === status && (text === null || text.includes(c.cited.article ?? c.cited.name) || !(c.cited.article ?? c.cited.name)));
    if (citeStays('changed')) out.push({ ...base, kind: 'citation', after: null, status: 'needs_check', note: NOTE_CITATION_CHANGED });
    if (citeStays('not_found')) out.push({ ...base, kind: 'citation', after: null, status: 'needs_check', note: NOTE_CITATION_NOT_FOUND });
    return out;
  };

  // 1) 받아들인 고치기가 이긴다 — 모델은 연도를 민 글을 받아 고치므로 연도 밀기를 따로 하지 않는다.
  //    다만 밀어 둔 글보다 지난해 연도가 많으면(모델이 옛 글을 따랐거나 연도를 되돌림) 넣지 않고 제안으로.
  //    날짜·다른 연도가 든 문장이면 고친 글을 넣지 않고 확인 요청으로(올해 글로 보인다)
  if (rewrite && !tableCell) {
    const stale = staleYearCount(rewrite.text, p.fromYear) > staleYearCount(shiftedText, p.fromYear);
    const head: Draft = stale
      ? { ...base, kind: 'prose', after: rewrite.text, status: 'proposed', basis: [...rewrite.basis], note: NOTE_STALE_YEAR }
      : cautionNote
        ? { ...base, kind: 'prose', after: rewrite.text, status: 'needs_check', basis: [...rewrite.basis], note: cautionNote }
        : { ...base, kind: 'prose', after: rewrite.text, status: 'changed', basis: [...rewrite.basis] };
    return [head, ...checks(rewrite.text)];
  }

  const out: Draft[] = [];
  // 2) 연도 밀기 — 글이 실제로 바뀐 때만. 날짜·다른 연도가 함께 있으면 확인 요청(올해 글은 밀린 글)
  if (!tableCell && shifted !== undefined && shifted !== s.text) {
    out.push(
      cautionNote
        ? { ...base, kind: cautions.includes('date') ? 'date' : 'year', after: shifted, status: 'needs_check', note: cautionNote }
        : { ...base, kind: 'year', after: shifted, status: 'changed' }
    );
  }
  // 3) 근거가 모자란 고치기는 제안으로만(파일에 넣지 않는다). 밀어 둔 글과 같은 고치기는 버린다
  const suggestions = [...(acceptedRewrite ? [acceptedRewrite] : []), ...(proposed.get(s.id) ?? [])].filter((r) => !noop(r));
  for (const r of suggestions) out.push({ ...base, kind: 'prose', after: r.text, status: 'proposed', basis: [...r.basis] });
  // 4) 본문 숫자는 프로그램도 모델도 바꾸지 않는다 — 올해 자료에 없는 숫자는 사람이 본다
  // 5) 인용 — 같은 조각의 같은 상태는 하나로(바뀜 먼저)
  out.push(...checks(null));
  return out;
}

/**
 * 변경 목록. 조각 순서대로 — 표 칸 조각은 표 변경을 먼저, 그다음 확인 요청·제안.
 * 조각 목록에 없는 칸 조각은 맨 뒤에 입력 순서로(적용할 때 풀리지 않으면 PRIOR_MISMATCH로 드러난다).
 * 한 조각에 changed는 하나뿐이다 — 둘째부터는 확인 요청으로 내린다(한 문단에 두 번 적용하면 XML이 깨진다).
 */
export function buildPlan(p: PlanInput): Change[] {
  const accepted = new Map<string, RawRewrite>();
  for (const r of p.rewrites.accepted) if (!accepted.has(r.segmentId)) accepted.set(r.segmentId, r);
  const proposed = new Map<string, RawRewrite[]>();
  for (const r of p.rewrites.proposed) {
    const list = proposed.get(r.segmentId);
    if (list) list.push(r);
    else proposed.set(r.segmentId, [r]);
  }
  const cellsBySegment = new Map<string, PlanTableCell[]>();
  for (const t of p.tableCells) {
    const list = cellsBySegment.get(t.segmentId);
    if (list) list.push(t);
    else cellsBySegment.set(t.segmentId, [t]);
  }

  const drafts: Draft[] = [];
  const known = new Set<string>();
  for (const s of p.segments) {
    known.add(s.id);
    const cells = cellsBySegment.get(s.id);
    if (cells) drafts.push(...cells.map(tableChange));
    drafts.push(...segmentChanges(s, p, accepted, proposed, cells !== undefined));
  }
  for (const t of p.tableCells) if (!known.has(t.segmentId)) drafts.push(tableChange(t));

  const hasChanged = new Set<string>();
  for (const d of drafts) {
    if (d.status !== 'changed') continue;
    if (hasChanged.has(d.segmentId)) {
      d.status = 'needs_check';
      // 표 계산이 단 메모는 지우지 않고 잇는다
      d.note = d.note ? `${d.note} · ${NOTE_DUPLICATE_CELL}` : NOTE_DUPLICATE_CELL;
    } else hasChanged.add(d.segmentId);
  }

  return drafts.map((d, i) => ({ id: `c${i + 1}`, ...d }));
}
