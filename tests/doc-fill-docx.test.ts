import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { readDocxMarkers, fillDocx } from '@/lib/doc-fill/docx';
import { buildDocx, wp, wtable } from './fixtures/docx';

const textOf = async (bytes: Buffer) => (await mammoth.extractRawText({ buffer: bytes })).value;
const entry = async (bytes: Buffer, name: string) => (await JSZip.loadAsync(bytes)).file(name)!.async('string');
const count = (s: string, needle: string) => s.split(needle).length - 1;

describe('DOCX 표시 읽기', () => {
  it('표시를 문서 순서로 읽는다 — 조각난 표시·머리글 포함', async () => {
    const bytes = await buildDocx(
      wp(['{{제', '목}}']) + wtable([['{{작성자}}', '{{제목}}']]) + wp('{{본문}}'),
      { header: wp('{{기관명}}'), footer: wp('{{쪽수}}') }
    );
    // 머리글 → 본문 → 바닥글, 같은 이름은 한 번만
    expect(await readDocxMarkers(bytes)).toEqual(['기관명', '제목', '작성자', '본문', '쪽수']);
  });

  it('표시가 없으면 빈 목록', async () => {
    expect(await readDocxMarkers(await buildDocx(wp('그냥 글')))).toEqual([]);
  });

  it('열 수 없는 파일은 이유와 함께 던진다', async () => {
    await expect(readDocxMarkers(Buffer.from('PK\u0003\u0004 broken'))).rejects.toThrow('Word(DOCX)');
    const noBody = new JSZip();
    noBody.file('x.txt', 'x');
    await expect(readDocxMarkers(await noBody.generateAsync({ type: 'nodebuffer' }))).rejects.toThrow('Word(DOCX)');
  });
});

describe('DOCX 표시 채우기', () => {
  it('채우면 다시 읽은 본문에 글이 있고 표시가 없다', async () => {
    const bytes = await buildDocx(wp(['{{제', '목}}']) + wtable([['{{작성자}}', '값']]) + wp('{{본문}}'), { header: wp('{{기관명}}') });
    const r = await fillDocx(
      bytes,
      new Map([['제목', '분기 보고'], ['작성자', '홍길동'], ['본문', '첫째\n둘째'], ['기관명', '○○시']])
    );
    expect(r.filled).toEqual(['기관명', '제목', '작성자', '본문']);
    expect(r.unfilled).toEqual([]);
    const text = await textOf(r.bytes);
    expect(text).toContain('분기 보고');
    expect(text).toContain('홍길동');
    expect(text).toContain('첫째');
    expect(text).toContain('둘째');
    expect(text).not.toContain('{{');
    const header = await entry(r.bytes, 'word/header1.xml');
    expect(header).toContain('○○시');
    expect(header).not.toContain('{{');
  });

  it('값이 없는 표시는 그대로 두고 unfilled로', async () => {
    const r = await fillDocx(await buildDocx(wp('{{가}}') + wp('{{나}}')), new Map([['가', 'A']]));
    expect(r.filled).toEqual(['가']);
    expect(r.unfilled).toEqual(['나']);
    expect(await textOf(r.bytes)).toContain('{{나}}');
  });

  it('여분 줄은 새 문단 — pPr의 pageBreakBefore·numPr는 넘기지 않고 rPr는 표시의 것', async () => {
    const pPr = '<w:pPr><w:pStyle w:val="Body"/><w:numPr><w:ilvl w:val="0"/></w:numPr><w:pageBreakBefore/></w:pPr>';
    const bytes = await buildDocx(wp('{{본문}}', { pPr, rPr: '<w:rPr><w:b/></w:rPr>' }));
    const r = await fillDocx(bytes, new Map([['본문', 'a\nb']]));
    const xml = await entry(r.bytes, 'word/document.xml');
    const paras = xml.match(/<w:p>.*?<\/w:p>/g)!;
    expect(paras).toHaveLength(2);
    // 첫 문단은 원래 pPr 그대로
    expect(paras[0]).toContain('<w:numPr>');
    expect(paras[0]).toContain('<w:pageBreakBefore/>');
    // 둘째 문단
    expect(paras[1]).toContain('w:pStyle');
    expect(paras[1]).not.toContain('numPr');
    expect(paras[1]).not.toContain('pageBreakBefore');
    expect(paras[1]).toContain('<w:b/>');
    expect(paras[1]).toContain('>b</w:t>');
    expect(await textOf(r.bytes)).toContain('a');
  });

  it('구역 나눔(sectPr)은 마지막 이어 붙인 문단으로 옮긴다', async () => {
    const pPr = '<w:pPr><w:pStyle w:val="Body"/><w:sectPr><w:pgSz w:w="11906"/></w:sectPr></w:pPr>';
    const bytes = await buildDocx(wp('{{본문}}', { pPr }));
    const r = await fillDocx(bytes, new Map([['본문', 'a\nb\nc']]));
    const xml = await entry(r.bytes, 'word/document.xml');
    const paras = xml.match(/<w:p>.*?<\/w:p>/g)!;
    expect(paras).toHaveLength(3);
    expect(count(xml, 'sectPr>')).toBe(2); // 여는 태그 하나 + 닫는 태그 하나 = 구역 설정 1개
    expect(count(xml, '<w:sectPr>')).toBe(1);
    expect(paras[0]).not.toContain('sectPr');
    expect(paras[1]).not.toContain('sectPr');
    expect(paras[2]).toContain('<w:sectPr><w:pgSz w:w="11906"/></w:sectPr>');
    expect(paras[2]).toContain('>c</w:t>');
    expect(paras[2]).toContain('w:pStyle');
  });

  it('여러 줄이 아니면 sectPr는 원래 문단에 그대로', async () => {
    const pPr = '<w:pPr><w:sectPr><w:pgSz w:w="11906"/></w:sectPr></w:pPr>';
    const r = await fillDocx(await buildDocx(wp('{{본문}}', { pPr })), new Map([['본문', 'a']]));
    const xml = await entry(r.bytes, 'word/document.xml');
    expect(xml.match(/<w:p>.*?<\/w:p>/g)).toHaveLength(1);
    expect(xml).toContain('<w:pPr><w:sectPr><w:pgSz w:w="11906"/></w:sectPr></w:pPr>');
  });

  it('pPr에 sectPr만 있어도 마지막 문단에 pPr을 만들어 단다', async () => {
    const r = await fillDocx(await buildDocx(wp('{{본문}}', { pPr: '<w:pPr><w:sectPr/></w:pPr>' })), new Map([['본문', 'a\nb']]));
    const paras = (await entry(r.bytes, 'word/document.xml')).match(/<w:p>.*?<\/w:p>/g)!;
    expect(paras[0]).not.toContain('sectPr');
    expect(paras[1]).toContain('<w:pPr><w:sectPr/></w:pPr>');
  });

  it('복사본에서 변경 추적 표시를 뺀다 — 원래 문단은 그대로', async () => {
    const pPr =
      '<w:pPr><w:pStyle w:val="Body"/><w:rPr><w:del w:id="1" w:author="x"/><w:b/></w:rPr><w:pPrChange w:id="2" w:author="x"><w:pPr><w:jc w:val="left"/></w:pPr></w:pPrChange></w:pPr>';
    const rPr = '<w:rPr><w:i/><w:rPrChange w:id="3" w:author="x"><w:rPr/></w:rPrChange></w:rPr>';
    const r = await fillDocx(await buildDocx(wp('{{본문}}', { pPr, rPr })), new Map([['본문', 'a\nb']]));
    const paras = (await entry(r.bytes, 'word/document.xml')).match(/<w:p>.*?<\/w:p>/g)!;
    for (const tag of ['w:del ', 'pPrChange', 'rPrChange']) expect(paras[0]).toContain(tag);
    for (const tag of ['w:del', 'w:ins', 'pPrChange', 'rPrChange']) expect(paras[1]).not.toContain(tag);
    expect(paras[1]).toContain('<w:b/>');
    expect(paras[1]).toContain('<w:i/>');
    expect(paras[1]).toContain('w:pStyle');
  });

  it('pPr·rPr가 없으면 그 부분 없이 새 문단을 만든다', async () => {
    const r = await fillDocx(await buildDocx(wp('{{본문}}')), new Map([['본문', 'a\nb\nc']]));
    const xml = await entry(r.bytes, 'word/document.xml');
    expect(xml).toContain('<w:p><w:r><w:t xml:space="preserve">b</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">c</w:t></w:r></w:p>');
  });

  it('속성이 붙은 쪽 나눔과 번호 매김도 넘기지 않는다', async () => {
    const pPr = '<w:pPr><w:pageBreakBefore w:val="1"/><w:numPr><w:numId w:val="3"/></w:numPr><w:jc w:val="center"/></w:pPr>';
    const r = await fillDocx(await buildDocx(wp('{{본문}}', { pPr })), new Map([['본문', 'a\nb']]));
    const paras = (await entry(r.bytes, 'word/document.xml')).match(/<w:p>.*?<\/w:p>/g)!;
    expect(paras[1]).toContain('<w:jc w:val="center"/>');
    expect(paras[1]).not.toContain('pageBreakBefore');
    expect(paras[1]).not.toContain('numPr');
  });

  it('앞뒤 공백을 지키고 특수문자를 이스케이프한다', async () => {
    const r = await fillDocx(await buildDocx(wp('{{본문}}')), new Map([['본문', ' A & <B> ']]));
    const xml = await entry(r.bytes, 'word/document.xml');
    expect(xml).toContain('xml:space="preserve"> A &amp; &lt;B&gt; </w:t>');
    expect(await textOf(r.bytes)).toContain(' A & <B> ');
  });

  it('XML에 쓸 수 없는 글자는 뺀다', async () => {
    const r = await fillDocx(await buildDocx(wp('{{본문}}')), new Map([['본문', 'a\u0001b']]));
    expect(await entry(r.bytes, 'word/document.xml')).toContain('>ab</w:t>');
  });

  it('조각난 표시는 첫 조각에 글을, 나머지는 비운다', async () => {
    const r = await fillDocx(await buildDocx(wp(['앞 {{제', '목}} 뒤'])), new Map([['제목', 'X']]));
    expect(await textOf(r.bytes)).toContain('앞 X 뒤');
  });

  it('글상자 안의 문단은 제 문단으로 취급한다', async () => {
    const box =
      '<w:p><w:r><w:t>바깥</w:t></w:r><w:r><w:txbxContent>' + wp('{{상자}}') + '</w:txbxContent></w:r></w:p>';
    const bytes = await buildDocx(box);
    expect(await readDocxMarkers(bytes)).toEqual(['상자']);
    const r = await fillDocx(bytes, new Map([['상자', '가\n나']]));
    const xml = await entry(r.bytes, 'word/document.xml');
    expect(xml).toContain('바깥');
    // 여분 줄은 글상자 안에 이어진다
    expect(xml).toMatch(/<w:txbxContent>.*>가<\/w:t>.*>나<\/w:t>.*<\/w:txbxContent>/);
  });

  it('다른 항목은 내용 그대로', async () => {
    const bytes = await buildDocx(wp('{{본문}}'), { header: wp('머리') });
    const r = await fillDocx(bytes, new Map([['본문', 'x']]));
    for (const name of ['[Content_Types].xml', '_rels/.rels', 'word/_rels/document.xml.rels', 'word/header1.xml']) {
      expect(await entry(r.bytes, name)).toBe(await entry(bytes, name));
    }
  });

  it('원래 압축 방식을 지킨다', async () => {
    const zip = await JSZip.loadAsync(await buildDocx(wp('{{본문}}')));
    zip.file('word/media/a.png', Buffer.from([1, 2, 3, 4]), { compression: 'STORE' });
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const r = await fillDocx(bytes, new Map([['본문', 'x']]));
    const out = await JSZip.loadAsync(r.bytes);
    const magic = (n: string) => (out.files[n] as unknown as { _data: { compression: { magic: string } } })._data.compression.magic;
    expect(magic('word/media/a.png')).toBe('\u0000\u0000');
    expect(magic('word/document.xml')).not.toBe('\u0000\u0000');
  });
});
