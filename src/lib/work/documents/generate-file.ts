// src/lib/work/documents/generate-file.ts
import { createHash } from 'crypto';
import { fillTemplate, readTemplate, type Slot } from '@/lib/doc-fill';
import { WorkError, type DocumentField } from '../types';
import { fillValues } from './fields';
import { checkPackage, type PackageCheck } from './package-check';

/**
 * 원본 양식 + 필드 값 → 실제 HWPX(또는 DOCX) 바이트 (D1·D2, ADR 0001).
 * 기존 채우기 엔진(doc-fill)을 감싼다 — XML을 새로 짜 맞추지 않는다. DB·저장소를 모른다.
 *
 * 대체 경로(표준 보고서로 바꿔 만들기)는 여기서 하지 않는다 — 양식 그대로 채울 수 없으면 TEMPLATE_UNSUPPORTED로 멈추고,
 * 직원이 대체를 고르면 그 선택을 기록한 뒤 표준 양식으로 새 작업 판을 만든다(개편 02 문서 '문서 생성 우선순위' 3).
 */
export interface TemplateRead {
  format: 'hwpx' | 'docx';
  slots: Slot[];
}

export async function readFillableTemplate(bytes: Buffer, fileName: string): Promise<TemplateRead> {
  const read = await readTemplate(bytes, fileName);
  if (!read.ok) throw new WorkError('TEMPLATE_UNSUPPORTED', read.reason, 422);
  if (read.mode !== 'fill') {
    throw new WorkError('TEMPLATE_UNSUPPORTED', read.reason ?? '이 양식은 그대로 채울 수 없습니다.', 422, { fallback: true });
  }
  return { format: read.format, slots: read.slots };
}

export interface GeneratedFile {
  bytes: Buffer;
  format: 'hwpx' | 'docx';
  mimeType: string;
  sha256: string;
  check: PackageCheck;
}

export async function generateDocumentFile(templateBytes: Buffer, templateFileName: string, fields: DocumentField[]): Promise<GeneratedFile> {
  const read = await readFillableTemplate(templateBytes, templateFileName);
  // 양식의 자리와 필드가 같은 판인지 — 다른 양식 판의 필드로 채우지 않는다
  const slotIds = new Set(read.slots.map((s) => s.id));
  const strangers = fields.filter((f) => !slotIds.has(f.id));
  if (strangers.length || fields.length !== read.slots.length) {
    throw new WorkError('TEMPLATE_UNSUPPORTED', '문서 필드가 양식의 자리와 맞지 않습니다. 양식 판이 바뀌었을 수 있습니다.', 409);
  }
  const outcome = await fillTemplate(templateBytes, templateFileName, fillValues(fields));
  if (!outcome.ok) throw new WorkError('OUTPUT_INVALID', outcome.reason, 422);
  const check = await checkPackage(outcome.bytes, {
    format: outcome.extension,
    values: fields.map((f) => f.value).filter((v) => v.trim()),
  });
  if (!check.valid) {
    throw new WorkError(check.sizeBytes > 20 * 1024 * 1024 ? 'OUTPUT_TOO_LARGE' : 'OUTPUT_INVALID', `만든 파일이 검사를 통과하지 못했습니다: ${check.problems.slice(0, 3).join('; ')}`, 422, {
      problems: check.problems,
    });
  }
  return {
    bytes: outcome.bytes,
    format: outcome.extension,
    mimeType: outcome.mimeType,
    sha256: createHash('sha256').update(outcome.bytes).digest('hex'),
    check,
  };
}
