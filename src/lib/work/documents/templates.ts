// src/lib/work/documents/templates.ts
import { createHash } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { BUILTIN_TEMPLATES, BUILTIN_TEMPLATE_DIR, findBuiltinTemplate, loadBuiltinTemplate } from '@/lib/builtin-templates';
import { WorkError } from '../types';
import type { WorkStore, TemplateVersionRow } from '../store/types';
import type { WorkFiles } from '../files';
import { readFillableTemplate } from './generate-file';

/**
 * 양식 판 — 표준 양식(저장소 assets/templates)과 기관 양식(저장소 버킷)을 같은 행 꼴로 다룬다.
 *
 * 등급(개편 04 문서 2절): draft(올리기만) → mapped(자리 대응·시험 생성 가능) → verified(지정 환경 실제 검증) / retired.
 * 표준 양식의 등급은 assets/templates/verification.json에서 그 파일(sha256)의 기록으로 정한다:
 *   사람의 시각 검토 통과 → verified, 한글 자동 검증만 통과 → mapped, 기록 없음 → draft.
 * 관리자 클릭 한 번으로 '한글 검증'을 기록하지 않는다.
 */
export const DOCUMENT_SUPPORT = {
  text: true,
  paragraphs: true,
  existingCells: true,
  repeatRows: false,
  imageInsert: false,
  exactPreview: false,
} as const;

interface VerificationRecord {
  file: string;
  sha256: string;
  kind: 'hancom-automation' | 'human-visual';
  result: 'passed' | 'failed';
  application?: string;
  checkedAt?: string;
  reviewer?: string;
}

function verificationRecords(dir = BUILTIN_TEMPLATE_DIR): VerificationRecord[] {
  const p = path.join(dir, 'verification.json');
  if (!existsSync(p)) return [];
  try {
    return (JSON.parse(readFileSync(p, 'utf8')).records ?? []) as VerificationRecord[];
  } catch {
    return [];
  }
}

export function builtinStatus(file: string, sha256: string, records = verificationRecords()): { status: TemplateVersionRow['status']; verification: Record<string, unknown> | null } {
  const mine = records.filter((r) => r.file === file && r.sha256 === sha256 && r.result === 'passed');
  const human = mine.find((r) => r.kind === 'human-visual');
  const auto = mine.find((r) => r.kind === 'hancom-automation');
  const verification = auto || human ? { automation: auto ?? null, humanVisual: human ?? null } : null;
  if (human && auto) return { status: 'verified', verification };
  if (auto) return { status: 'mapped', verification };
  return { status: 'draft', verification: null };
}

/** 표준 양식의 지금 파일로 판 행을 찾거나 만든다. 파일이 없으면 TEMPLATE_MISSING */
export async function ensureBuiltinTemplateVersion(store: WorkStore, ref: string): Promise<TemplateVersionRow> {
  const t = findBuiltinTemplate(ref);
  if (!t) throw new WorkError('TEMPLATE_MISSING', '알 수 없는 표준 양식입니다.', 404);
  const bytes = await loadBuiltinTemplate(t);
  if (!bytes) throw new WorkError('TEMPLATE_MISSING', `표준 양식 파일(${t.name})이 서버에 없습니다. 관리자에게 알려 주세요.`, 503);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const existing = await store.findBuiltinTemplate(ref, sha256);
  if (existing) return existing;
  const read = await readFillableTemplate(bytes, t.file);
  const { status, verification } = builtinStatus(t.file, sha256);
  return store.insertTemplateVersion({
    organization_id: null,
    source: 'builtin',
    builtin_ref: ref,
    agent_template_id: null,
    storage_path: null,
    name: t.name,
    file_name: t.file,
    format: read.format,
    sha256,
    version: 1,
    status,
    manifest: { slots: read.slots.map((s) => ({ id: s.id, label: s.label, kind: s.kind, hint: s.hint })) },
    supported: { ...DOCUMENT_SUPPORT },
    verification,
  });
}

/** 판의 원본 바이트. 해시가 판과 다르면(파일이 바뀜) 쓰지 않는다 — 다른 양식으로 채우지 않게 */
export async function loadTemplateBytes(files: WorkFiles, tv: TemplateVersionRow): Promise<Buffer> {
  let bytes: Buffer | null = null;
  if (tv.source === 'builtin') {
    const t = BUILTIN_TEMPLATES.find((b) => b.ref === tv.builtin_ref);
    bytes = t ? await loadBuiltinTemplate(t) : null;
  } else if (tv.storage_path) {
    bytes = await files.get(tv.storage_path);
  }
  if (!bytes) throw new WorkError('TEMPLATE_MISSING', `양식 파일(${tv.name})을 불러오지 못했습니다.`, 503);
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== tv.sha256) {
    throw new WorkError('TEMPLATE_MISSING', `양식 파일(${tv.name})이 이 작업을 만든 판과 다릅니다. 새 판으로 작업을 다시 시작해 주세요.`, 409);
  }
  return bytes;
}

export function templateLabel(tv: Pick<TemplateVersionRow, 'status'>): string {
  return tv.status === 'verified' ? '한글 검증 완료' : tv.status === 'mapped' ? '한글 자동 검증 통과 · 시각 검토 전' : tv.status === 'draft' ? '검증 전' : '사용 중지';
}
