import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { readAttachment } from '@/lib/attachments/reader';
import { locatePassage } from '@/components/chat/source-locate';

/** 원문에서 보기 — 실제 읽개(표준 양식 HWPX)로 읽은 글에서, 줄바꿈·공백을 바꾼 발췌의 자리를 찾는다 */
describe('실제 HWPX 원문에서 근거 자리', () => {
  it('표준 양식 글의 한 대목을 줄바꿈·공백을 바꿔 줘도 같은 자리를 찾는다', async () => {
    const file = readdirSync('assets/templates').find((f) => f.endsWith('.hwpx'))!;
    const extract = await readAttachment(readFileSync(`assets/templates/${file}`), file);
    const text = extract.text;
    const letters = text.replace(/[^\p{L}\p{N}]/gu, '');
    expect(letters.length).toBeGreaterThan(40);
    // 글자·숫자가 몰린 대목 하나를 골라 공백을 줄바꿈으로 바꾼 발췌를 만든다
    const start = text.search(/[\p{L}\p{N}]/u);
    const slice = text.slice(start, start + 80);
    const passage = `[1] ${file} · 1쪽\n${slice.replace(/\s+/g, '\n')}`;
    const at = locatePassage(text, passage);
    if (slice.replace(/[^\p{L}\p{N}]/gu, '').length < 12) return; // 양식 글이 너무 짧으면 찾지 않는 것이 맞다
    expect(at).not.toBeNull();
    expect(text.slice(at!.start, at!.end).replace(/[^\p{L}\p{N}]/gu, '')).toBe(slice.replace(/[^\p{L}\p{N}]/gu, ''));
  });
});
