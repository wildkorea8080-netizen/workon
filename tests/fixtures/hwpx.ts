import JSZip from 'jszip';

/**
 * 시험용 HWPX. 한글이 저장하는 파일의 뼈대(mimetype · version · header ·
 * section · 미리보기)를 흉내 낸다. 한글 호환은 확인 지점 A에서 진짜 파일로 본다.
 */
export const NS =
  'xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section"';

export const HEADER =
  '<?xml version="1.0" encoding="UTF-8"?><hh:head xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" version="1.4"><hh:refList><hh:fontfaces itemCnt="0"/></hh:refList></hh:head>';

const LINESEG =
  '<hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="42520" flags="393216"/></hp:linesegarray>';

/** 문단 하나. 배열이면 조각(run)마다 하나씩 — 한글이 서식을 바꿀 때 쪼개는 모양 */
export function para(text: string | string[], paraPr = '3'): string {
  const runs = (Array.isArray(text) ? text : [text])
    .map((t, i) => `<hp:run charPrIDRef="${i}"><hp:t>${t}</hp:t></hp:run>`)
    .join('');
  return `<hp:p id="1" paraPrIDRef="${paraPr}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">${runs}${LINESEG}</hp:p>`;
}

/** 표 하나를 품은 바깥 문단. 칸마다 문단 하나 */
export function table(rows: string[][]): string {
  const trs = rows
    .map((r) => `<hp:tr>${r.map((c) => `<hp:tc><hp:subList>${para(c, '7')}</hp:subList></hp:tc>`).join('')}</hp:tr>`)
    .join('');
  return `<hp:p id="2" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:tbl id="9" rowCnt="${rows.length}" colCnt="${rows[0].length}">${trs}</hp:tbl></hp:run></hp:p>`;
}

/** 글 조각 없는 빈 문단. 한글은 빈 문단도 글자 서식만 든 빈 조각을 남긴다 */
export function emptyPara(paraPr = '3'): string {
  return `<hp:p id="1" paraPrIDRef="${paraPr}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="4"/>${LINESEG}</hp:p>`;
}

/** 구역 첫 문단 꼴: 구역 설정·단 설정 컨트롤만 들고 글은 없다 */
export const SEC_PR_PARA =
  `<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134"><hp:grid lineGrid="0" charGrid="0"/></hp:secPr><hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl></hp:run>${LINESEG}</hp:p>`;

export function secPrPara(): string {
  return SEC_PR_PARA;
}

/**
 * 표 하나를 품은 바깥 문단(한글처럼 표 뒤에 줄 배치 캐시가 있다).
 * 칸 값이 ''이면 빈 문단, 배열이면 칸 안 문단 여러 개. addr이면 한글처럼 칸 내용 뒤에 칸 주소를 단다
 */
export function tableAt(rows: (string | string[])[][], opts: { addr?: boolean } = {}): string {
  const cellParas = (c: string | string[]) =>
    (Array.isArray(c) ? c : [c]).map((t) => (t === '' ? emptyPara('7') : para(t, '7'))).join('');
  const trs = rows
    .map(
      (r, ri) =>
        `<hp:tr>${r
          .map(
            (c, ci) =>
              `<hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="3"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER">${cellParas(c)}</hp:subList>${
                opts.addr ? `<hp:cellAddr colAddr="${ci}" rowAddr="${ri}"/><hp:cellSpan colSpan="1" rowSpan="1"/>` : ''
              }<hp:cellSz width="1000" height="282"/></hp:tc>`
          )
          .join('')}</hp:tr>`
    )
    .join('');
  return `<hp:p id="2" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:tbl id="9" rowCnt="${rows.length}" colCnt="${rows[0].length}">${trs}</hp:tbl><hp:t/></hp:run>${LINESEG}</hp:p>`;
}

export async function buildHwpx(
  body: string,
  opts: { prvText?: string; binData?: Buffer; prvImage?: Buffer; /** section1.xml부터 차례로 */ moreSections?: string[] } = {}
): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/hwp+zip', { compression: 'STORE', createFolders: false });
  zip.file('version.xml', '<?xml version="1.0" encoding="UTF-8"?><hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" major="5" minor="1"/>', { createFolders: false });
  zip.file('Contents/header.xml', HEADER, { createFolders: false });
  [body, ...(opts.moreSections ?? [])].forEach((b, i) =>
    zip.file(`Contents/section${i}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><hs:sec ${NS}>${b}</hs:sec>`, { createFolders: false })
  );
  zip.file('Preview/PrvText.txt', opts.prvText ?? '미리보기 {{제목}}', { createFolders: false });
  if (opts.prvImage) zip.file('Preview/PrvImage.png', opts.prvImage, { compression: 'STORE', createFolders: false });
  // 그림 같은 이미 압축된 항목은 한글이 무압축으로 저장한다
  if (opts.binData) zip.file('BinData/image1.png', opts.binData, { compression: 'STORE', createFolders: false });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

export async function sectionXml(bytes: Buffer, n = 0): Promise<string> {
  return (await JSZip.loadAsync(bytes)).file(`Contents/section${n}.xml`)!.async('string');
}
