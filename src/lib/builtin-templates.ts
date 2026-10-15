import { readFile } from 'fs/promises';
import path from 'path';

/**
 * WORKON에 들어 있는 표준 서식(설계 7.1). 표준 서식으로 만들기 = 이 양식에 채우기.
 *
 * 파일은 사용자가 한글로 만들어 assets/templates/에 둔다 — 한글이 저장한
 * HWPX라야 호환성이 확실하다. 파일이 없으면 null을 돌려주고, 능력은
 * "아직 준비되지 않았다"고 알린다. markers는 파일이 갖춰야 할 표시 목록이고
 * tests/builtin-templates.test.ts가 실제 파일과 맞춰 본다.
 */
export interface BuiltinTemplate {
  ref: string;
  name: string;
  file: string;
  markers: string[];
}

export const BUILTIN_TEMPLATES: readonly BuiltinTemplate[] = [
  {
    ref: 'builtin:official_letter',
    name: '공문 기안문 (표준 서식)',
    file: 'official_letter.hwpx',
    markers: ['행정기관명', '수신', '경유', '제목', '본문', '붙임', '발신명의', '공개구분'],
  },
  {
    ref: 'builtin:report',
    name: '일반 보고서 (표준 서식)',
    file: 'report.hwpx',
    markers: ['제목', '작성일', '작성부서', '개요', '추진 경과', '주요 내용', '향후 계획', '건의 사항'],
  },
  {
    ref: 'builtin:minutes',
    name: '회의록 (표준 서식)',
    file: 'minutes.hwpx',
    markers: ['회의명', '일시', '장소', '주관', '참석자', '안건', '논의 내용', '결정 사항', '향후 계획', '작성자'],
  },
];

export function findBuiltinTemplate(ref: string): BuiltinTemplate | null {
  return BUILTIN_TEMPLATES.find((t) => t.ref === ref) ?? null;
}

export const BUILTIN_TEMPLATE_DIR = path.join(process.cwd(), 'assets', 'templates');

export async function loadBuiltinTemplate(t: BuiltinTemplate, dir: string = BUILTIN_TEMPLATE_DIR): Promise<Buffer | null> {
  try {
    return await readFile(path.join(dir, t.file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
