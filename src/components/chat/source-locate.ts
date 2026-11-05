// 원문 보기의 근거 위치 찾기(2026-11-06) — 순수 함수. 화면이 읽으므로 아무것도 import하지 않는다.
// NODA 근거 발췌와 우리가 원본에서 다시 읽은 글은 줄바꿈·표 꼴(마크다운 `|`)·공백이 다르다.
// 그래서 글자·숫자만 남긴 꼴로 맞대고, 찾은 자리를 원래 글의 위치로 되돌린다.

const KEEP = /[\p{L}\p{N}]/u;

/** 글자·숫자만 남긴 꼴과, 그 글자마다 원래 글의 위치 */
function squeeze(text: string): { s: string; at: number[] } {
  let s = '';
  const at: number[] = [];
  const chars = Array.from(text);
  let offset = 0;
  for (const ch of chars) {
    if (KEEP.test(ch)) {
      s += ch.toLowerCase();
      at.push(offset);
    }
    offset += ch.length;
  }
  return { s, at };
}

/** 근거 발췌에서 찾기에 쓸 몸통 — 머리 줄(`[n] 파일 · 쪽`)과 앞뒤 `…`를 뗀다 */
function passageBody(passage: string): string {
  return passage.replace(/^\[\d{1,3}\][^\n]*\n/, '').replace(/^…|…$/g, '').trim();
}

/**
 * 원문 글에서 근거 발췌의 자리 — `{ start, end }`(원문 글의 문자 위치, end 미포함) 또는 못 찾으면 null.
 * 발췌의 앞 40자 → 가운데 → 뒤에서 차례로 조각(30자)을 찾아, 찾은 조각을 기준으로 발췌 길이만큼 넓힌다.
 * 조각이 너무 짧으면(12자 미만) 엉뚱한 자리에 맞을 수 있어 찾지 않는다
 */
export function locatePassage(document: string, passage: string): { start: number; end: number } | null {
  const doc = squeeze(document);
  const body = squeeze(passageBody(passage));
  if (body.s.length < 12 || doc.s.length === 0) return null;
  const size = Math.min(30, body.s.length);
  const offsets = [...new Set([0, Math.floor((body.s.length - size) / 2), body.s.length - size])].filter((o) => o >= 0);
  for (const offset of offsets) {
    const piece = body.s.slice(offset, offset + size);
    const hit = doc.s.indexOf(piece);
    if (hit < 0) continue;
    // 같은 조각이 둘 이상이면 어느 쪽인지 모른다 — 다음 조각으로
    if (doc.s.indexOf(piece, hit + 1) >= 0) continue;
    const from = Math.max(0, hit - offset);
    const to = Math.min(doc.s.length, from + body.s.length);
    const start = doc.at[from];
    const lastChar = doc.at[to - 1];
    const end = lastChar + (document.codePointAt(lastChar)! > 0xffff ? 2 : 1);
    return { start, end };
  }
  return null;
}
