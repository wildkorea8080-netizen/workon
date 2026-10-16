import { paragraphPrefix, scanTags, type XmlTag } from './xml-scan';
import { headingLevel, isPlaceholderText, normalizeLabel } from './slots';
import {
  openHwpx,
  readEntry,
  scanParagraphs,
  freshParagraph,
  valueLines,
  dedupeDeletes,
  applyEdits,
  ancestorLineSegDeletes,
  writeHwpx,
  CHAR_PR,
  type Para,
  type Edit,
} from './hwpx-core';

/**
 * 표시({{이름}})가 없는 HWPX에서 채울 자리를 스스로 찾는다(설계 4.1, S2-b).
 *
 * - section: 본문 최상위의 번호 제목 아래, 다음 최상위 제목 전까지의 빈 문단·자리 표시 문단.
 *   그 영역에 이미 글이 쓰인 문단이 하나라도 있으면 자리가 아니다
 * - cell: 표에서 비었거나 자리 표시만 든 칸. 이름은 왼쪽 항목명 칸, 왼쪽이 없으면 첫 행의 열 머리.
 *   행이 '행 머리(0열) + 빈 데이터 칸' 꼴이고 첫 행에 열 머리가 있으면 '행 머리 / 열 머리'
 *
 * 읽기와 채우기는 같은 바이트에서 같은 함수(locateSlots)로 자리를 다시 계산한다 —
 * 자리 id(s1..)가 둘 사이의 약속이라 결정적이어야 한다.
 * 고칠 때는 채울 문단의 구간만 바꾸고, 새 문단은 원래 문단을 복제하지 않고 새로 만든다.
 */

export interface AutoSlot {
  id: string;
  label: string;
  kind: 'section' | 'cell';
  path: string[];
  hint: string | null;
}

interface Located {
  slot: Omit<AutoSlot, 'id'>;
  /** 문서 순서를 정하는 위치(제목 문단 · 칸의 시작) */
  pos: number;
  /** 글을 넣을 문단(통째로 새 문단들로 바뀐다) */
  target: Para;
  /** 같은 자리의 나머지 채울 수 있는 문단 — 자리 표시 글이 있으면 지운다 */
  rest: Para[];
}

/** 채울 수 있는 문단 안에 와도 되는 태그(접두어 뗀 이름). 그 밖의 것은 모두 컨트롤로 본다 */
const INLINE = new Set(['p', 'run', 't', 'linesegarray', 'lineseg', 'tab', 'lineBreak', 'fwSpace', 'hwSpace']);

/** start 이상에서 시작하는 첫 태그의 순번 */
function firstTagAt(tags: XmlTag[], start: number): number {
  let lo = 0;
  let hi = tags.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tags[mid].start < start) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 문단 안에 글 조각 말고 다른 것(구역 설정·컨트롤·표·그림 등)이 없는가 */
function inlineOnly(para: Para, tags: XmlTag[], prefix: string): boolean {
  const head = `${prefix}:`;
  for (let i = firstTagAt(tags, para.start); i < tags.length && tags[i].start < para.end; i++) {
    const name = tags[i].name;
    if (!name.startsWith(head) || !INLINE.has(name.slice(head.length))) return false;
  }
  return true;
}

/**
 * 새 문단이 쓸 글자 서식. 첫 글 조각의 것, 조각이 없는 빈 문단이면 그 문단 첫 조각(run)의 것.
 * 한글은 빈 문단에도 글자 서식만 든 빈 조각을 남기는데, 그것이 그 자리에 칠 글의 서식이다
 */
function charPrOf(para: Para, xml: string, tags: XmlTag[], prefix: string): string | null {
  if (para.pieces.length > 0) return para.pieces[0].charPr;
  const run = `${prefix}:run`;
  for (let i = firstTagAt(tags, para.start); i < tags.length && tags[i].start < para.end; i++) {
    const tag = tags[i];
    if (tag.name === run && tag.kind !== 'close') {
      const m = xml.slice(tag.start, tag.end).match(CHAR_PR);
      return m ? (m[1] ?? m[2]) : null;
    }
  }
  return null;
}

interface Cell {
  /** 칸 주소(cellAddr)가 있으면 그것, 없으면 표 안 행 순번과 행 안 순서 */
  row: number;
  col: number;
  start: number;
  /** 이 칸에 바로 든 문단의 시작 위치(안쪽 표의 문단은 제외) */
  paras: number[];
}

interface Table {
  /** 표를 품은 최상위 문단의 시작 */
  topStart: number;
  cells: Cell[];
}

/** 숫자뿐인 글(100 · 1,200 · -3.5 · 12%). 행 안의 값이지 항목명이 아니다 */
const NUMBER_ONLY = /^[+-]?\d[\d,.]*%?$/;

const ATTR = (name: string) => new RegExp(`\\s${name}\\s*=\\s*(?:"(\\d+)"|'(\\d+)')`);
const COL_ADDR = ATTR('colAddr');
const ROW_ADDR = ATTR('rowAddr');

/** 표 구조: 표마다 칸과 칸에 바로 든 문단 */
function scanTables(xml: string, tags: XmlTag[], prefix: string): Table[] {
  const P = `${prefix}:p`;
  const TBL = `${prefix}:tbl`;
  const TR = `${prefix}:tr`;
  const TC = `${prefix}:tc`;
  const ADDR = `${prefix}:cellAddr`;

  interface Frame {
    topStart: number;
    cells: Cell[];
    row: number;
    col: number;
    cell: Cell | null;
    /** 칸이 열릴 때의 문단 깊이 — 이 깊이에서 열리는 문단이 칸에 바로 든 문단 */
    depth: number;
    addr: { row: number | null; col: number | null };
  }
  const pStack: number[] = [];
  const frames: Frame[] = [];
  const out: Table[] = [];

  const closeCell = (f: Frame) => {
    if (f.cell && f.addr.row !== null && f.addr.col !== null) {
      f.cell.row = f.addr.row;
      f.cell.col = f.addr.col;
    }
    f.cell = null;
  };

  for (const tag of tags) {
    const top = frames.length > 0 ? frames[frames.length - 1] : null;
    if (tag.name === P) {
      if (tag.kind === 'open') {
        if (top?.cell && pStack.length === top.depth) top.cell.paras.push(tag.start);
        pStack.push(tag.start);
      } else if (tag.kind === 'close') {
        pStack.pop();
      }
    } else if (tag.name === TBL) {
      if (tag.kind === 'open') {
        frames.push({ topStart: pStack[0] ?? tag.start, cells: [], row: -1, col: 0, cell: null, depth: 0, addr: { row: null, col: null } });
      } else if (tag.kind === 'close' && top) {
        closeCell(top);
        frames.pop();
        out.push({ topStart: top.topStart, cells: top.cells });
      }
    } else if (!top) {
      continue;
    } else if (tag.name === TR && tag.kind === 'open') {
      top.row++;
      top.col = 0;
    } else if (tag.name === TC) {
      if (tag.kind === 'open') {
        closeCell(top);
        top.cell = { row: top.row, col: top.col++, start: tag.start, paras: [] };
        top.cells.push(top.cell);
        top.depth = pStack.length;
        top.addr = { row: null, col: null };
      } else if (tag.kind === 'close') {
        closeCell(top);
      }
    } else if (tag.name === ADDR && tag.kind !== 'close' && top.cell && pStack.length === top.depth) {
      const src = xml.slice(tag.start, tag.end);
      const c = src.match(COL_ADDR);
      const r = src.match(ROW_ADDR);
      top.addr = { col: c ? Number(c[1] ?? c[2]) : null, row: r ? Number(r[1] ?? r[2]) : null };
    }
  }
  return out;
}

interface SectionScan {
  slots: Located[];
  tags: XmlTag[];
  byStart: Map<number, Para>;
}

/** 한 섹션 XML의 자리(문서 순서)와, 채우기가 다시 쓸 훑은 결과 */
function locateSlots(xml: string, prefix: string): SectionScan {
  const tags = scanTags(xml);
  const paras = scanParagraphs(xml, prefix);
  const byStart = new Map(paras.map((p) => [p.start, p]));
  const fillable = (p: Para) => !p.hasChild && isPlaceholderText(p.text) && inlineOnly(p, tags, prefix);
  const out: Located[] = [];

  // ── section: 최상위 문단을 차례로. 자리 표시 글은 제목보다 먼저 본다(○○○은 제목이 아니다)
  const chain: { level: number; label: string }[] = [];
  /** 제목마다 그 시점의 제목 사슬(자기 포함) — 표 칸의 경로에 쓴다 */
  const chains: { start: number; labels: string[] }[] = [];
  let open: { heading: Para; label: string; path: string[]; fills: Para[]; written: boolean } | null = null;
  const close = () => {
    // 이미 글이 쓰인 영역은 자리가 아니다 — 본문 위·아래의 빈 줄에 쓰면 기존 글과 섞인다
    if (open && !open.written && open.fills.length > 0) {
      const [target, ...rest] = open.fills;
      out.push({
        slot: { label: open.label, kind: 'section', path: open.path, hint: target.text.trim() || null },
        pos: open.heading.start,
        target,
        rest,
      });
    }
    open = null;
  };
  for (const p of paras) {
    if (p.ancestors.length > 0) continue;
    const level = isPlaceholderText(p.text) ? null : headingLevel(p.text);
    if (level !== null) {
      close();
      // 같은 급 이상의 앞선 제목은 다른 갈래다 — 사슬에서 뺀다
      while (chain.length > 0 && chain[chain.length - 1].level >= level) chain.pop();
      const label = p.text.trim();
      open = { heading: p, label, path: chain.map((h) => h.label), fills: [], written: false };
      chain.push({ level, label });
      chains.push({ start: p.start, labels: chain.map((h) => h.label) });
    } else if (open) {
      if (!isPlaceholderText(p.text)) open.written = true;
      else if (fillable(p)) open.fills.push(p);
    }
  }
  close();

  const pathAt = (start: number): string[] => {
    let found: string[] = [];
    for (const c of chains) {
      if (c.start < start) found = c.labels;
      else break;
    }
    return found;
  };

  // ── cell
  for (const table of scanTables(xml, tags, prefix)) {
    const info = table.cells.map((cell) => {
      const cps = cell.paras.map((s) => byStart.get(s)).filter((p): p is Para => p !== undefined);
      const texts = cps.map((p) => p.text.trim()).filter(Boolean);
      return {
        cell,
        paras: cps,
        blank: cps.every((p) => isPlaceholderText(p.text)),
        label: normalizeLabel(texts.join(' ')),
        hint: texts.join(' ') || null,
      };
    });
    const usable = (c: (typeof info)[number] | undefined) => (c && !c.blank && c.label ? c : null);
    for (const me of info) {
      if (me.paras.length === 0 || !me.paras.every(fillable)) continue;
      const { row, col } = me.cell;
      // 왼쪽: 같은 행에서 가장 가까운 항목명 칸
      const left = info
        .filter((o) => o.cell.row === row && o.cell.col < col)
        .sort((a, b) => b.cell.col - a.cell.col)
        // 숫자뿐인 칸은 값이다 — [예산|100|빈칸]의 빈칸 이름은 '100'이 아니라 '예산'.
        // 열 머리에는 이 거름을 걸지 않는다('2026' 같은 연도 열 머리가 흔하다)
        .find((o) => usable(o) && !NUMBER_ONLY.test(o.label));
      // 위쪽은 첫 행(열 머리)에서만 — 바로 위 행의 칸은 대개 값이다('홍길동'이 항목명이 되면 안 된다)
      const header = row > 0 ? usable(info.find((o) => o.cell.row === 0 && o.cell.col === col)) : null;
      // 열 머리는 '행 머리(0열) + 빈 데이터 칸' 꼴의 행에서만 붙인다. 항목·값이 번갈아 놓인
      // 서식([성명|홍길동|소속|총무과])의 첫 행은 값이라 열 머리가 아니다
      const matrixRow =
        left !== undefined &&
        left.cell.col === 0 &&
        info.every((o) => o.cell.row !== row || o.cell.col === 0 || o.blank);
      let label: string;
      if (left) label = matrixRow && header && header.cell.col !== left.cell.col ? `${left.label} / ${header.label}` : left.label;
      else if (header) label = header.label;
      else continue;
      const [target, ...rest] = me.paras;
      out.push({
        slot: { label, kind: 'cell', path: pathAt(table.topStart), hint: me.hint },
        pos: me.cell.start,
        target,
        rest,
      });
    }
  }

  return { slots: out.sort((a, b) => a.pos - b.pos), tags, byStart };
}

/** 자리 하나를 채우는 편집 */
function planFill(loc: Located, value: string, xml: string, tags: XmlTag[], prefix: string, byStart: Map<number, Para>): Edit[] {
  const { target, rest } = loc;
  const lines = valueLines(value);
  const charPr = charPrOf(target, xml, tags, prefix);
  // 첫 줄은 원래 여는 태그 그대로(쪽·단 나눔 포함), 이어지는 줄은 나눔을 끈 새 문단.
  // freshParagraph에 빈 여는 태그를 주면 조각과 닫는 태그만 나온다
  const first = target.openTag + freshParagraph('', charPr, lines[0], prefix);
  const extra = lines.slice(1).map((line) => freshParagraph(target.openTag, charPr, line, prefix));
  const edits: Edit[] = [{ start: target.start, end: target.end, text: first + extra.join('') }];
  for (const p of rest) {
    if (!p.text.trim()) continue; // 빈 문단은 그대로
    for (const piece of p.pieces) edits.push({ start: piece.start, end: piece.end, text: '' });
    for (const seg of p.lineSegs) edits.push({ start: seg.start, end: seg.end, text: '' });
  }
  // 표 칸이 바뀌면 그것을 품은 문단들의 옛 줄 배치(표 높이 포함)는 낡는다
  edits.push(...ancestorLineSegDeletes(target, byStart));
  return edits;
}

export async function readHwpxAutoSlots(bytes: Buffer): Promise<AutoSlot[]> {
  const { zip, sections } = await openHwpx(bytes);
  const slots: AutoSlot[] = [];
  for (const name of sections) {
    const xml = await readEntry(zip, name);
    for (const loc of locateSlots(xml, paragraphPrefix(xml)).slots) slots.push({ id: `s${slots.length + 1}`, ...loc.slot });
  }
  return slots;
}

export async function fillHwpxAutoSlots(
  bytes: Buffer,
  values: Map<string, string>
): Promise<{ bytes: Buffer; filled: string[]; unfilled: string[] }> {
  const doc = await openHwpx(bytes);
  const filled: string[] = [];
  const unfilled: string[] = [];
  const edited = new Map<string, string>();
  let n = 0;

  for (const name of doc.sections) {
    const xml = await readEntry(doc.zip, name);
    const prefix = paragraphPrefix(xml);
    const { slots, tags, byStart } = locateSlots(xml, prefix);
    const edits: Edit[] = [];
    for (const loc of slots) {
      const id = `s${++n}`;
      const value = values.get(id);
      if (value === undefined) {
        unfilled.push(id);
        continue;
      }
      filled.push(id);
      edits.push(...planFill(loc, value, xml, tags, prefix, byStart));
    }
    const out = applyEdits(xml, dedupeDeletes(edits));
    if (out !== xml) edited.set(name, out);
  }

  return { bytes: await writeHwpx(doc, edited), filled, unfilled };
}
