// src/lib/work/documents/package-check.ts
import JSZip from 'jszip';
import { XMLValidator } from 'fast-xml-parser';

/**
 * 만든 파일·올린 파일의 실제 패키지 검사 (개편 04 문서 4절 6단계·9절).
 * 확장자만 바꾼 파일, 깨진 zip, 경로 탈출, 압축 폭탄, 외부 엔티티(DOCTYPE), 남은 {{표시}}를 거른다.
 *
 * 이 검사는 **구조**까지다. 한글에서의 시각 확인(쪽 배치·글꼴)은 별도(scripts/hancom-verify.ps1·렌더러)이고
 * 이 검사를 통과했다고 '한글 검증'이라 부르지 않는다.
 */
export const MAX_PACKAGE_BYTES = 20 * 1024 * 1024;
export const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
export const MAX_ENTRIES = 2000;
export const MAX_XML_CHECK_BYTES = 30 * 1024 * 1024;

export interface PackageCheck {
  valid: boolean;
  format: 'hwpx' | 'xlsx' | 'docx' | 'unknown';
  sizeBytes: number;
  entries: number;
  uncompressedBytes: number;
  problems: string[];
  /** 기대한 글 중 문서 본문에서 찾지 못한 것 */
  missingValues: string[];
  leftoverMarkers: string[];
}

function isSafeEntryName(name: string): boolean {
  return !name.startsWith('/') && !name.startsWith('\\') && !/^[A-Za-z]:/.test(name) && !name.split(/[\\/]/).includes('..');
}

const decode = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** XML에서 글 조각만 이어 붙인다(HWPX hp:t, XLSX t, DOCX w:t) — 값 확인용 */
function textOf(xml: string, tag: RegExp): string {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = tag.exec(xml))) out.push(decode(m[1]));
  return out.join('\u0001');
}

/**
 * expectedValues는 줄 단위로 본다 — 여러 줄 값은 문단이 나뉘므로 줄마다 따로 있어야 한다.
 * 글자 사이 공백 차이는 무시한다(한글이 다시 저장하며 띄어쓰기 조각을 나누는 일이 있다).
 */
export async function checkPackage(
  bytes: Buffer,
  expected: { format: 'hwpx' | 'xlsx' | 'docx'; values?: string[] }
): Promise<PackageCheck> {
  const result: PackageCheck = {
    valid: false,
    format: 'unknown',
    sizeBytes: bytes.length,
    entries: 0,
    uncompressedBytes: 0,
    problems: [],
    missingValues: [],
    leftoverMarkers: [],
  };
  if (bytes.length === 0) {
    result.problems.push('빈 파일');
    return result;
  }
  if (bytes.length > MAX_PACKAGE_BYTES) result.problems.push(`파일이 너무 큼(${bytes.length}B)`);
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04)) {
    result.problems.push('zip 패키지가 아님(확장자만 바꾼 파일일 수 있음)');
    return result;
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    result.problems.push('zip을 열 수 없음');
    return result;
  }
  const files = Object.values(zip.files).filter((f) => !f.dir);
  result.entries = files.length;
  if (files.length > MAX_ENTRIES) {
    result.problems.push(`항목이 너무 많음(${files.length})`);
    return result;
  }
  for (const f of files) {
    // JSZip은 읽을 때 '../'를 다듬어 name에 넣고 원래 이름을 unsafeOriginalName에 남긴다 — 원래 이름으로 본다
    const original = (f as unknown as { unsafeOriginalName?: string }).unsafeOriginalName ?? f.name;
    if (!isSafeEntryName(original)) result.problems.push(`위험한 항목 경로: ${original.slice(0, 80)}`);
    // JSZip이 아는 압축 전 크기(헤더 값) — 실제로 풀기 전에 압축 폭탄을 거른다
    const size = (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
    result.uncompressedBytes += size;
  }
  if (result.uncompressedBytes > MAX_UNCOMPRESSED_BYTES) {
    result.problems.push(`풀면 너무 큼(${result.uncompressedBytes}B)`);
    return result;
  }

  const has = (n: string) => Boolean(zip.file(n));
  const fmt = expected.format;
  if (fmt === 'hwpx') {
    const mime = zip.file('mimetype') ? (await zip.file('mimetype')!.async('string')).trim() : null;
    if (mime !== 'application/hwp+zip') result.problems.push(`mimetype ${mime ?? '없음'}`);
    if (!has('Contents/content.hpf')) result.problems.push('Contents/content.hpf 없음');
    if (!files.some((f) => /^Contents\/section\d+\.xml$/.test(f.name))) result.problems.push('Contents/section*.xml 없음');
    if (!has('META-INF/container.xml')) result.problems.push('META-INF/container.xml 없음');
  } else if (fmt === 'xlsx') {
    if (!has('[Content_Types].xml')) result.problems.push('[Content_Types].xml 없음');
    if (!has('xl/workbook.xml')) result.problems.push('xl/workbook.xml 없음');
    if (files.some((f) => /^xl\/vbaProject\.bin$/i.test(f.name))) result.problems.push('매크로 포함');
  } else {
    if (!has('[Content_Types].xml')) result.problems.push('[Content_Types].xml 없음');
    if (!has('word/document.xml')) result.problems.push('word/document.xml 없음');
  }
  result.format = fmt;

  const textParts: string[] = [];
  let checked = 0;
  for (const f of files.filter((x) => /\.(xml|hpf|rels)$/i.test(x.name))) {
    const xml = await f.async('string');
    checked += xml.length;
    if (checked > MAX_XML_CHECK_BYTES) {
      result.problems.push('XML이 너무 커서 끝까지 검사하지 못함');
      break;
    }
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) result.problems.push(`DOCTYPE/ENTITY 포함: ${f.name}`);
    const ok = XMLValidator.validate(xml);
    if (ok !== true) result.problems.push(`XML 형식 오류: ${f.name}`);
    if (fmt === 'hwpx' && /^Contents\/section\d+\.xml$/.test(f.name)) textParts.push(textOf(xml, /<hp:t(?:\s[^>]*)?>([^<]*)<\/hp:t>/g));
    if (fmt === 'xlsx' && /^xl\/(sharedStrings|worksheets\/sheet\d+)\.xml$/.test(f.name)) textParts.push(textOf(xml, /<t(?:\s[^>]*)?>([^<]*)<\/t>/g));
    if (fmt === 'docx' && f.name === 'word/document.xml') textParts.push(textOf(xml, /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g));
  }

  const body = textParts.join('\u0001');
  const squash = (s: string) => s.replace(/[\s\u0001]+/g, '');
  const flat = squash(body);
  result.leftoverMarkers = [...new Set([...flat.matchAll(/\{\{([^{}]{1,40})\}\}/g)].map((m) => m[1]))];
  if (result.leftoverMarkers.length) result.problems.push(`채우지 않은 표시가 남음: ${result.leftoverMarkers.join(', ')}`);
  for (const v of expected.values ?? []) {
    for (const line of v.split('\n')) {
      const needle = squash(line);
      if (needle && !flat.includes(needle)) result.missingValues.push(line.slice(0, 60));
    }
  }
  if (result.missingValues.length) result.problems.push(`넣은 글이 파일에 없음: ${result.missingValues.length}줄`);
  result.valid = result.problems.length === 0;
  return result;
}
