import { describe, it, expect } from 'vitest';
import { detectFormat, readTemplate, fillTemplate, MAX_SLOT_TEXT, DOCX_MIME } from '@/lib/doc-fill';
import mammoth from 'mammoth';
import { extractTextFromHwp } from '@/lib/hwp';
import { buildHwpx, para, emptyPara, tableAt } from './fixtures/hwpx';
import { buildDocx, wp } from './fixtures/docx';

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

  it('옛 HWP는 대체 목차', async () => {
    // S2-a의 CFB 시험 바이트는 본문을 못 읽는다. 진짜 HWP 시험 파일이 없으니 이 동작을 고정한다
    const r = await readTemplate(CFB, '옛.hwp');
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('목차') });
  });

  it('알 수 없는 형식은 두 형식을 안내한다', async () => {
    const r = await readTemplate(Buffer.from('plain'), 'x.txt');
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('DOCX') });
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('HWPX') });
  });

  it('자리 없는 HWPX는 대체 — mode fallback·reason·목차 자리', async () => {
    const r = await readTemplate(await buildHwpx(para('1. 사업 개요') + para('본문') + para('2. 추진 일정')), 'n.hwpx');
    expect(r).toEqual({
      ok: true,
      format: 'hwpx',
      mode: 'fallback',
      reason: expect.stringContaining('{{항목 이름}}'),
      slots: [
        { id: 's1', label: '1. 사업 개요', kind: 'section', path: [], hint: null },
        { id: 's2', label: '2. 추진 일정', kind: 'section', path: [], hint: null },
      ],
    });
  });

  it('표시 없는 DOCX도 대체 목차', async () => {
    const r = await readTemplate(await buildDocx(wp('1. 사업 개요') + wp('본문')), 'n.docx');
    expect(r).toMatchObject({
      ok: true,
      format: 'docx',
      mode: 'fallback',
      reason: expect.stringContaining('DOCX'),
      slots: [{ id: 's1', label: '1. 사업 개요', kind: 'section' }],
    });
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

  it('DOCX 표시 양식은 docx로 채운다', async () => {
    const bytes = await buildDocx(wp('{{제목}}') + wp('{{본문}}'));
    const read = await readTemplate(bytes, 'w.docx');
    expect(read).toMatchObject({ ok: true, format: 'docx', mode: 'fill', slots: [{ id: 's1', label: '제목' }, { id: 's2', label: '본문' }] });
    const r = await fillTemplate(bytes, 'w.docx', [{ slot_id: 's1', text: '제목글' }, { slot_id: 's2', text: '본문글' }]);
    if (!r.ok) throw new Error(r.reason);
    expect(r.extension).toBe('docx');
    expect(r.mimeType).toBe(DOCX_MIME);
    expect(r.filled).toEqual(['제목', '본문']);
    const text = (await mammoth.extractRawText({ buffer: r.bytes })).value;
    expect(text).toContain('제목글');
    expect(text).toContain('본문글');
  });

});

describe('대체 채우기', () => {
  const REPORT_LABELS = ['제목', '작성일', '작성부서', '개요', '추진 경과', '주요 내용', '향후 계획', '건의 사항'];
  const reportTemplate = () => buildHwpx(REPORT_LABELS.map((l) => para(`{{${l}}}`)).join(''));
  const source = () => buildHwpx(para('1. 사업 개요') + para('본문') + para('2. 추진 일정'));

  it('대체 채우기는 표준 보고서가 없으면 이유', async () => {
    const values = [{ slot_id: 's1', text: '글' }];
    for (const fallbackTemplate of [null, undefined]) {
      const r = await fillTemplate(await source(), 'n.hwpx', values, { title: '보고', fallbackTemplate });
      expect(r).toEqual({ ok: false, reason: expect.stringContaining('표준 서식(일반 보고서) 파일이 아직 준비되지 않아') });
    }
  });

  it('대체 채우기는 표준 보고서로 hwpx를 만든다', async () => {
    const r = await fillTemplate(await source(), 'n.hwpx', [{ slot_id: 's2', text: '일정은 11월이다.' }], {
      title: '사업 보고',
      fallbackTemplate: await reportTemplate(),
    });
    if (!r.ok) throw new Error(r.reason);
    expect(r.mode).toBe('fallback');
    expect(r.extension).toBe('hwpx');
    expect(r.mimeType).toBe('application/hwp+zip');
    expect(r.filled).toEqual(['2. 추진 일정']);
    expect(r.unfilled).toEqual(['1. 사업 개요']);
    const text = await extractTextFromHwp(r.bytes, 'o.hwpx');
    expect(text).toContain('사업 보고');
    expect(text).toContain('일정은 11월이다.');
    expect(text).not.toContain('{{');
  });

  it('대체에서도 없는 자리 번호는 거절한다', async () => {
    const r = await fillTemplate(await source(), 'n.hwpx', [{ slot_id: 's9', text: 'x' }], {
      title: '보고',
      fallbackTemplate: await reportTemplate(),
    });
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('s9') });
  });

  it('제목이 없으면 첫 목차 이름으로', async () => {
    const r = await fillTemplate(await source(), 'n.hwpx', [{ slot_id: 's1', text: '글' }], {
      fallbackTemplate: await reportTemplate(),
    });
    if (!r.ok) throw new Error(r.reason);
    expect(await extractTextFromHwp(r.bytes, 'o.hwpx')).toContain('1. 사업 개요');
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
