import { fillHwpx } from '@/lib/doc-fill/hwpx';
import { openHwpx, readEntry, scanParagraphs, applyEdits, writeHwpx } from '@/lib/doc-fill/hwpx-core';
import { paragraphPrefix } from '@/lib/doc-fill/xml-scan';
import { checkPackage } from '@/lib/work/documents/package-check';
import { markdownToDocumentText } from '@/lib/apps/markdown-text';

/** Package the stored answer literally; never ask a model to rewrite an export. Only markdown markers are removed (markdownToDocumentText). */
export async function buildAppResultHwpx(template: Buffer, input: { name: string; version: number | null; content: string; references: Record<string, unknown>; createdAt: string }): Promise<Buffer> {
  if (!input.content.trim() || input.content.length > 60000) throw new Error('내보낼 결과의 길이를 확인해 주세요.');
  const doc = await openHwpx(template); const sections = new Map<string, string>();
  const unused = new Set(['□ 추진 경과', '□ 향후 계획', '□ 건의 사항', '{{추진 경과}}', '{{향후 계획}}', '{{건의 사항}}']);
  for (const name of doc.sections) {
    const xml = await readEntry(doc.zip, name);
    const edits = scanParagraphs(xml, paragraphPrefix(xml)).filter(p => unused.has(p.text.trim())).map(p => ({ start: p.start, end: p.end, text: '' }));
    sections.set(name, applyEdits(xml, edits));
  }
  const base = await writeHwpx(doc, sections);
  const overview = [`AI가 작성한 초안입니다. 최종 사용 전 사실과 표현을 검토해 주세요.`, `앱: ${input.name}`, ...(input.version ? [`실행 설정 버전: ${input.version}`] : [])];
  const refs = input.references;
  if (refs.documents_skipped === true) overview.push('참고 문서 없이 작성된 결과입니다.');
  const numbers = refs.number_check as { unverified?: unknown } | undefined;
  if (Array.isArray(numbers?.unverified)) overview.push(`원자료에서 확인되지 않은 숫자: ${numbers.unverified.filter(n => typeof n === 'string').join(', ')}`);
  const verify = refs.verify as { grounded?: unknown } | undefined;
  if (verify?.grounded === false) overview.push('답변 근거 검증에서 확인이 필요한 부분이 있습니다.');
  const citations: string[] = [];
  if (Array.isArray(refs.chunks)) for (const [index, raw] of refs.chunks.entries()) {
    if (!raw || typeof raw !== 'object') continue;
    const c = raw as Record<string, unknown>;
    if (typeof c.documentTitle === 'string') citations.push(`[${typeof c.n === 'number' ? c.n : index + 1}] ${c.documentTitle}${typeof c.page === 'number' ? ` · ${c.page}쪽` : ''}`);
  }
  if (Array.isArray(refs.links)) for (const raw of refs.links) {
    if (!raw || typeof raw !== 'object') continue;
    const link = raw as Record<string, unknown>;
    if (typeof link.url === 'string' && /^https?:\/\//i.test(link.url)) citations.push(`${typeof link.title === 'string' ? link.title : '외부 출처'}: ${link.url}`);
  }
  const text = markdownToDocumentText(input.content);
  if (!text.trim()) throw new Error('내보낼 결과의 길이를 확인해 주세요.');
  const body = text + (citations.length ? `\n\n참고한 출처\n${citations.join('\n')}` : '');
  const title = `[AI 작성 초안] ${input.name}`;
  const values = new Map([['제목', title], ['작성일', `파일 생성: ${input.createdAt}`], ['작성부서', ''], ['개요', overview.join('\n')], ['주요 내용', body]]);
  const result = await fillHwpx(base, values);
  const checked = await checkPackage(result.bytes, { format: 'hwpx', values: [title, ...text.split('\n').filter(Boolean)] });
  if (!checked.valid) throw new Error('한글 파일 구조 검증을 통과하지 못했습니다.');
  return result.bytes;
}
