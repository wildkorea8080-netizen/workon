import { describe, it, expect } from 'vitest';
import { detectFormat, readTemplate, fillTemplate, MAX_SLOT_TEXT } from '@/lib/doc-fill';
import { extractTextFromHwp } from '@/lib/hwp';
import { buildHwpx, para } from './fixtures/hwpx';

const CFB = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);

describe('형식 판별', () => {
  it('확장자와 파일 머리를 함께 본다', async () => {
    const zip = await buildHwpx(para('x'));
    expect(detectFormat('a.hwpx', zip)).toBe('hwpx');
    expect(detectFormat('a.docx', zip)).toBe('docx');
    expect(detectFormat('a.hwp', CFB)).toBe('hwp');
    expect(detectFormat('a.hwpx', CFB)).toBe('unknown');
  });
});

describe('양식 읽기', () => {
  it('표시를 자리 번호와 함께 돌려준다', async () => {
    const r = await readTemplate(await buildHwpx(para('{{제목}}') + para('{{본문}}')), '보고.hwpx');
    expect(r).toEqual({
      ok: true,
      format: 'hwpx',
      slots: [
        { id: 's1', label: '제목', kind: 'marker', path: [], hint: null },
        { id: 's2', label: '본문', kind: 'marker', path: [], hint: null },
      ],
    });
  });

  it('옛 HWP·DOCX·표시 없는 양식은 이유를 돌려준다', async () => {
    expect(await readTemplate(CFB, '옛.hwp')).toEqual({ ok: false, reason: expect.stringContaining('HWPX로') });
    expect(await readTemplate(await buildHwpx(para('x')), 'w.docx')).toEqual({ ok: false, reason: expect.stringContaining('DOCX') });
    expect(await readTemplate(await buildHwpx(para('표시 없음')), 'n.hwpx')).toEqual({ ok: false, reason: expect.stringContaining('{{항목 이름}}') });
  });

  it('깨진 파일도 던지지 않고 이유를 돌려준다', async () => {
    const broken = Buffer.from('PK\u0003\u0004 broken');
    expect((await readTemplate(broken, 'b.hwpx')).ok).toBe(false);
  });
});

describe('양식 채우기', () => {
  it('자리 번호로 받은 글을 채운다', async () => {
    const bytes = await buildHwpx(para('{{제목}}') + para('{{본문}}'));
    const r = await fillTemplate(bytes, '보고.hwpx', [{ slot_id: 's1', text: '제목글' }, { slot_id: 's2', text: '본문글' }]);
    if (!r.ok) throw new Error(r.reason);
    expect(r.extension).toBe('hwpx');
    expect(r.mimeType).toBe('application/hwp+zip');
    const text = await extractTextFromHwp(r.bytes, 'o.hwpx');
    expect(text).toContain('제목글');
    expect(text).toContain('본문글');
  });

  it('없는 자리 번호는 거절한다', async () => {
    const r = await fillTemplate(await buildHwpx(para('{{제목}}')), 'a.hwpx', [{ slot_id: 's9', text: 'x' }]);
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('s9') });
  });

  it('한 자리 글자 수 상한을 넘으면 거절한다', async () => {
    const r = await fillTemplate(await buildHwpx(para('{{제목}}')), 'a.hwpx', [{ slot_id: 's1', text: '가'.repeat(MAX_SLOT_TEXT + 1) }]);
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('제목') });
  });
});
