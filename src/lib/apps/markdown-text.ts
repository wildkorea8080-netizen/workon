/**
 * 앱 답(마크다운)을 한글 문서 본문 글로 — 표시 기호만 걷어내고 글자는 바꾸지 않는다.
 * 모델에게 다시 쓰게 하지 않는다(내보내기는 저장된 답 그대로). 아무것도 import하지 않는다.
 *
 * 걷어내는 것: 제목 `#`, 굵게 `**…**`·`__…__`, 인용 `>`, 구분선(`---`·`***`·`___`), 코드 울타리 줄,
 * 줄 안 코드 `` `…` ``, 표 구분 줄. 글머리 `*`·`+`는 `-`로, 링크는 `글(주소)`로, 표 칸은 ` | `로 잇는다.
 * 짝 없는 별표(곱셈·각주)·번호 목록·들여쓰기는 그대로 둔다.
 */
export function markdownToDocumentText(markdown: string): string {
  const out: string[] = [];
  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    let line = raw.replace(/\s+$/, '');
    if (/^\s*(`{3,}|~{3,})/.test(line)) continue;
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push(''); continue; }
    if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes('-') && line.includes('|')) continue;
    line = line.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/\s+#+\s*$/, '');
    line = line.replace(/^(\s*)(>\s?)+/, '$1');
    line = line.replace(/^(\s*)[*+](\s+)/, '$1-$2');
    if (/^\s*\|.*\|\s*$/.test(line)) line = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim()).join(' | ');
    line = line
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1($2)')
      .replace(/`([^`\n]+)`/g, '$1')
      .replace(/(^|[^\w*])\*\*(?=\S)([^*\n]*?\S)\*\*(?![\w*])/g, '$1$2')
      .replace(/(^|[^\w_])__(?=\S)([^_\n]*?\S)__(?![\w_])/g, '$1$2');
    out.push(line);
  }
  const lines: string[] = [];
  for (const line of out) { if (line.trim() === '' && (lines.length === 0 || lines[lines.length - 1] === '')) continue; lines.push(line.trim() === '' ? '' : line); }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}
