import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { readHwpxMarkers, fillHwpx } from '@/lib/doc-fill/hwpx';
import { findMarkers } from '@/lib/doc-fill/slots';
import { unescapeXml } from '@/lib/doc-fill/xml-scan';
import { DocFillError } from '@/lib/doc-fill/errors';
import { extractTextFromHwp } from '@/lib/hwp';
import { buildHwpx, para, table, sectionXml, HEADER } from './fixtures/hwpx';

const values = (o: Record<string, string>) => new Map(Object.entries(o));

describe('표시 찾기', () => {
  it('이름을 다듬고 빈 표시·짝 없는 괄호는 무시한다', () => {
    expect(findMarkers('제목: {{ 제목 }} / {{}} / {{ }} / {{열림').map((m) => m.label)).toEqual(['제목']);
  });

  it('문서 순서대로, 중복 없이, 표 칸과 조각난 표시까지 읽는다', async () => {
    const bytes = await buildHwpx(
      para('{{제목}}') + table([['일시', '{{일시}}'], ['작성', '{{제목}}']]) + para(['{{작', '성자}}'])
    );
    expect(await readHwpxMarkers(bytes)).toEqual(['제목', '일시', '작성자']);
  });

  it('zip이 아니면 이유를 알려 준다', async () => {
    await expect(readHwpxMarkers(Buffer.from('not a zip'))).rejects.toBeInstanceOf(DocFillError);
  });

  it('본문이 없으면 이유를 알려 준다', async () => {
    const zip = new JSZip();
    zip.file('mimetype', 'application/hwp+zip');
    const bytes = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(readHwpxMarkers(bytes)).rejects.toThrow('본문');
  });
});

describe('채우기', () => {
  it('표시를 지우고 글을 넣는다 — 다시 읽으면 글이 있고 표시가 없다', async () => {
    const bytes = await buildHwpx(para('{{제목}}') + table([['장소', '{{장소}}']]));
    const result = await fillHwpx(bytes, values({ 제목: '2026년 업무보고', 장소: '본관 3층' }));
    const text = await extractTextFromHwp(result.bytes, 'out.hwpx');
    expect(text).toContain('2026년 업무보고');
    expect(text).toContain('본관 3층');
    expect(text).not.toContain('{{');
    expect(result.filled).toEqual(['제목', '장소']);
    expect(result.unfilled).toEqual([]);
  });

  it('줄바꿈마다 문단을 복제한다 — 서식 참조가 같고 줄 배치 캐시는 지운다', async () => {
    const bytes = await buildHwpx(para('{{본문}}', '5') + para('그대로', '8'));
    const xml = await sectionXml((await fillHwpx(bytes, values({ 본문: '첫째\n둘째\r\n셋째' }))).bytes);
    const filled = xml.match(/<hp:p [^>]*paraPrIDRef="5"[\s\S]*?<\/hp:p>/g) ?? [];
    expect(filled).toHaveLength(3);
    expect(filled.map((p) => p.match(/<hp:t>([^<]*)<\/hp:t>/)![1])).toEqual(['첫째', '둘째', '셋째']);
    expect(filled.join('')).not.toContain('linesegarray');
    // 손대지 않은 문단의 줄 배치 캐시는 남는다
    expect(xml.match(/<hp:p [^>]*paraPrIDRef="8"[\s\S]*?<\/hp:p>/)![0]).toContain('linesegarray');
  });

  it('조각난 표시도 채운다', async () => {
    const bytes = await buildHwpx(para(['{{작', '성', '자}}']));
    const result = await fillHwpx(bytes, values({ 작성자: '홍길동' }));
    expect(await extractTextFromHwp(result.bytes, 'o.hwpx')).toContain('홍길동');
    expect(await sectionXml(result.bytes)).not.toContain('작');
  });

  it('같은 이름 두 번이면 둘 다 채운다', async () => {
    const bytes = await buildHwpx(para('{{제목}}') + table([['제목', '{{제목}}']]));
    const xml = await sectionXml((await fillHwpx(bytes, values({ 제목: '여비 규정 개정' }))).bytes);
    expect(xml.match(/여비 규정 개정/g)).toHaveLength(2);
  });

  it('특수문자를 이스케이프한다 — 파일이 깨지지 않고 원래 글로 읽힌다', async () => {
    const bytes = await buildHwpx(para('{{비고}}'));
    const result = await fillHwpx(bytes, values({ 비고: 'A & B <C> "인용"' }));
    expect(await sectionXml(result.bytes)).toContain('A &amp; B &lt;C&gt; "인용"');
    expect(await extractTextFromHwp(result.bytes, 'o.hwpx')).toContain('A & B <C> "인용"');
  });

  it('문장 속 표시는 그 자리에 넣고, 나머지 줄은 다음 문단으로', async () => {
    const bytes = await buildHwpx(para('제목: {{제목}} (안)'));
    const xml = await sectionXml((await fillHwpx(bytes, values({ 제목: '첫 줄\n둘째 줄' }))).bytes);
    const texts = [...xml.matchAll(/<hp:t>([^<]*)<\/hp:t>/g)].map((m) => m[1]);
    expect(texts).toEqual(['제목: 첫 줄 (안)', '둘째 줄']);
  });

  it('값이 없는 표시는 남기고 알려 준다', async () => {
    const bytes = await buildHwpx(para('{{제목}}') + para('{{참석자}}'));
    const result = await fillHwpx(bytes, values({ 제목: '회의' }));
    expect(result.unfilled).toEqual(['참석자']);
    expect(await sectionXml(result.bytes)).toContain('{{참석자}}');
  });

  it('서식 정의는 그대로, mimetype은 맨 앞 무압축, 미리보기 글은 채운 본문', async () => {
    const bytes = await buildHwpx(para('{{제목}}'));
    const result = await fillHwpx(bytes, values({ 제목: '새 제목' }));
    const zip = await JSZip.loadAsync(result.bytes);
    expect(await zip.file('Contents/header.xml')!.async('string')).toBe(HEADER);
    // zip 첫 항목의 로컬 헤더: 시그니처 · 압축 방식(0=저장) · 이름
    expect(result.bytes.readUInt32LE(0)).toBe(0x04034b50);
    expect(result.bytes.readUInt16LE(8)).toBe(0);
    const nameLength = result.bytes.readUInt16LE(26);
    expect(result.bytes.subarray(30, 30 + nameLength).toString('utf8')).toBe('mimetype');
    const preview = await zip.file('Preview/PrvText.txt')!.async('string');
    expect(preview).toContain('새 제목');
    expect(preview).not.toContain('{{');
  });

  it('표를 품은 바깥 문단의 표시도 그 자리에 채운다 — 표는 하나로 남고 여분 줄은 표 뒤 문단으로', async () => {
    const outer = table([['칸', '{{칸값}}']]).replace('<hp:run charPrIDRef="0"><hp:tbl', '<hp:run charPrIDRef="0"><hp:t>{{바깥}}</hp:t><hp:tbl');
    const bytes = await buildHwpx(outer);
    const result = await fillHwpx(bytes, values({ 바깥: 'X\nY', 칸값: '채움' }));
    const xml = await sectionXml(result.bytes);
    expect(xml.match(/<hp:tbl /g)).toHaveLength(1);
    expect(xml).toContain('채움');
    expect(xml).not.toContain('{{');
    expect(result.filled).toEqual(['바깥', '칸값']);
    // 바깥 문단의 글은 표 앞 그 자리, 여분 줄은 바깥 문단이 닫힌 바로 뒤
    expect(xml).toMatch(/<hp:t>X<\/hp:t><hp:tbl [\s\S]*<\/hp:tbl><\/hp:run><\/hp:p><hp:p [^>]*><hp:run[^>]*><hp:t>Y<\/hp:t><\/hp:run><\/hp:p>/);
  });
});

/** 한글은 머리말·각주·글상자를 그것을 품은 본문 문단 안에 넣는다 */
const host = (inner: string, hostText: string) =>
  `<hp:p id="1" paraPrIDRef="3" styleIDRef="0"><hp:run charPrIDRef="0">${inner}<hp:t>${hostText}</hp:t></hp:run></hp:p>`;

describe('중첩 문단', () => {
  it('머리말 칸의 표시와 그것을 품은 본문 문단의 표시를 모두 채운다 — 문서 순서로 읽는다', async () => {
    const header = `<hp:ctrl><hp:header id="1"><hp:subList>${para('{{쪽}} {{제목}}', '7')}</hp:subList></hp:header></hp:ctrl>`;
    const bytes = await buildHwpx(host(header, '{{제목}}'));
    expect(await readHwpxMarkers(bytes)).toEqual(['쪽', '제목']);
    const result = await fillHwpx(bytes, values({ 제목: '가나다', 쪽: '1' }));
    const xml = await sectionXml(result.bytes);
    expect(xml.match(/가나다/g)).toHaveLength(2);
    expect(xml).not.toContain('{{');
    expect(result.filled).toEqual(['쪽', '제목']);
    expect(result.unfilled).toEqual([]);
  });

  it('각주를 품은 본문 문단의 표시도 목록에 오르고 채워진다', async () => {
    const note = `<hp:ctrl><hp:footNote><hp:subList>${para('출처 {{출처}}', '7')}</hp:subList></hp:footNote></hp:ctrl>`;
    const bytes = await buildHwpx(`<hp:p id="1" paraPrIDRef="3" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>{{본문}}</hp:t>${note}</hp:run></hp:p>`);
    expect(await readHwpxMarkers(bytes)).toEqual(['본문', '출처']);
    const result = await fillHwpx(bytes, values({ 본문: '내용', 출처: '법제처' }));
    const text = await extractTextFromHwp(result.bytes, 'o.hwpx');
    expect(text).toContain('내용');
    expect(text).toContain('출처 법제처');
    expect(text).not.toContain('{{');
  });

  it('중첩 문단의 여분 줄은 그 문단이 있는 칸 안에 들어간다', async () => {
    const header = `<hp:ctrl><hp:header id="1"><hp:subList>${para('{{제목}}', '7')}</hp:subList></hp:header></hp:ctrl>`;
    const xml = await sectionXml((await fillHwpx(await buildHwpx(host(header, '본문')), values({ 제목: '가\n나' }))).bytes);
    expect(xml).toMatch(/<hp:subList>[\s\S]*<hp:t>가<\/hp:t>[\s\S]*<hp:t>나<\/hp:t>[\s\S]*<\/hp:subList>/);
  });
});

describe('여분 줄 문단', () => {
  const sectionFirst =
    '<hp:p id="1" paraPrIDRef="3" styleIDRef="0"><hp:run charPrIDRef="0"><hp:secPr id=""><hp:grid/></hp:secPr><hp:ctrl><hp:colPr id="" type="NEWSPAPER"/></hp:ctrl></hp:run><hp:run charPrIDRef="0"><hp:t>{{제목}}</hp:t></hp:run></hp:p>';

  it('구역 첫 문단의 구역 설정·단 설정을 복제하지 않는다', async () => {
    const xml = await sectionXml((await fillHwpx(await buildHwpx(sectionFirst), values({ 제목: 'A\nB\nC' }))).bytes);
    expect(xml.match(/<hp:secPr[ >]/g)).toHaveLength(1);
    expect(xml.match(/<hp:colPr[ />]/g)).toHaveLength(1);
    const paras = xml.match(/<hp:p [\s\S]*?<\/hp:p>/g)!;
    expect(paras.map((p) => [...p.matchAll(/<hp:t>([^<]*)<\/hp:t>/g)].map((m) => m[1]).join(''))).toEqual(['A', 'B', 'C']);
  });

  it('여분 줄은 표시가 있던 조각의 글자 서식을 쓰고 탭 같은 것은 가져오지 않는다', async () => {
    const body =
      '<hp:p id="1" paraPrIDRef="3" styleIDRef="0"><hp:run charPrIDRef="9"><hp:t>라벨:<hp:tab/></hp:t></hp:run><hp:run charPrIDRef="2"><hp:t>{{값}}</hp:t></hp:run></hp:p>';
    const xml = await sectionXml((await fillHwpx(await buildHwpx(body), values({ 값: 'x\ny' }))).bytes);
    const paras = xml.match(/<hp:p [\s\S]*?<\/hp:p>/g)!;
    expect(paras).toHaveLength(2);
    expect(paras[0]).toContain('charPrIDRef="9"');
    expect(paras[0]).toContain('<hp:tab/>');
    expect(paras[1]).toContain('charPrIDRef="2"');
    expect(paras[1]).not.toContain('charPrIDRef="9"');
    expect(paras[1]).not.toContain('<hp:tab/>');
    expect(paras[1]).toContain('paraPrIDRef="3"');
    expect(paras[1].match(/<hp:t>([^<]*)<\/hp:t>/)![1]).toBe('y');
  });
});

describe('여분 줄이 만드는 배치 변화', () => {
  it('이어 붙인 문단은 쪽 나눔·단 나눔을 끈다 — 원래 문단은 그대로', async () => {
    const body =
      '<hp:p id="1" paraPrIDRef="3" styleIDRef="0" pageBreak="1" columnBreak="1"><hp:run charPrIDRef="0"><hp:t>{{본문}}</hp:t></hp:run></hp:p>';
    const xml = await sectionXml((await fillHwpx(await buildHwpx(body), values({ 본문: 'a\nb\nc' }))).bytes);
    const paras = xml.match(/<hp:p [^>]*>/g)!;
    expect(paras).toHaveLength(3);
    expect(paras[0]).toContain('pageBreak="1"');
    expect(paras[0]).toContain('columnBreak="1"');
    for (const tag of paras.slice(1)) {
      expect(tag).toContain('pageBreak="0"');
      expect(tag).toContain('columnBreak="0"');
      expect(tag).toContain('paraPrIDRef="3"');
    }
  });

  it('표 칸에 여분 줄이 생기면 표를 품은 바깥 문단의 줄 배치 캐시도 지운다 — 다른 문단 것은 둔다', async () => {
    const seg = '<hp:linesegarray><hp:lineseg textpos="0" vertsize="9000"/></hp:linesegarray>';
    const outer = table([['칸', '{{칸값}}']]).replace('</hp:run></hp:p>', `</hp:run>${seg}</hp:p>`);
    const bytes = await buildHwpx(outer + para('그대로', '8'));
    expect(await sectionXml(bytes)).toContain(`</hp:tbl></hp:run>${seg}</hp:p>`);
    const xml = await sectionXml((await fillHwpx(bytes, values({ 칸값: 'x\ny' }))).bytes);
    expect(xml).toMatch(/<\/hp:tbl><\/hp:run><\/hp:p>/);
    expect(xml).not.toContain('vertsize="9000"');
    expect(xml.match(/<hp:p [^>]*paraPrIDRef="8"[\s\S]*?<\/hp:p>/)![0]).toContain('linesegarray');
  });
});

describe('XML 안전', () => {
  it('XML 1.0에서 금지된 문자는 넣지 않는다 — 파일이 다시 읽힌다', async () => {
    const bytes = await buildHwpx(para('{{비고}}'));
    const result = await fillHwpx(bytes, values({ 비고: 'x\u000by\u0000z\u001f\ud800w' }));
    const xml = await sectionXml(result.bytes);
    expect(xml).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\ud800]/);
    expect(await extractTextFromHwp(result.bytes, 'o.hwpx')).toContain('xyzw');
  });

  it('잘못된 숫자 문자 참조는 대체 문자로 읽고 던지지 않는다', () => {
    expect(unescapeXml('a&#x110000;b&#99999999;c&#65;')).toBe('a�b�cA');
  });
});

describe('zip 항목 보존', () => {
  /** 로컬 헤더를 차례로 읽어 이름 → 압축 방식 */
  function methods(buf: Buffer): Map<string, number> {
    const out = new Map<string, number>();
    let off = 0;
    while (buf.readUInt32LE(off) === 0x04034b50) {
      const method = buf.readUInt16LE(off + 8);
      const size = buf.readUInt32LE(off + 18);
      const n = buf.readUInt16LE(off + 26);
      const e = buf.readUInt16LE(off + 28);
      out.set(buf.subarray(off + 30, off + 30 + n).toString('utf8'), method);
      off += 30 + n + e + size;
    }
    return out;
  }

  it('무압축으로 저장된 그림은 그대로 무압축이고, 폴더 항목이 새로 생기지 않는다', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const bytes = await buildHwpx(para('{{제목}}'), { binData: png });
    expect(methods(bytes).get('BinData/image1.png')).toBe(0);
    const result = await fillHwpx(bytes, values({ 제목: '새 제목' }));
    const m = methods(result.bytes);
    expect(m.get('BinData/image1.png')).toBe(0);
    expect(m.get('mimetype')).toBe(0);
    expect(m.get('Contents/section0.xml')).toBe(8);
    expect([...m.keys()].filter((n) => n.endsWith('/'))).toEqual([]);
    const zip = await JSZip.loadAsync(result.bytes);
    expect(Object.keys(zip.files).filter((n) => n.endsWith('/'))).toEqual([]);
    expect(Buffer.from(await zip.file('BinData/image1.png')!.async('uint8array'))).toEqual(png);
  });
});
