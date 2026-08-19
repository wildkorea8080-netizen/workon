/**
 * HWP/HWPX 텍스트 추출 검증 스크립트.
 *
 *   node scripts/hwp-probe.mjs                 # 합성 파일로 자체 검증
 *   node scripts/hwp-probe.mjs 내문서.hwp       # 실제 파일로 검증
 *
 * 합성 검증은 레코드 비트필드 해석과 UTF-16 디코딩을 확인합니다.
 * 실제 공문서 검증은 반드시 진짜 .hwp 파일로 해야 합니다.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { deflateRaw } from 'pako';
import CFB from 'cfb';
import JSZip from 'jszip';

const HWPTAG_PARA_TEXT = 0x10 + 51;

/**
 * PARA_TEXT 레코드 하나를 만든다 (헤더 4바이트 + UTF-16LE 본문).
 *
 * 문자열 안의 \t(9)와 (확장 컨트롤)는 실제 HWP처럼 8 wchar를 차지하도록
 * 뒤에 7 wchar 더미를 붙여 인코딩한다. 파서가 이걸 건너뛰지 못하면 더미가
 * 본문에 쓰레기 문자로 튀어나오므로 회귀를 잡을 수 있다.
 */
const WIDE_CONTROLS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);

function encodeParaBody(text) {
  const words = [];
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    words.push(code);
    if (WIDE_CONTROLS.has(code)) {
      // 더미 7 wchar — 건너뛰기에 실패하면 'ZZZZZZZ'가 본문에 섞여 나온다
      for (let k = 0; k < 7; k++) words.push(0x005a);
    }
  }
  const body = Buffer.alloc(words.length * 2);
  words.forEach((w, idx) => body.writeUInt16LE(w, idx * 2));
  return body;
}

function makeParaTextRecord(text) {
  const body = encodeParaBody(text);

  const size = body.length;
  if (size >= 0xfff) throw new Error('probe는 짧은 문단만 지원');

  // [0..9] tagID | [10..19] level | [20..31] size
  const header = (HWPTAG_PARA_TEXT & 0x3ff) | (0 << 10) | ((size & 0xfff) << 20);
  const head = Buffer.alloc(4);
  head.writeUInt32LE(header >>> 0, 0);
  return Buffer.concat([head, body]);
}

/** 임의 레코드 하나 (헤더 4바이트 + 본문) */
function makeRecord(tagId, level, body) {
  const size = body.length;
  if (size >= 0xfff) throw new Error('probe는 짧은 레코드만 지원');
  const header = (tagId & 0x3ff) | ((level & 0x3ff) << 10) | ((size & 0xfff) << 20);
  const head = Buffer.alloc(4);
  head.writeUInt32LE(header >>> 0, 0);
  return Buffer.concat([head, body]);
}

const TAG_PARA_HEADER = 66;
const TAG_PARA_TEXT = 67;
const TAG_CTRL_HEADER = 71;
const TAG_LIST_HEADER = 72;
const TAG_TABLE = 77;

/**
 * 표 컨트롤 레코드를 만든다. 실제 파일과 같은 형제 배치를 재현한다:
 *   L1 CTRL_HEADER("tbl ")
 *     L2 TABLE / LIST_HEADER / PARA_HEADER  (모두 형제)
 *       L3 PARA_TEXT
 */
function makeTableRecords(rows) {
  const rowCount = rows.length;
  const colCount = rows[0].length;

  const ctrlBody = Buffer.alloc(46);
  // 컨트롤 ID "tbl " 는 역순 저장
  ctrlBody[0] = ' '.charCodeAt(0);
  ctrlBody[1] = 'l'.charCodeAt(0);
  ctrlBody[2] = 'b'.charCodeAt(0);
  ctrlBody[3] = 't'.charCodeAt(0);

  const tableBody = Buffer.alloc(40);
  tableBody.writeUInt16LE(rowCount, 4);
  tableBody.writeUInt16LE(colCount, 6);

  const parts = [
    makeRecord(TAG_CTRL_HEADER, 1, ctrlBody),
    makeRecord(TAG_TABLE, 2, tableBody),
  ];

  rows.forEach((cols, r) => {
    cols.forEach((text, c) => {
      const cell = Buffer.alloc(47);
      cell.writeInt32LE(1, 0); // 문단 수
      cell.writeUInt16LE(c, 8); // 열 주소
      cell.writeUInt16LE(r, 10); // 행 주소
      cell.writeUInt16LE(1, 12); // 열 병합
      cell.writeUInt16LE(1, 14); // 행 병합
      parts.push(makeRecord(TAG_LIST_HEADER, 2, cell));
      parts.push(makeRecord(TAG_PARA_HEADER, 2, Buffer.alloc(24)));
      parts.push(makeRecord(TAG_PARA_TEXT, 3, encodeParaBody(text)));
    });
  });

  return Buffer.concat(parts);
}

function buildSyntheticHwp(paragraphs, tableRows) {
  const records = Buffer.concat([
    ...paragraphs.map(makeParaTextRecord),
    ...(tableRows ? [makeRecord(TAG_PARA_HEADER, 0, Buffer.alloc(24)), makeTableRecords(tableRows)] : []),
  ]);
  const compressed = Buffer.from(deflateRaw(records));

  // FileHeader: 32바이트 시그니처 + 4바이트 버전 + 4바이트 속성(압축 비트)
  const fileHeader = Buffer.alloc(256);
  fileHeader.write('HWP Document File', 0, 'latin1');
  fileHeader.writeUInt32LE(0x01, 36); // FLAG_COMPRESSED

  const cfb = CFB.utils.cfb_new();
  CFB.utils.cfb_add(cfb, '/FileHeader', fileHeader);
  CFB.utils.cfb_add(cfb, '/BodyText/Section0', compressed);
  return Buffer.from(CFB.write(cfb, { type: 'buffer' }));
}

async function buildSyntheticHwpx(paragraphs) {
  const zip = new JSZip();
  const body = paragraphs
    .map((p) => `<hp:p><hp:run><hp:t>${p}</hp:t></hp:run></hp:p>`)
    .join('');
  zip.file('Contents/section0.xml', `<?xml version="1.0" encoding="UTF-8"?><hs:sec xmlns:hp="x" xmlns:hs="y">${body}</hs:sec>`);
  zip.file('mimetype', 'application/hwp+zip');
  return zip.generateAsync({ type: 'nodebuffer' });
}

// 	 = 인라인 컨트롤(9),  = 확장 컨트롤(표/그림 등)
const SAMPLE = [
  '공공기관 문서 관리 지침',
  '제1조(목적)	이 지침은 문서의 관리에 관하여 필요한 사항을 정함을 목적으로 한다.',
  '붙임 1. 서식	2026. 8. 18.',
];

// 파서가 통과시켜야 하는 기대 문자열 (컨트롤 더미가 섞이면 안 됨)
const EXPECT = ['공공기관 문서 관리 지침', '제1조(목적)', '이 지침은 문서의 관리에', '붙임 1. 서식', '2026. 8. 18.'];

// 표 복원 검증용 (헤더 행 + 데이터 2행)
const TABLE_ROWS = [
  ['업체명', '참여자격', '비고'],
  ['롯데상사', '적격', ''],
  ['비오씨', '부적격', '일반대두 미신청'],
];
const EXPECT_TABLE = [
  '| 업체명 | 참여자격 | 비고 |',
  '| 롯데상사 | 적격 |  |',
  '| 비오씨 | 부적격 | 일반대두 미신청 |',
];

async function main() {
  const { extractTextFromHwp } = await import('../src/lib/hwp.ts');
  const target = process.argv[2];

  if (target) {
    const buf = readFileSync(target);
    console.log(`파일: ${target} (${(buf.length / 1024).toFixed(1)} KB)`);
    const text = await extractTextFromHwp(buf, target);
    console.log(`추출 길이: ${text.length}자\n`);
    console.log('--- 앞 800자 ---');
    console.log(text.slice(0, 800));
    return;
  }

  const dir = join(tmpdir(), 'workon-hwp-probe');
  mkdirSync(dir, { recursive: true });

  const hwpxPath = join(dir, 'sample.hwpx');
  writeFileSync(hwpxPath, await buildSyntheticHwpx(SAMPLE));
  const hwpxText = await extractTextFromHwp(readFileSync(hwpxPath), 'sample.hwpx');
  const hwpxOk = EXPECT.every((s) => hwpxText.includes(s));
  console.log(`[HWPX] ${hwpxOk ? 'PASS' : 'FAIL'}`);
  console.log(JSON.stringify(hwpxText));

  const hwpPath = join(dir, 'sample.hwp');
  writeFileSync(hwpPath, buildSyntheticHwp(SAMPLE, TABLE_ROWS));
  const hwpText = await extractTextFromHwp(readFileSync(hwpPath), 'sample.hwp');

  const hwpOk = EXPECT.every((s) => hwpText.includes(s)) && !hwpText.includes('ZZZ');
  console.log(`\n[HWP 5.0 본문] ${hwpOk ? 'PASS' : 'FAIL'}`);

  const missingRows = EXPECT_TABLE.filter((row) => !hwpText.includes(row));
  const tableOk = missingRows.length === 0;
  console.log(`[HWP 5.0 표복원] ${tableOk ? 'PASS' : 'FAIL'}`);
  if (!tableOk) console.log('  누락된 행:', missingRows);
  console.log(hwpText);

  if (!hwpxOk || !hwpOk || !tableOk) process.exit(1);
}

main().catch((e) => {
  console.error('실패:', e.message);
  process.exit(1);
});
