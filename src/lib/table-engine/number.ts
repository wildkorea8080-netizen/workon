/**
 * 칸 하나를 값으로 읽는다. 원칙: 분명한 숫자가 아니면 'unreadable' — 절대 0이 아니다.
 * 읽지 못한 칸을 0으로 치면 합계가 조용히 틀린다(오류도 안 난다). 그래서 의심스러우면 거절한다.
 * header.ts의 isNumericText는 머리글 판정용이라 너그럽다 — 값의 근거는 이 함수 하나다.
 */
import { normalizeUnit } from './unit-names';

export type Parsed =
  | { kind: 'empty' }
  | { kind: 'number'; value: number; unit?: string; percent?: boolean; parenthesized?: true }
  | { kind: 'unreadable'; text: string };

/** 값 없음 표시. 공공기관 표는 0 대신 '-'를 쓴다 */
const EMPTY_MARK = /^[-—–－―‐‑‒−]$/;
/** 천 단위 쉼표는 3자리씩, 쉼표가 없으면 자릿수 자유. 앞자리 0·부호·지수·소수점만 있는 꼴은 거절 */
const BODY = /^(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)$/;
/** 숫자(또는 닫는 괄호)로 끝나는 몸통 + 뒤에 붙은 글. 뒤의 글이 단위 후보 */
const SPLIT_TAIL = /^(.*[\d)])\s*([^\d)]*)$/s;
const NEG_PREFIX = /^[△▲\-−－]\s*/;
const WON_SIGN = /^[₩￦]\s*/;

type Peeled = { rest: string; unit: string | null } | null;

/** 몸통 뒤에 붙은 단위를 뗀다. 단위 후보가 아는 단위가 아니면 null(= 읽지 못함) */
function peelUnit(s: string): Peeled {
  const m = SPLIT_TAIL.exec(s);
  if (!m) return { rest: s, unit: null };
  const tail = m[2].trim();
  if (tail === '') return { rest: m[1], unit: null };
  const unit = normalizeUnit(tail);
  return unit ? { rest: m[1], unit } : null;
}

function unreadable(text: string): Parsed {
  return { kind: 'unreadable', text };
}

export function parseNumber(cell: string | number | null): Parsed {
  if (cell === null || cell === undefined) return { kind: 'empty' };
  if (typeof cell === 'number') {
    return Number.isFinite(cell) && Math.abs(cell) <= Number.MAX_SAFE_INTEGER
      ? { kind: 'number', value: cell }
      : unreadable(String(cell));
  }

  // \s는 전각 공백(U+3000)·NBSP도 포함한다
  let s = cell.trim();
  if (s === '' || EMPTY_MARK.test(s)) return { kind: 'empty' };

  let negative = false;
  let parenthesized = false;
  let unit: string | null = null;

  // 1) 뒤에 붙은 단위: '1,234원', '(1,234)원'
  const tail = peelUnit(s);
  if (!tail) return unreadable(cell);
  s = tail.rest.trim();
  unit = tail.unit;

  // 2) 괄호 음수(회계식): '(1,234)'. 안쪽에 단위가 있는 '(1,234원)'도 받되, 바깥·안쪽 둘 다 있으면 거절
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    parenthesized = true;
    s = s.slice(1, -1).trim();
    const inner = peelUnit(s);
    if (!inner || (inner.unit && unit)) return unreadable(cell);
    s = inner.rest.trim();
    unit = inner.unit ?? unit;
  }

  // 3) 앞의 부호·원화 기호: '△₩1,234', '₩-1,234'. 부호는 한 번만 — '△-5'는 뜻이 둘이라 거절
  const signed = NEG_PREFIX.exec(s);
  if (signed) {
    if (negative) return unreadable(cell);
    negative = true;
    s = s.slice(signed[0].length);
  }
  const won = WON_SIGN.exec(s);
  if (won) {
    if (unit) return unreadable(cell); // '₩1,234원'처럼 단위가 두 번
    unit = '원';
    s = s.slice(won[0].length);
    const signedAfter = NEG_PREFIX.exec(s);
    if (signedAfter) {
      if (negative) return unreadable(cell);
      negative = true;
      s = s.slice(signedAfter[0].length);
    }
  }

  // 4) 숫자 본문. 앞자리 0('007')은 코드·번호라 값으로 치지 않는다 — S3-a가 CSV 코드 칸을 글자로 지킨 이유와 같다
  if (!BODY.test(s) || /^0[\d,]/.test(s)) return unreadable(cell);
  const magnitude = Number(s.replace(/,/g, ''));
  // 2^53을 넘으면 더하기가 조용히 어긋난다
  if (!Number.isFinite(magnitude) || magnitude > Number.MAX_SAFE_INTEGER) return unreadable(cell);

  const value = negative && magnitude !== 0 ? -magnitude : magnitude;
  const out: Extract<Parsed, { kind: 'number' }> = { kind: 'number', value };
  if (unit) out.unit = unit;
  if (unit === '%') out.percent = true;
  // '(1,234)'가 음수 표기인지 부연 괄호인지는 칸만 봐서는 모른다 — 합산 쪽이 경고하도록 표시를 남긴다
  if (parenthesized) out.parenthesized = true;
  return out;
}
