import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { readHwpxMarkers, fillHwpx } from '@/lib/doc-fill/hwpx';
import { findMarkers } from '@/lib/doc-fill/slots';
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

  it('표를 품은 바깥 문단의 표시는 건드리지 않는다 — 복제하면 표가 겹친다', async () => {
    const outer = table([['칸', '{{칸값}}']]).replace('<hp:run charPrIDRef="0"><hp:tbl', '<hp:run charPrIDRef="0"><hp:t>{{바깥}}</hp:t><hp:tbl');
    const bytes = await buildHwpx(outer);
    const result = await fillHwpx(bytes, values({ 바깥: 'X', 칸값: '채움' }));
    const xml = await sectionXml(result.bytes);
    expect(xml.match(/<hp:tbl /g)).toHaveLength(1);
    expect(xml).toContain('채움');
    expect(xml).toContain('{{바깥}}');
  });
});
