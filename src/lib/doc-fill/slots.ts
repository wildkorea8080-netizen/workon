/**
 * 채울 자리 규칙. S2-a는 기관이 넣은 표시({{이름}})만 읽는다.
 * 번호 제목·표 빈칸·자리 표시 글자 찾기는 S2-b에서 여기에 더한다(설계 4.1).
 */
export interface MarkerMatch {
  label: string;
  start: number;
  end: number;
}

const MARKER = /\{\{\s*([^{}\n]{1,60}?)\s*\}\}/g;

export function findMarkers(text: string): MarkerMatch[] {
  const out: MarkerMatch[] = [];
  MARKER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKER.exec(text))) {
    const label = m[1].trim();
    if (label) out.push({ label, start: m.index, end: m.index + m[0].length });
  }
  return out;
}
