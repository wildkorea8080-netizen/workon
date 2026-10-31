/**
 * 앱 답(마크다운)을 한글 문서 본문 글로 — 표시 기호만 걷어내고 글자는 바꾸지 않는다.
 * 모델에게 다시 쓰게 하지 않는다(내보내기는 저장된 답 그대로). 아무것도 import하지 않는다.
 *
 * 걷어내는 것: 제목 `#`, 굵게 `**…**`·`__…__`, 인용 `>`, 구분선(`---`·`***`·`___`), 코드 울타리 줄,
 * 줄 안 코드 `` `…` ``, 표 구분 줄. 글머리 `*`·`+`는 `-`로, 링크는 `글(주소)`로, 표 칸은 ` | `로 잇는다.
 * 짝 없는 별표(곱셈·각주)·번호 목록·들여쓰기는 그대로 둔다.
 *
 * 표: 세로줄 줄 바로 다음 줄이 구분 줄(`|---|---:|`)이면 표다(GFM과 같은 규칙). 빈 줄이나 세로줄 없는 줄에서 끝난다.
 * `markdownToDocumentBlocks`는 표를 칸 배열로 따로 돌려준다 — 한글 내보내기가 진짜 표로 넣는다.
 * 구분 줄이 없는 세로줄 글은 표가 아니라 칸을 ` | `로 이은 글이다.
 */
export interface DocumentTable {
  kind: 'table';
  /** 칸 글(표시 기호를 걷어냄). 행마다 칸 수가 다를 수 있다 — 칸을 버리지 않는다 */
  header: string[];
  rows: string[][];
}
export type DocumentBlock = { kind: 'text'; text: string } | DocumentTable;

const SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const isSeparator = (line: string) => SEPARATOR.test(line) && line.includes('-') && line.includes('|');

function inline(line: string): string {
  return line
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1($2)')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/(^|[^\w*])\*\*(?=\S)([^*\n]*?\S)\*\*(?![\w*])/g, '$1$2')
    .replace(/(^|[^\w_])__(?=\S)([^_\n]*?\S)__(?![\w_])/g, '$1$2');
}

/** 표 한 줄을 칸으로 — 바깥 세로줄을 떼고, `\|`는 칸 나눔이 아니라 글자 */
function cellsOf(line: string): string[] {
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);
  return body.split(/(?<!\\)\|/).map((c) => inline(c.trim().replace(/\\\|/g, '|')));
}

export function markdownToDocumentBlocks(markdown: string): DocumentBlock[] {
  const raw = markdown.replace(/\r\n?/g, '\n').split('\n');
  const out: (string | DocumentTable)[] = [];
  for (let i = 0; i < raw.length; i++) {
    let line = raw[i].replace(/\s+$/, '');
    if (/^\s*(`{3,}|~{3,})/.test(line)) continue;
    if (line.includes('|') && !isSeparator(line) && i + 1 < raw.length && isSeparator(raw[i + 1])) {
      const table: DocumentTable = { kind: 'table', header: cellsOf(line), rows: [] };
      i += 1;
      while (i + 1 < raw.length && raw[i + 1].trim() !== '' && raw[i + 1].includes('|')) {
        i += 1;
        if (!isSeparator(raw[i])) table.rows.push(cellsOf(raw[i]));
      }
      out.push(table);
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push(''); continue; }
    if (isSeparator(line)) continue;
    line = line.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/\s+#+\s*$/, '');
    line = line.replace(/^(\s*)(>\s?)+/, '$1');
    line = line.replace(/^(\s*)[*+](\s+)/, '$1-$2');
    if (/^\s*\|.*\|\s*$/.test(line)) line = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim()).join(' | ');
    out.push(inline(line));
  }
  const lines: (string | DocumentTable)[] = [];
  for (const line of out) {
    if (typeof line === 'string' && line.trim() === '') {
      const last = lines[lines.length - 1];
      if (lines.length === 0 || last === '') continue;
      lines.push('');
    } else lines.push(line);
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();

  const blocks: DocumentBlock[] = [];
  let text: string[] | null = null;
  for (const line of lines) {
    if (typeof line === 'string') (text ??= []).push(line);
    else {
      if (text) blocks.push({ kind: 'text', text: text.join('\n') });
      text = null;
      blocks.push(line);
    }
  }
  if (text) blocks.push({ kind: 'text', text: text.join('\n') });
  return blocks;
}

/** 표 칸을 ` | `로 이은 글 */
export function tableAsText(table: DocumentTable): string {
  return [table.header, ...table.rows].map((r) => r.join(' | ')).join('\n');
}

export function markdownToDocumentText(markdown: string): string {
  return markdownToDocumentBlocks(markdown).map((b) => (b.kind === 'text' ? b.text : tableAsText(b))).join('\n');
}
