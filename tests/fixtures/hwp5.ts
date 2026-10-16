import * as CFB from 'cfb';
import { deflateRaw } from 'pako';

/**
 * 시험용 HWP 5.0. 저장소에 진짜 HWP 파일이 없어 레코드 바이트를 손으로 쌓는다.
 * 레코드 배치는 hwp.ts의 주석(실측)을 따른다 — 표는 CTRL_HEADER 아래에
 * TABLE · LIST_HEADER(칸) · 칸 문단(PARA_HEADER)이 형제로 나열된다.
 */

const PARA_HEADER = 66;
const PARA_TEXT = 67;
const CTRL_HEADER = 71;
const LIST_HEADER = 72;
const TABLE = 77;

/** [tagId, level, payload] */
export type Rec = [number, number, Uint8Array];

function record([tagId, level, payload]: Rec): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32LE((tagId & 0x3ff) | ((level & 0x3ff) << 10) | (payload.length << 20), 0);
  return Buffer.concat([head, Buffer.from(payload)]);
}

/** 문단 글. 끝에 문단 구분(13). withTable이면 앞에 표 컨트롤 글자(11, 8 wchar) */
function paraText(text: string, withTable = false): Uint8Array {
  const codes: number[] = [];
  if (withTable) codes.push(11, 0, 0, 0, 0, 0, 0, 0);
  for (const ch of text) codes.push(ch.charCodeAt(0));
  codes.push(13);
  const buf = Buffer.alloc(codes.length * 2);
  codes.forEach((c, i) => buf.writeUInt16LE(c, i * 2));
  return buf;
}

/** 본문 문단 하나 */
export function para(text: string, level = 0): Rec[] {
  return [
    [PARA_HEADER, level, new Uint8Array(22)],
    [PARA_TEXT, level + 1, paraText(text)],
  ];
}

export interface HwpCell {
  row: number;
  col: number;
  colSpan?: number;
  rowSpan?: number;
  /** 칸 안 문단들. 문단 대신 표를 넣으려면 { table } */
  paras: (string | { table: HwpTable })[];
}

export interface HwpTable {
  /** TABLE 레코드가 선언한 크기 */
  rows: number;
  cols: number;
  cells: HwpCell[];
  /** TABLE 레코드를 빼고 만든다(깨진 표) */
  noInfo?: boolean;
}

/** 표를 품은 문단. level은 그 문단의 깊이 */
export function tablePara(t: HwpTable, level = 0, text = ''): Rec[] {
  const recs: Rec[] = [
    [PARA_HEADER, level, new Uint8Array(22)],
    [PARA_TEXT, level + 1, paraText(text, true)],
  ];
  const ctrl = Buffer.from('tbl ').reverse();
  recs.push([CTRL_HEADER, level + 1, Buffer.concat([ctrl, Buffer.alloc(40)])]);
  const info = Buffer.alloc(18);
  info.writeUInt16LE(t.rows, 4);
  info.writeUInt16LE(t.cols, 6);
  if (!t.noInfo) recs.push([TABLE, level + 2, info]);
  for (const c of t.cells) {
    const lh = Buffer.alloc(34);
    lh.writeInt32LE(c.paras.length, 0);
    lh.writeUInt16LE(c.col, 8);
    lh.writeUInt16LE(c.row, 10);
    lh.writeUInt16LE(c.colSpan ?? 1, 12);
    lh.writeUInt16LE(c.rowSpan ?? 1, 14);
    recs.push([LIST_HEADER, level + 2, lh]);
    for (const p of c.paras) {
      if (typeof p === 'string') recs.push(...para(p, level + 2));
      else recs.push(...tablePara(p.table, level + 2));
    }
  }
  return recs;
}

/** 무압축 HWP 5.0 컨테이너. 구역마다 레코드 배열 하나 */
export function buildHwp(...sections: Rec[][]): Buffer {
  return buildHwpWith({}, sections);
}

/**
 * compressed면 한글처럼 구역을 zlib 헤더 없는 raw deflate로 담는다.
 * 구역 자리에 바이트를 주면 그대로 담는다(깨진 구역 시험용)
 */
export function buildHwpWith(opts: { compressed?: boolean }, sections: (Rec[] | Uint8Array)[]): Buffer {
  const cfb = CFB.utils.cfb_new();
  // FileHeader 36번째 바이트부터 4바이트가 속성 플래그. 0x01 = 압축
  const header = Buffer.alloc(256);
  header.write('HWP Document File', 0, 'ascii');
  if (opts.compressed) header.writeUInt32LE(1, 36);
  CFB.utils.cfb_add(cfb, '/FileHeader', header);
  sections.forEach((sec, i) => {
    let bytes: Uint8Array;
    if (sec instanceof Uint8Array) bytes = sec;
    else {
      const raw = Buffer.concat(sec.map(record));
      bytes = opts.compressed ? deflateRaw(raw) : raw;
    }
    CFB.utils.cfb_add(cfb, `/BodyText/Section${i}`, Buffer.from(bytes));
  });
  return CFB.write(cfb, { type: 'buffer' }) as Buffer;
}
