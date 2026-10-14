// src/lib/template-files.ts
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_SIZE_LABEL } from '@/lib/file-types';

/** 기관 서식. 채우는 일은 S2가 한다 — 여기서는 받아 두는 규칙만. */
export const TEMPLATE_EXTENSIONS = ['hwp', 'hwpx', 'docx'] as const;
export const MAX_TEMPLATES = 10;

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

export function validateTemplateFile(name: string, size: number): string | null {
  if (!(TEMPLATE_EXTENSIONS as readonly string[]).includes(extensionOf(name))) {
    return '양식은 HWP·HWPX·DOCX 파일만 올릴 수 있습니다.';
  }
  if (size > MAX_UPLOAD_BYTES) return `양식 파일은 ${MAX_UPLOAD_SIZE_LABEL}까지 올릴 수 있습니다.`;
  return null;
}

/** 원래 파일명은 DB(file_name)에만 둔다. 경로에는 id와 확장자만. */
export function templateStoragePath(orgId: string, agentId: string, fileId: string, fileName: string): string {
  return `templates/${orgId}/${agentId}/${fileId}.${extensionOf(fileName)}`;
}
