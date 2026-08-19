/**
 * HWP 5.0 레코드 트리 덤프 (개발용 진단 도구).
 *
 *   npx tsx scripts/hwp-records.mjs 문서.hwp
 *
 * 표 구조 복원 작업 시 CTRL_HEADER / TABLE / LIST_HEADER 의 실제 바이트
 * 배치를 확인하는 데 씁니다.
 */
import { readFileSync } from 'fs';
import CFB from 'cfb';
import { inflateRaw, inflate } from 'pako';

const TAG = {
  66: 'PARA_HEADER',
  67: 'PARA_TEXT',
  68: 'PARA_CHAR_SHAPE',
  69: 'PARA_LINE_SEG',
  70: 'PARA_RANGE_TAG',
  71: 'CTRL_HEADER',
  72: 'LIST_HEADER',
  73: 'PAGE_DEF',
  74: 'FOOTNOTE_SHAPE',
  75: 'PAGE_BORDER_FILL',
  76: 'SHAPE_COMPONENT',
  77: 'TABLE',
};

const file = process.argv[2];
if (!file) {
  console.error('사용법: npx tsx scripts/hwp-records.mjs <파일.hwp>');
  process.exit(1);
}

const container = CFB.read(readFileSync(file), { type: 'buffer' });
const header = Uint8Array.from(
  container.FileIndex.find((e) => e.name === 'FileHeader').content
);
const compressed = (new DataView(header.buffer).getUint32(36, true) & 1) !== 0;

const section = container.FileIndex.find((e) => /^Section0$/.test(e.name));
let data = Uint8Array.from(section.content);
if (compressed) {
  try {
    data = inflateRaw(data);
  } catch {
    data = inflate(data);
  }
}

const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
const u16 = (b, off) =>
  new DataView(b.buffer, b.byteOffset, b.byteLength).getUint16(off, true);

let pos = 0;
let shown = 0;
while (pos + 4 <= data.length) {
  const h = view.getUint32(pos, true);
  pos += 4;
  const tagId = h & 0x3ff;
  const level = (h >> 10) & 0x3ff;
  let size = (h >> 20) & 0xfff;
  if (size === 0xfff) {
    size = view.getUint32(pos, true);
    pos += 4;
  }
  if (pos + size > data.length) break;

  const body = data.subarray(pos, pos + size);
  const name = TAG[tagId] ?? `TAG_${tagId}`;
  const indent = '  '.repeat(level);

  let extra = '';
  if (tagId === 71) {
    // CTRL_HEADER: 앞 4바이트가 컨트롤 ID (역순 문자)
    const id = String.fromCharCode(body[3], body[2], body[1], body[0]);
    extra = ` id="${id}"`;
  } else if (tagId === 77) {
    // TABLE: 속성(4) 다음 rowCount, colCount
    extra = ` rows=${u16(body, 4)} cols=${u16(body, 6)}`;
  } else if (tagId === 72) {
    // LIST_HEADER: 앞 24바이트를 u16으로 나열해 셀 주소 위치를 찾는다
    const words = [];
    for (let i = 0; i + 2 <= Math.min(body.length, 28); i += 2) words.push(u16(body, i));
    extra = ` u16[${words.join(',')}]`;
  } else if (tagId === 67) {
    const chars = [];
    for (let i = 0; i + 2 <= body.length; i += 2) {
      const c = u16(body, i);
      chars.push(c > 31 ? String.fromCharCode(c) : `<${c}>`);
    }
    const s = chars.join('');
    extra = ` "${s.slice(0, 40)}${s.length > 40 ? '…' : ''}"`;
  }

  console.log(`${indent}L${level} ${name}(${tagId}) size=${size}${extra}`);

  pos += size;
  if (++shown > 400) {
    console.log('... (400개 초과, 생략)');
    break;
  }
}
