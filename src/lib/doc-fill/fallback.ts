import mammoth from 'mammoth';
import { extractTextFromHwp } from '../hwp';
import { numberedHeadingLevel } from './slots';
import { fillHwpx } from './hwpx';
import { DocFillError } from './errors';

/**
 * 대체 경로(설계 4.4). 직접 채울 수 없는 양식(옛 HWP·표시 없는 HWPX·표시 없는 DOCX)은
 * 본문에서 번호 제목만 목차로 읽고, 기본 보고서 양식에 그 목차대로 담는다.
 * DB·저장소를 모른다 — 바이트를 받아 바이트를 돌려준다.
 */
const READ_FAIL = '양식의 본문을 읽지 못해 목차를 만들 수 없습니다.';

async function bodyText(bytes: Buffer, format: 'hwpx' | 'docx' | 'hwp'): Promise<string> {
  try {
    if (format === 'docx') {
      const { value } = await mammoth.extractRawText({ buffer: bytes });
      if (!value.trim()) throw new Error('empty');
      return value;
    }
    return await extractTextFromHwp(bytes, format === 'hwp' ? 'template.hwp' : 'template.hwpx');
  } catch (error) {
    // 사용자에게는 같은 문구만 보이지만, 원인은 운영자가 볼 수 있게 남긴다
    console.warn('[doc-fill] 대체 목차 읽기 실패', error);
    throw new DocFillError(READ_FAIL);
  }
}

export async function fallbackOutline(
  bytes: Buffer,
  format: 'hwpx' | 'docx' | 'hwp'
): Promise<{ label: string; level: number }[]> {
  const text = await bodyText(bytes, format);
  const outline: { label: string; level: number }[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r\n?|\n/)) {
    const line = raw.trim();
    if (!line || seen.has(line)) continue;
    // 개조식 글머리(○●-–)는 본문 줄이다 — 목차에 넣으면 내용 줄마다 항목이 된다
    const level = numberedHeadingLevel(line);
    if (level === null) continue;
    seen.add(line);
    outline.push({ label: line, level });
  }
  return outline.length > 0 ? outline : [{ label: '본문', level: 2 }];
}

/** 기본 보고서 양식(builtin:report)의 표시. 여기 없는 표시는 양식에 있어도 건드리지 않는다 */
const REPORT_MARKERS = ['제목', '작성일', '작성부서', '개요', '추진 경과', '주요 내용', '향후 계획', '건의 사항'];

export async function fillFallback(
  reportTemplate: Buffer,
  title: string,
  outline: { label: string }[],
  values: Map<number, string>
): Promise<{ bytes: Buffer; filled: string[]; unfilled: string[] }> {
  const filled: string[] = [];
  const unfilled: string[] = [];
  const lines: string[] = [];
  outline.forEach((item, i) => {
    lines.push(item.label);
    const value = values.get(i);
    if (value !== undefined && value.trim() !== '') {
      lines.push(...value.replace(/\r\n?/g, '\n').split('\n'));
      filled.push(item.label);
    } else {
      unfilled.push(item.label);
    }
  });

  // 목차에 없는 표시는 빈 글로 채워 '{{…}}'가 남지 않게 한다(설계 7.1)
  const byLabel = new Map<string, string>(REPORT_MARKERS.map((m) => [m, '']));
  byLabel.set('제목', title);
  byLabel.set('주요 내용', lines.join('\n'));

  const out = await fillHwpx(reportTemplate, byLabel);
  // 양식에 표시가 없으면 내용이 조용히 사라진다 - 채운 것처럼 돌려주지 않고 실패시킨다
  if (!out.filled.includes('제목') || !out.filled.includes('주요 내용')) {
    throw new DocFillError('기본 보고서 양식에 {{제목}}·{{주요 내용}} 표시가 없어 채울 수 없습니다.');
  }
  return { bytes: out.bytes, filled, unfilled };
}
