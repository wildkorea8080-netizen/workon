// src/lib/work/file-sets.ts
/**
 * 업무의 파일 입력(카탈로그 file-set 키) → 원자료 용도(work_sources.purpose). 화면(올릴 자료 고르기)과 서버(만들 준비 판정·
 * 실행기가 원자료를 가르는 기준)가 같은 표를 본다. 아무것도 import하지 않는다(화면도 읽음).
 * 표에 없는 키(sourceFiles·meetingSource 등)는 '기준 양식이 아닌 아무 원자료'다.
 */
export type SourcePurpose = 'reference' | 'data' | 'request' | 'template' | 'evidence';

export const FILE_SET_PURPOSE: Readonly<Record<string, SourcePurpose>> = {
  requestFiles: 'request',
  departmentMap: 'reference',
  baseForm: 'template',
  budgetFiles: 'data',
  evidenceFiles: 'evidence',
  rules: 'reference',
  priorResponses: 'reference',
};

/** 올릴 때 붙일 용도 — 표에 없으면 reference */
export function uploadPurposeOf(fileSetKey: string): SourcePurpose {
  return FILE_SET_PURPOSE[fileSetKey] ?? 'reference';
}

/** 이 파일 입력을 채운 원자료인가 */
export function satisfiesFileSet(fileSetKey: string, purpose: string): boolean {
  const want = FILE_SET_PURPOSE[fileSetKey];
  return want ? purpose === want : purpose !== 'template';
}
