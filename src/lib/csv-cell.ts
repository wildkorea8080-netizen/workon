// src/lib/csv-cell.ts
// CSV 한 칸 — 감싸기와 수식 주입 막기를 한 곳에서(2026-11-18). 아무것도 import하지 않는다(화면·서버가 함께 쓴다).
//
// CSV는 엑셀에서 열린다. `=`·`+`·`-`·`@`·탭·CR로 시작하는 칸은 엑셀이 **수식으로 실행**한다(`=HYPERLINK(…)`·`=cmd|…`) —
// 큰따옴표로 감싸도 막히지 않는다. 직원 이름·비서 이름·질문·파일 이름처럼 **사용자가 정한 글**이 감사 기록·이용통계·등록 결과 CSV에 실려
// 관리자가 연 엑셀에서 실행될 수 있었다(OWASP 'CSV Injection'). 예전에는 다섯 곳이 각자 감쌌고 그중 넷이 이 막기를 빠뜨렸다
// (하나는 쉼표조차 감싸지 않아 쉼표가 든 이름이 칸을 밀었다).

/** 그대로 둬도 되는 숫자 꼴 — 음수 `-5`·`-1,234.5`는 수식이 아니다 */
const PLAIN_NUMBER = /^-?\d[\d,]*(\.\d+)?$/;
const FORMULA_START = /^[=+\-@\t\r]/;

/** 칸 하나 — 수식으로 읽힐 글 앞에 `'`, 쉼표·큰따옴표·줄바꿈이 있으면 큰따옴표로 감싼다 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  const text = String(value);
  // 홑 '-'(값 없음 표시)·평범한 숫자 글은 그대로 — 엑셀 엑스포트(`xlsx-export.ts`)와 같은 예외
  const safe = FORMULA_START.test(text) && text !== '-' && !PLAIN_NUMBER.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** 한 줄 */
export function csvLine(values: unknown[]): string {
  return values.map(csvCell).join(',');
}

/** 엑셀에서 한글이 깨지지 않게 앞에 붙이는 표시(BOM) */
export const CSV_BOM = '﻿';
