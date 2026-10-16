import { describe, it, expect } from 'vitest';
import { detectFormat, readTemplate, fillTemplate, MAX_SLOT_TEXT } from '@/lib/doc-fill';
import { extractTextFromHwp } from '@/lib/hwp';
import { buildHwpx, para, emptyPara, tableAt } from './fixtures/hwpx';

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
      mode: 'fill',
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

  it('표시 없는 양식은 자동 자리를 돌려준다', async () => {
    const r = await readTemplate(await buildHwpx(para('1. 개요') + emptyPara()), 'a.hwpx');
    expect(r).toMatchObject({ ok: true, format: 'hwpx', mode: 'fill', slots: [{ id: 's1', label: '1. 개요', kind: 'section' }] });
  });

  it('표시가 하나라도 있으면 자동 찾기를 하지 않는다', async () => {
    const r = await readTemplate(await buildHwpx(para('{{제목}}') + para('1. 개요') + emptyPara()), 'a.hwpx');
    if (!r.ok) throw new Error(r.reason);
    expect(r.slots).toHaveLength(1);
    expect(r.slots[0].kind).toBe('marker');
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

  it('자동 자리를 번호로 채우고 결과는 이름으로', async () => {
    const bytes = await buildHwpx(tableAt([['비고', ''], ['비고', '']]));
    const read = await readTemplate(bytes, 'a.hwpx');
    if (!read.ok) throw new Error(read.reason);
    expect(read.slots.map((s) => [s.id, s.label])).toEqual([['s1', '비고'], ['s2', '비고']]);
    const r = await fillTemplate(bytes, 'a.hwpx', [{ slot_id: 's1', text: '가' }, { slot_id: 's2', text: '나' }]);
    if (!r.ok) throw new Error(r.reason);
    expect(r.mode).toBe('fill');
    expect(r.filled).toEqual(['비고', '비고']);
    expect(r.unfilled).toEqual([]);
    const text = await extractTextFromHwp(r.bytes, 'o.hwpx');
    expect(text).toContain('가');
    expect(text).toContain('나');
  });

  it('자동 자리에도 없는 번호·글자 수 상한을 건다', async () => {
    const bytes = await buildHwpx(para('1. 개요') + emptyPara());
    expect(await fillTemplate(bytes, 'a.hwpx', [{ slot_id: 's7', text: 'x' }])).toEqual({ ok: false, reason: expect.stringContaining('s7') });
    expect(await fillTemplate(bytes, 'a.hwpx', [{ slot_id: 's1', text: '가'.repeat(MAX_SLOT_TEXT + 1) }])).toEqual({
      ok: false,
      reason: expect.stringContaining('1. 개요'),
    });
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

describe('항목이 깨진 파일', () => {
  // 본문의 압축 데이터 앞부분을 망가뜨린다. zip 목록은 멀쩡해 열리지만 항목을 풀 때 실패한다
  async function corruptedSection(): Promise<Buffer> {
    const bytes = Buffer.from(await buildHwpx(para('{{제목}}')));
    const name = Buffer.from('Contents/section0.xml');
    const header = bytes.indexOf(name) - 30;
    expect(header).toBeGreaterThanOrEqual(0);
    const data = header + 30 + bytes.readUInt16LE(header + 26) + bytes.readUInt16LE(header + 28);
    bytes.fill(0xff, data + 2, data + 10);
    return bytes;
  }

  it('읽기와 채우기 모두 던지지 않고 이유를 돌려준다', async () => {
    const bytes = await corruptedSection();
    const read = await readTemplate(bytes, 'c.hwpx');
    expect(read).toEqual({ ok: false, reason: expect.stringContaining('손상') });
    const fill = await fillTemplate(bytes, 'c.hwpx', [{ slot_id: 's1', text: 'x' }]);
    expect(fill).toEqual({ ok: false, reason: expect.stringContaining('손상') });
  });
});
