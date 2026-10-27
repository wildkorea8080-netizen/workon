// src/lib/work/workflows/currentize/segments.ts
import { openHwpx, readEntry, scanParagraphs } from '@/lib/doc-fill/hwpx-core';
import { paragraphPrefix, scanTags } from '@/lib/doc-fill/xml-scan';
import { numberedHeadingLevel, isPlaceholderText } from '@/lib/doc-fill/slots';
import { MAX_SEGMENTS } from './limits';

/**
 * 작년 HWPX를 문단 단위 조각으로 읽는다(S6-1). 읽기만 한다 — 분류도 고치기도 여기서 하지 않는다.
 *
 * 조각 id는 `${섹션 번호}:${문단 시작 위치}`로, **같은 바이트에서 언제나 같다**. 나중에 분류·고치기가
 * 같은 바이트를 다시 훑어 같은 id로 문단을 찾으므로 훑는 규칙(scanParagraphs)을 바꾸지 않는다.
 * 글이 없는(공백뿐인) 문단은 조각이 아니다 — 컨트롤만 든 문단과 빈 줄을 모델에 보내지 않는다.
 */
export interface Segment {
  id: string;
  section: number;
  /** 문단 자신의 글(중첩 문단 제외) */
  text: string;
  /** 위 급 번호 제목 사슬(제목 자신은 제외) */
  path: string[];
  /** 표 칸·글상자 안 문단 */
  nested: boolean;
  /** 가장 가까운 표 칸의 좌표(table = 섹션 안 표 순번). 칸 안이 아니면 null */
  cell: { table: number; row: number; col: number } | null;
}

interface CellRef {
  table: number;
  row: number;
  col: number;
}

// 템플릿 문자열에서 \s·\d는 정규식 이스케이프가 아니라 글자 s·d가 된다 — String.raw로 쓴다
const ATTR = (name: string) => new RegExp(String.raw`\s${name}\s*=\s*(?:"(\d+)"|'(\d+)')`);
const COL_ADDR = ATTR('colAddr');
const ROW_ADDR = ATTR('rowAddr');

/**
 * 문단 시작 위치 → 그 문단을 품은 가장 가까운 표 칸.
 * 한글은 칸 주소(cellAddr)를 칸 내용 **뒤**에 적으므로, 칸 객체를 먼저 잡아 두고 주소가 오면 채운다.
 * 주소가 없으면 표 안 행 순번·행 안 순서(attachments/tables-hwpx.ts와 같은 약속).
 */
function cellOfParagraphs(xml: string, prefix: string): Map<number, CellRef> {
  const TBL = `${prefix}:tbl`;
  const TR = `${prefix}:tr`;
  const TC = `${prefix}:tc`;
  const P = `${prefix}:p`;
  const ADDR = `${prefix}:cellAddr`;

  const tables: { index: number; row: number; col: number }[] = [];
  const cells: CellRef[] = [];
  const out = new Map<number, CellRef>();
  let tableCount = 0;

  for (const tag of scanTags(xml)) {
    const table = tables.length > 0 ? tables[tables.length - 1] : null;
    if (tag.name === TBL) {
      if (tag.kind === 'open') tables.push({ index: tableCount++, row: -1, col: 0 });
      else if (tag.kind === 'close') tables.pop();
    } else if (tag.name === TR && tag.kind === 'open' && table) {
      table.row++;
      table.col = 0;
    } else if (tag.name === TC && table) {
      if (tag.kind === 'open') cells.push({ table: table.index, row: Math.max(table.row, 0), col: table.col++ });
      else if (tag.kind === 'close') cells.pop();
    } else if (tag.name === ADDR && tag.kind !== 'close' && cells.length > 0) {
      const src = xml.slice(tag.start, tag.end);
      const c = src.match(COL_ADDR);
      const r = src.match(ROW_ADDR);
      const cell = cells[cells.length - 1];
      if (c) cell.col = Number(c[1] ?? c[2]);
      if (r) cell.row = Number(r[1] ?? r[2]);
    } else if (tag.name === P && tag.kind === 'open' && cells.length > 0) {
      // 객체를 그대로 담아 두므로 뒤에 오는 칸 주소가 이 문단의 좌표에 반영된다
      out.set(tag.start, cells[cells.length - 1]);
    }
  }
  return out;
}

export async function readSegments(bytes: Buffer): Promise<{ segments: Segment[]; truncated: boolean }> {
  const { zip, sections } = await openHwpx(bytes);
  const segments: Segment[] = [];

  for (let section = 0; section < sections.length; section++) {
    const xml = await readEntry(zip, sections[section]);
    const prefix = paragraphPrefix(xml);
    const cellOf = cellOfParagraphs(xml, prefix);
    /** 열린 번호 제목 사슬(위 급 → 아래 급). hwpx-auto.ts와 같은 규칙: 최상위 문단만, 자리 표시 글은 제목이 아니다 */
    const chain: { level: number; label: string }[] = [];

    for (const p of scanParagraphs(xml, prefix)) {
      const nested = p.ancestors.length > 0;
      const level = !nested && !isPlaceholderText(p.text) ? numberedHeadingLevel(p.text) : null;
      if (level !== null) while (chain.length > 0 && chain[chain.length - 1].level >= level) chain.pop();
      const path = chain.map((h) => h.label);
      if (level !== null) chain.push({ level, label: p.text.trim() });

      if (!p.text.trim()) continue;
      if (segments.length >= MAX_SEGMENTS) return { segments, truncated: true };
      const cell = cellOf.get(p.start);
      segments.push({
        id: `${section}:${p.start}`,
        section,
        text: p.text,
        path,
        nested,
        cell: cell ? { table: cell.table, row: cell.row, col: cell.col } : null,
      });
    }
  }
  return { segments, truncated: false };
}
