import { readFileSync } from 'fs';
import path from 'path';
import { readFillableTemplate, generateDocumentFile } from '@/lib/work/documents/generate-file';
import { fieldsFromSlots } from '@/lib/work/documents/fields';
import { openHwpx, readEntry, writeHwpx } from '@/lib/doc-fill/hwpx-core';

/**
 * '작년 파일' 바이트. 표준 보고서 양식(assets/templates/report.hwpx)을 실제 채우기 엔진으로 채운다.
 * values의 열쇠는 양식 자리 이름(제목·작성일·작성부서·개요·추진 경과·주요 내용·향후 계획·건의 사항). 안 준 자리는 비운다.
 * opts.appendXml을 주면 첫 구역 끝(</hs:sec> 앞)에 그 XML(문단·표 — tests/fixtures/hwpx.ts의 para·tableAt)을 덧붙인다.
 */
export async function priorFixture(values: Record<string, string>, opts: { appendXml?: string } = {}): Promise<Buffer> {
  const bytes = readFileSync(path.join(process.cwd(), 'assets', 'templates', 'report.hwpx'));
  const read = await readFillableTemplate(bytes, 'report.hwpx');
  const fields = fieldsFromSlots(read.slots).map((f) => ({ ...f, value: values[f.label] ?? '' }));
  const filled = (await generateDocumentFile(bytes, 'report.hwpx', fields)).bytes;
  if (!opts.appendXml) return filled;
  const doc = await openHwpx(filled);
  const name = doc.sections[0];
  const xml = await readEntry(doc.zip, name);
  const at = xml.lastIndexOf('</hs:sec>');
  if (at < 0) throw new Error('구역 끝을 찾지 못함');
  return writeHwpx(doc, new Map([[name, xml.slice(0, at) + opts.appendXml + xml.slice(at)]]));
}
