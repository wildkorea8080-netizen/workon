// src/lib/edition-compare.ts
// 비서 문서 두 판(옛 판 ↔ 새 판)의 글을 문단 단위로 맞대어 바뀐 곳을 찾는다(신구 대비, 2026-11-05).
// 순수 함수 — DB·저장소·파일 형식을 모른다. 글은 부르는 쪽이 첨부 읽기(readAttachment)로 뽑아 넘긴다.
//
// 지키는 것
// - 모델을 쓰지 않는다. 같은 두 글은 언제나 같은 결과다(감사 자료로 쓸 수 있게).
// - 띄어쓰기만 다른 문단은 같은 문단으로 본다('제 3 조'와 '제3조'). 글자가 하나라도 다르면 바뀐 문단이다.
// - 너무 크면 짐작하지 않고 멈춘다 — 대조표가 틀리면 바뀐 조문을 못 보고 지나간다.

import { numberedHeadingLevel } from '@/lib/doc-fill/slots';

/** 판 하나에서 대조하는 문단 수 상한. 넘으면 앞의 것만 맞대고 truncated */
export const MAX_COMPARE_PARAGRAPHS = 6_000;
/** 같은 앞·뒤를 뗀 가운데 부분의 맞대기 칸 수(옛 문단 × 새 문단) 상한 — 메모리 약 24MB */
export const MAX_DIFF_CELLS = 12_000_000;
/** 바뀐 문단 안 낱말 대조의 낱말 수 상한(한쪽). 넘으면 문단 전체를 바뀐 것으로 칠한다 */
export const MAX_INLINE_TOKENS = 600;
/** 지운 문단과 새 문단을 '고친 문단'으로 짝짓는 닮음 하한(글자 두 개씩 묶은 Dice 계수) */
export const PAIR_SIMILARITY = 0.5;
/** 바뀐 곳 앞뒤로 남기는 같은 문단 수 */
export const CONTEXT_PARAGRAPHS = 1;
/** 짝을 찾을 때 앞으로 내다보는 새 문단 수 */
const PAIR_LOOKAHEAD = 20;

export class EditionCompareError extends Error {}

export interface InlinePart {
  text: string;
  /** 옛 판 쪽에서는 지운 글, 새 판 쪽에서는 넣은 글 */
  changed: boolean;
}

export type CompareRow =
  | { kind: 'same'; text: string; location: string | null }
  | { kind: 'skip'; count: number }
  | { kind: 'changed'; old: InlinePart[]; new: InlinePart[]; location: string | null }
  | { kind: 'removed'; old: string; location: string | null }
  | { kind: 'added'; new: string; location: string | null };

export interface EditionComparison {
  identical: boolean;
  rows: CompareRow[];
  stats: { same: number; changed: number; removed: number; added: number };
  /** 문단이 상한을 넘어 앞의 것만 맞댔다 */
  truncated: boolean;
}

/** 바뀐 곳 요약 한 줄 — 비교 창 머리와 엑셀 안내 시트가 함께 쓴다 */
export function compareSummary(stats: EditionComparison['stats']): string {
  const parts: string[] = [];
  if (stats.changed) parts.push(`고친 문단 ${stats.changed.toLocaleString('ko-KR')}개`);
  if (stats.removed) parts.push(`지운 문단 ${stats.removed.toLocaleString('ko-KR')}개`);
  if (stats.added) parts.push(`새 문단 ${stats.added.toLocaleString('ko-KR')}개`);
  return parts.length ? parts.join(' · ') : '바뀐 문단이 없습니다';
}

/** 화면에 보이는 꼴 — NFC, 보이지 않는 서식 글자 제거, 공백 하나로 */
export function normalizeParagraph(line: string): string {
  return line.normalize('NFC').replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim();
}

/** 같은지 가르는 열쇠 — 띄어쓰기를 모두 뺀다 */
function keyOf(text: string): string {
  return text.replace(/\s+/g, '');
}

export function splitParagraphs(text: string): { paragraphs: string[]; truncated: boolean } {
  const all = text.split(/\r\n|\r|\n/).map(normalizeParagraph).filter((p) => p.length > 0);
  if (all.length <= MAX_COMPARE_PARAGRAPHS) return { paragraphs: all, truncated: false };
  return { paragraphs: all.slice(0, MAX_COMPARE_PARAGRAPHS), truncated: true };
}

type Op = { op: 'eq'; a: number; b: number } | { op: 'del'; a: number } | { op: 'ins'; b: number };

/**
 * 가장 긴 공통 부분열로 두 열쇠 목록을 맞댄다. 같은 앞·뒤를 먼저 떼고 가운데만 표로 센다.
 * 같은 길이의 답이 여럿이면 지운 것을 넣은 것보다 앞에 둔다(옛 판 → 새 판 순서로 읽히게).
 */
function diffKeys<T>(a: T[], b: T[], maxCells: number, onTooBig: () => never): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  const ops: Op[] = [];
  for (let i = 0; i < start; i++) ops.push({ op: 'eq', a: i, b: i });

  if (n > 0 && m > 0) {
    if ((n + 1) * (m + 1) > maxCells) onTooBig();
    // lcs[i][j] = a[start+i..] 와 b[start+j..]의 공통 부분열 길이. 가운데는 6,000 이하라 Uint16에 든다
    const w = m + 1;
    const lcs = new Uint16Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = a[start + i] === b[start + j]
          ? lcs[(i + 1) * w + j + 1] + 1
          : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) {
        ops.push({ op: 'eq', a: start + i, b: start + j });
        i++;
        j++;
      } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
        ops.push({ op: 'del', a: start + i });
        i++;
      } else {
        ops.push({ op: 'ins', b: start + j });
        j++;
      }
    }
    for (; i < n; i++) ops.push({ op: 'del', a: start + i });
    for (; j < m; j++) ops.push({ op: 'ins', b: start + j });
  } else {
    for (let i = 0; i < n; i++) ops.push({ op: 'del', a: start + i });
    for (let j = 0; j < m; j++) ops.push({ op: 'ins', b: start + j });
  }

  for (let k = 0; k < a.length - endA; k++) ops.push({ op: 'eq', a: endA + k, b: endB + k });
  return ops;
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** 두 글의 닮음(0~1) — 띄어쓰기를 뺀 글자 두 개씩 묶음의 Dice 계수 */
export function paragraphSimilarity(x: string, y: string): number {
  const a = keyOf(x);
  const b = keyOf(y);
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const ga = bigrams(a);
  const gb = bigrams(b);
  let common = 0;
  for (const [g, c] of ga) common += Math.min(c, gb.get(g) ?? 0);
  return (2 * common) / (a.length - 1 + (b.length - 1));
}

/** 낱말 조각 — 글자 덩어리·숫자 덩어리·공백·그 밖의 글자 하나씩. '100만원'은 '100'·'만원'이라 숫자만 바뀐 것이 보인다 */
function tokenize(s: string): string[] {
  return s.match(/[\p{L}\p{M}]+|\p{N}+|\s+|[^\s\p{L}\p{M}\p{N}]/gu) ?? [];
}

function mergeParts(parts: InlinePart[]): InlinePart[] {
  const out: InlinePart[] = [];
  for (const p of parts) {
    if (!p.text) continue;
    const last = out[out.length - 1];
    if (last && last.changed === p.changed) last.text += p.text;
    else out.push({ ...p });
  }
  return out;
}

/** 고친 문단 안에서 바뀐 낱말을 칠한다. 공백 차이는 바뀐 것으로 치지 않는다 */
export function inlineDiff(oldText: string, newText: string): { old: InlinePart[]; new: InlinePart[] } {
  const a = tokenize(oldText);
  const b = tokenize(newText);
  if (a.length > MAX_INLINE_TOKENS || b.length > MAX_INLINE_TOKENS) {
    return { old: [{ text: oldText, changed: true }], new: [{ text: newText, changed: true }] };
  }
  const key = (t: string) => (/^\s+$/.test(t) ? ' ' : t);
  const ops = diffKeys(a.map(key), b.map(key), Number.MAX_SAFE_INTEGER, () => {
    throw new EditionCompareError('낱말 대조 상한');
  });
  const oldParts: InlinePart[] = [];
  const newParts: InlinePart[] = [];
  for (const o of ops) {
    if (o.op === 'eq') {
      oldParts.push({ text: a[o.a], changed: false });
      newParts.push({ text: b[o.b], changed: false });
    } else if (o.op === 'del') {
      oldParts.push({ text: a[o.a], changed: !/^\s+$/.test(a[o.a]) });
    } else {
      newParts.push({ text: b[o.b], changed: !/^\s+$/.test(b[o.b]) });
    }
  }
  return { old: mergeParts(oldParts), new: mergeParts(newParts) };
}

const ARTICLE = /^(제\s*\d+\s*조(?:\s*의\s*\d+)?)\s*(\([^)]{0,40}\))?/;

/** 조문 제목이면 '제12조(여비)'처럼, 아니면 null */
export function articleHeading(paragraph: string): string | null {
  const m = ARTICLE.exec(paragraph);
  if (!m) return null;
  return m[1].replace(/\s+/g, '') + (m[2] ?? '');
}

/** 위치 제목으로 쓰는 번호 제목(Ⅰ.·1.·가.…)의 최대 길이 — 길면 번호 매긴 본문 문장이다 */
const MAX_SECTION_HEADING_CHARS = 40;

/**
 * 위치 제목 — 조문 제목('제12조(여비)')이 먼저, 아니면 짧은 번호 제목('Ⅱ. 추진 경과').
 * 개조식 글머리(○·-)는 제목이 아니다(doc-fill의 numberedHeadingLevel과 같은 판정).
 */
export function sectionHeading(paragraph: string): string | null {
  const article = articleHeading(paragraph);
  if (article) return article;
  if (paragraph.length <= MAX_SECTION_HEADING_CHARS && numberedHeadingLevel(paragraph) !== null) return paragraph;
  return null;
}

/**
 * 옛 판 글과 새 판 글을 문단 단위로 맞댄다.
 * 바뀐 곳마다 앞뒤 같은 문단 CONTEXT_PARAGRAPHS개를 남기고 나머지는 'skip'으로 접는다.
 * 행의 location은 그 문단이 든 조문·번호 제목(새 판 쪽 기준, 지운 문단은 옛 판 쪽).
 */
export function compareEditions(oldText: string, newText: string): EditionComparison {
  const A = splitParagraphs(oldText);
  const B = splitParagraphs(newText);
  const a = A.paragraphs;
  const b = B.paragraphs;
  const ops = diffKeys(a.map(keyOf), b.map(keyOf), MAX_DIFF_CELLS, () => {
    throw new EditionCompareError(
      '두 판의 차이가 너무 커서 문단 대조를 할 수 없습니다. 서로 다른 문서이거나 전체를 다시 쓴 판인지 확인해 주세요.'
    );
  });

  // 조문 위치 — 맞댐 순서대로 읽으며 양쪽의 마지막 조문 제목을 기억한다
  let oldHeading: string | null = null;
  let newHeading: string | null = null;
  const seeOld = (i: number) => {
    oldHeading = sectionHeading(a[i]) ?? oldHeading;
    return oldHeading;
  };
  const seeNew = (j: number) => {
    newHeading = sectionHeading(b[j]) ?? newHeading;
    return newHeading;
  };

  type Full = Exclude<CompareRow, { kind: 'skip' }>;
  const full: Full[] = [];
  const stats = { same: 0, changed: 0, removed: 0, added: 0 };

  let k = 0;
  while (k < ops.length) {
    const o = ops[k];
    if (o.op === 'eq') {
      seeOld(o.a);
      // 같은 문단은 새 판 글로 보인다(띄어쓰기가 다를 수 있다)
      full.push({ kind: 'same', text: b[o.b], location: seeNew(o.b) });
      stats.same++;
      k++;
      continue;
    }
    // 바뀐 덩어리 — 지운 문단과 넣은 문단을 모은 뒤 닮은 것끼리 짝짓는다(순서를 지키며)
    const dels: number[] = [];
    const ins: number[] = [];
    while (k < ops.length && ops[k].op !== 'eq') {
      const x = ops[k] as Extract<Op, { op: 'del' }> | Extract<Op, { op: 'ins' }>;
      if (x.op === 'del') dels.push(x.a);
      else ins.push(x.b);
      k++;
    }
    let j = 0;
    const emitAdded = (bi: number) => {
      full.push({ kind: 'added', new: b[bi], location: seeNew(bi) });
      stats.added++;
    };
    for (const ai of dels) {
      let found = -1;
      for (let t = j; t < ins.length && t < j + PAIR_LOOKAHEAD; t++) {
        if (paragraphSimilarity(a[ai], b[ins[t]]) >= PAIR_SIMILARITY) {
          found = t;
          break;
        }
      }
      if (found < 0) {
        full.push({ kind: 'removed', old: a[ai], location: seeOld(ai) });
        stats.removed++;
        continue;
      }
      for (; j < found; j++) emitAdded(ins[j]);
      seeOld(ai);
      const parts = inlineDiff(a[ai], b[ins[found]]);
      full.push({ kind: 'changed', old: parts.old, new: parts.new, location: seeNew(ins[found]) });
      stats.changed++;
      j = found + 1;
    }
    for (; j < ins.length; j++) emitAdded(ins[j]);
  }

  const identical = stats.changed + stats.removed + stats.added === 0;
  const rows: CompareRow[] = [];
  if (!identical) {
    const keep = full.map(() => false);
    full.forEach((r, i) => {
      if (r.kind === 'same') return;
      for (let d = -CONTEXT_PARAGRAPHS; d <= CONTEXT_PARAGRAPHS; d++) {
        if (i + d >= 0 && i + d < full.length) keep[i + d] = true;
      }
    });
    let skipped = 0;
    full.forEach((r, i) => {
      if (keep[i]) {
        if (skipped) rows.push({ kind: 'skip', count: skipped });
        skipped = 0;
        rows.push(r);
      } else {
        skipped++;
      }
    });
    if (skipped) rows.push({ kind: 'skip', count: skipped });
  }

  return { identical, rows, stats, truncated: A.truncated || B.truncated };
}
