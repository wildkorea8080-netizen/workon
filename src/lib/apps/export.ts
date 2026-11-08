import { fillHwpx, readHwpxMarkers } from '@/lib/doc-fill/hwpx';
import { openHwpx, readEntry, scanParagraphs, applyEdits, writeHwpx } from '@/lib/doc-fill/hwpx-core';
import { paragraphPrefix } from '@/lib/doc-fill/xml-scan';
import { checkPackage } from '@/lib/work/documents/package-check';
import { markdownToDocumentBlocks, tableAsText, type DocumentTable } from '@/lib/apps/markdown-text';
import { insertHwpxTables, tableFits, tableMarker } from '@/lib/doc-fill/hwpx-table';

export type AppResultInput = { name: string; version: number | null; content: string; references: Record<string, unknown>; createdAt: string };

/** 기관 양식에서 결과 본문을 넣을 표시 — 앞의 것부터 처음 있는 하나(`{{주요 내용}}`·`{{본문}}`·`{{결과}}`·`{{내용}}`) */
export const APP_EXPORT_BODY_MARKERS = ['주요 내용', '본문', '결과', '내용'] as const;

/** 기관 양식을 쓸 수 없을 때 — 라우트가 422로 이 글을 그대로 보인다 */
export class AppExportTemplateError extends Error {}

/** 저장된 답을 문서 조각으로 — 모델 없이 마크다운 표시만 걷어내고 표는 표지로 남긴다(두 내보내기가 같은 규칙) */
function composeAppResult(input: AppResultInput) {
  if (!input.content.trim() || input.content.length > 60000) throw new Error('내보낼 결과의 길이를 확인해 주세요.');
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
  const tables: DocumentTable[] = [];
  const blocks = markdownToDocumentBlocks(input.content);
  const text = blocks.map(b => b.kind === 'text' ? b.text : tableFits(b) ? tableMarker(tables.push(b) - 1) : tableAsText(b)).join('\n');
  if (!text.trim()) throw new Error('내보낼 결과의 길이를 확인해 주세요.');
  const cellLines = tables.flatMap(t => [t.header, ...t.rows].flat()).flatMap(c => c.split(/<br\s*\/?>/i)).map(c => c.trim()).filter(Boolean);
  const body = text + (citations.length ? `\n\n참고한 출처\n${citations.join('\n')}` : '');
  const title = `[AI 작성 초안] ${input.name}`;
  const lines = text.split('\n').filter(line => line && !tables.some((_, i) => line === tableMarker(i)));
  return { title, overview: overview.join('\n'), body, tables, checkValues: [title, ...lines, ...cellLines] };
}

async function finish(filled: Buffer, parts: ReturnType<typeof composeAppResult>): Promise<Buffer> {
  const bytes = await insertHwpxTables(filled, parts.tables);
  const checked = await checkPackage(bytes, { format: 'hwpx', values: parts.checkValues });
  if (!checked.valid) throw new Error('한글 파일 구조 검증을 통과하지 못했습니다.');
  return bytes;
}

/** Package the stored answer literally; never ask a model to rewrite an export. Only markdown markers are removed (markdownToDocumentBlocks); markdown tables become real HWPX tables (too large ones stay ' | ' text). */
export async function buildAppResultHwpx(template: Buffer, input: AppResultInput): Promise<Buffer> {
  const parts = composeAppResult(input);
  const doc = await openHwpx(template); const sections = new Map<string, string>();
  const unused = new Set(['□ 추진 경과', '□ 향후 계획', '□ 건의 사항', '{{추진 경과}}', '{{향후 계획}}', '{{건의 사항}}']);
  for (const name of doc.sections) {
    const xml = await readEntry(doc.zip, name);
    const edits = scanParagraphs(xml, paragraphPrefix(xml)).filter(p => unused.has(p.text.trim())).map(p => ({ start: p.start, end: p.end, text: '' }));
    sections.set(name, applyEdits(xml, edits));
  }
  const base = await writeHwpx(doc, sections);
  const values = new Map([['제목', parts.title], ['작성일', `파일 생성: ${input.createdAt}`], ['작성부서', ''], ['개요', parts.overview], ['주요 내용', parts.body]]);
  return finish((await fillHwpx(base, values)).bytes, parts);
}

/**
 * 앱 비서에 올려 둔 기관 양식(HWPX)에 결과를 담는다. 본문 표시(`APP_EXPORT_BODY_MARKERS`)가 없으면 넣을 곳을 짐작하지 않고 거절한다.
 * `{{제목}}`·`{{작성일}}`·`{{개요}}`는 채우고, `{{개요}}`가 없으면 AI 초안 안내·확인 필요 안내를 본문 맨 앞에 둔다(어느 양식이든 빠지지 않게).
 * 그 밖의 표시는 빈 칸으로 두고 이름을 돌려준다(`emptied` — 사람이 한글에서 채운다). 원래 양식의 서식·다른 글은 그대로다
 */
export async function buildAppResultInTemplate(template: Buffer, input: AppResultInput): Promise<{ bytes: Buffer; emptied: string[] }> {
  const parts = composeAppResult(input);
  let markers: string[];
  try { markers = await readHwpxMarkers(template); } catch { throw new AppExportTemplateError('양식을 한글(HWPX) 파일로 열지 못했습니다. 한글에서 HWPX로 다시 저장해 올려 주세요.'); }
  const bodyKey = APP_EXPORT_BODY_MARKERS.find(key => markers.includes(key));
  if (!bodyKey) throw new AppExportTemplateError('이 양식에는 결과를 넣을 {{주요 내용}}(또는 {{본문}}) 표시가 없습니다. 양식의 본문 자리에 {{주요 내용}}을 적어 다시 올려 주세요.');
  const hasOverview = markers.includes('개요');
  const values = new Map<string, string>(markers.map(key => [key, '']));
  values.set(bodyKey, hasOverview ? parts.body : `${parts.overview}\n\n${parts.body}`);
  if (hasOverview) values.set('개요', parts.overview);
  if (markers.includes('제목')) values.set('제목', parts.title);
  if (markers.includes('작성일')) values.set('작성일', `파일 생성: ${input.createdAt}`);
  const used = new Set<string>([bodyKey, '제목', '작성일', ...(hasOverview ? ['개요'] : [])]);
  const bytes = await finish((await fillHwpx(template, values)).bytes, parts);
  return { bytes, emptied: markers.filter(key => !used.has(key)) };
}
