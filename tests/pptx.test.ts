import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { extractTextFromPptx, isPptxFile, PptxParseError } from '../src/lib/pptx';
import { ALLOWED_UPLOAD_EXTENSIONS, hasAllowedUploadExtension } from '../src/lib/file-types';

/**
 * PPTX 추출.
 *
 * 실제 PPTX 구조(zip + DrawingML)를 만들어 넣는다. 목을 세우면 "우리가 상상한
 * XML"만 검증하게 되는데, 이 파서가 틀릴 자리는 전부 실제 파일의 형태에서
 * 온다 — 런 분할, 표 중첩, 슬라이드 번호.
 */

/** DrawingML 문단 하나 */
const para = (...runs: string[]) =>
  `<a:p>${runs.map((t) => `<a:r><a:rPr lang="ko-KR"/><a:t>${t}</a:t></a:r>`).join('')}</a:p>`;

const textShape = (...paras: string[]) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="제목"/><p:nvSpPr/></p:nvSpPr>` +
  `<p:txBody><a:bodyPr/>${paras.join('')}</p:txBody></p:sp>`;

/** rows[0]을 머리글로 하는 표 도형 */
const tableShape = (rows: string[][]) =>
  `<p:graphicFrame><a:graphic><a:graphicData><a:tbl>` +
  rows
    .map(
      (row) =>
        `<a:tr h="370840">` +
        row.map((cell) => `<a:tc><a:txBody><a:bodyPr/>${para(cell)}</a:txBody></a:tc>`).join('') +
        `</a:tr>`
    )
    .join('') +
  `</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;

const slideXml = (...shapes: string[]) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
  `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
  `<p:cSld><p:spTree>${shapes.join('')}</p:spTree></p:cSld></p:sld>`;

async function buildPptx(files: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('형식 판정', () => {
  it('확장자로 알아본다', () => {
    expect(isPptxFile('업무보고.pptx')).toBe(true);
    expect(isPptxFile('예산서.xlsx')).toBe(false);
  });

  it('허용 목록에 등록돼 있다', () => {
    // 목록이 흩어져 있어 어긋난 적이 두 번 있다. 단일 정의를 실제로 거치는지 본다.
    expect(ALLOWED_UPLOAD_EXTENSIONS).toContain('.pptx');
    expect(hasAllowedUploadExtension('2026년도 업무계획.PPTX')).toBe(true);
  });
});

describe('슬라이드 추출', () => {
  it('슬라이드마다 번호가 붙는다', async () => {
    const buf = await buildPptx({
      'ppt/slides/slide1.xml': slideXml(textShape(para('2026년도 업무계획'))),
      'ppt/slides/slide2.xml': slideXml(textShape(para('추진 배경'))),
    });

    const text = await extractTextFromPptx(buf);
    expect(text).toContain('## 슬라이드 1');
    expect(text).toContain('2026년도 업무계획');
    expect(text).toContain('## 슬라이드 2');
    expect(text).toContain('추진 배경');
  });

  it('slide10이 slide2보다 뒤에 온다', async () => {
    // 파일명 문자열로 정렬하면 뒤집힌다. 발표자료는 순서가 곧 내용이다.
    const buf = await buildPptx({
      'ppt/slides/slide2.xml': slideXml(textShape(para('둘째장'))),
      'ppt/slides/slide10.xml': slideXml(textShape(para('열째장'))),
    });

    const text = await extractTextFromPptx(buf);
    expect(text.indexOf('둘째장')).toBeLessThan(text.indexOf('열째장'));
  });

  it('서식 때문에 쪼개진 런을 공백 없이 붙인다', async () => {
    // 실제 PPTX는 글자 하나만 색이 달라도 런이 나뉜다.
    const buf = await buildPptx({
      'ppt/slides/slide1.xml': slideXml(textShape(para('2026', '년도 ', '예산'))),
    });

    const text = await extractTextFromPptx(buf);
    expect(text).toContain('2026년도 예산');
  });

  it('빈 슬라이드를 건너뛰어도 번호가 어긋나지 않는다', async () => {
    // 배열 순번으로 번호를 매기면 3번이 2번으로 표시돼 원본에서 그 자리를 못 찾는다.
    const buf = await buildPptx({
      'ppt/slides/slide1.xml': slideXml(textShape(para('표지'))),
      'ppt/slides/slide2.xml': slideXml(),
      'ppt/slides/slide3.xml': slideXml(textShape(para('본론'))),
    });

    const text = await extractTextFromPptx(buf);
    expect(text).toContain('## 슬라이드 3');
    expect(text).not.toContain('## 슬라이드 2');
  });
});

describe('표', () => {
  it('마크다운 표로 복원한다', async () => {
    const buf = await buildPptx({
      'ppt/slides/slide1.xml': slideXml(
        tableShape([
          ['사업명', '예산', '집행률'],
          ['청년지원', '1,200', '82%'],
        ])
      ),
    });

    const text = await extractTextFromPptx(buf);
    expect(text).toContain('| 사업명 | 예산 | 집행률 |');
    expect(text).toContain('| --- | --- | --- |');
    expect(text).toContain('| 청년지원 | 1,200 | 82% |');
  });

  it('표 안의 글자가 두 번 나오지 않는다', async () => {
    // 표를 렌더링한 뒤 그 아래로 또 내려가면 셀 글자가 본문으로도 잡힌다.
    // 그러면 같은 값이 두 번 임베딩되고, "청년지원이 두 개 있다"는 답이 나온다.
    const buf = await buildPptx({
      'ppt/slides/slide1.xml': slideXml(tableShape([['사업명'], ['청년지원']])),
    });

    const text = await extractTextFromPptx(buf);
    expect(text.match(/청년지원/g)?.length).toBe(1);
  });

  it('셀 안의 파이프가 칸을 밀지 않는다', async () => {
    const buf = await buildPptx({
      'ppt/slides/slide1.xml': slideXml(tableShape([['구분'], ['가|나']])),
    });

    const text = await extractTextFromPptx(buf);
    expect(text).toContain('가\\|나');
  });
});

describe('발표자 노트', () => {
  it('본문과 함께 가져온다', async () => {
    // 발표자료는 화면에 결론만 적고 근거는 노트에 두는 일이 많다.
    const buf = await buildPptx({
      'ppt/slides/slide1.xml': slideXml(textShape(para('집행률 82%'))),
      'ppt/notesSlides/notesSlide1.xml': slideXml(
        textShape(para('4분기 이월분 제외 기준입니다'))
      ),
    });

    const text = await extractTextFromPptx(buf);
    expect(text).toContain('[발표자 노트]');
    expect(text).toContain('4분기 이월분 제외 기준입니다');
  });
});

describe('오류 안내', () => {
  it('구형 .ppt는 이유를 밝힌다', async () => {
    // CFB 서명. 공공기관에는 옛 .ppt가 많다.
    const cfb = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    await expect(extractTextFromPptx(cfb)).rejects.toThrow(PptxParseError);
    await expect(extractTextFromPptx(cfb)).rejects.toThrow(/PPTX로 저장/);
  });

  it('글자가 없으면 이미지 자료인지 묻는다', async () => {
    const buf = await buildPptx({ 'ppt/slides/slide1.xml': slideXml() });
    await expect(extractTextFromPptx(buf)).rejects.toThrow(/이미지/);
  });

  it('슬라이드가 없으면 알린다', async () => {
    const buf = await buildPptx({ 'ppt/notesSlides/notesSlide1.xml': slideXml() });
    await expect(extractTextFromPptx(buf)).rejects.toThrow(/슬라이드를 찾을 수 없습니다/);
  });
});
