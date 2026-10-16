import JSZip from 'jszip';

/**
 * 시험용 DOCX. Word가 저장하는 파일의 뼈대(Content_Types · rels · document · 선택 header)를 흉내 낸다.
 */
export const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/** 문단 하나. 배열이면 조각(run)마다 하나씩. rPr는 모든 조각에 같이 붙는다 */
export function wp(text: string | string[], opts: { pPr?: string; rPr?: string } = {}): string {
  const runs = (Array.isArray(text) ? text : [text])
    .map((t) => `<w:r>${opts.rPr ?? ''}<w:t>${t}</w:t></w:r>`)
    .join('');
  return `<w:p>${opts.pPr ?? ''}${runs}</w:p>`;
}

/** 표 하나. 칸마다 문단 하나 */
export function wtable(rows: string[][]): string {
  const trs = rows
    .map((r) => `<w:tr>${r.map((c) => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${wp(c)}</w:tc>`).join('')}</w:tr>`)
    .join('');
  return `<w:tbl><w:tblPr/><w:tblGrid/>${trs}</w:tbl>`;
}

export async function buildDocx(bodyXml: string, opts: { header?: string; footer?: string } = {}): Promise<Buffer> {
  const zip = new JSZip();
  const parts = [
    opts.header !== undefined ? { name: 'header1.xml', root: 'hdr', body: opts.header, type: 'header' } : null,
    opts.footer !== undefined ? { name: 'footer1.xml', root: 'ftr', body: opts.footer, type: 'footer' } : null,
  ].filter((p): p is NonNullable<typeof p> => p !== null);

  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      parts.map((p) => `<Override PartName="/word/${p.name}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${p.type}+xml"/>`).join('') +
      '</Types>'
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
  );
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W_NS}"><w:body>${bodyXml}</w:body></w:document>`
  );
  zip.file(
    'word/_rels/document.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      parts
        .map((p, i) => `<Relationship Id="rId${i + 10}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${p.type}" Target="${p.name}"/>`)
        .join('') +
      '</Relationships>'
  );
  for (const p of parts) {
    zip.file(`word/${p.name}`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:${p.root} xmlns:w="${W_NS}">${p.body}</w:${p.root}>`);
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
