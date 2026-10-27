// src/lib/work/documents/fields.ts
import type { Slot } from '@/lib/doc-fill';
import { MAX_SLOT_TEXT } from '@/lib/doc-fill';
import { WorkError, type DocumentField } from '../types';

/**
 * 문서 내용 모델 — 양식 자리(slot)마다 필드 하나. DB·저장소·모델을 모르는 순수 함수.
 *
 * 필드 id는 양식 판(sha256) 안의 자리 번호(s1…)다. 다른 양식 판과는 번호로 맞추지 않는다(개편 04 문서 3절).
 * 파일은 언제나 **원본 양식 + 그 판의 필드 값**으로 새로 만든다 — 앞서 만든 파일에 덧대지 않는다(누적 손상 방지).
 */

/** 여러 문단이 들어가는 자리로 보는 이름(그 밖은 한 줄 글) */
const PARAGRAPH_LABELS = /본문|내용|개요|경과|계획|사항|안건|결정|논의|검토|의견|요지|배경|현황|목적|붙임/;

export function fieldsFromSlots(slots: Slot[], requiredLabels: readonly string[] = []): DocumentField[] {
  return slots.map((s) => ({
    id: s.id,
    label: s.label,
    kind: s.kind,
    type: s.kind === 'section' || PARAGRAPH_LABELS.test(s.label) ? 'paragraph' : 'text',
    value: '',
    required: requiredLabels.includes(s.label),
    locked: false,
    origin: 'empty',
    evidenceIds: [],
    hint: s.hint,
  }));
}

/** 넣을 수 없는 글자(제어 문자 — 줄바꿈·탭 제외)를 빼고 줄바꿈을 맞춘다 */
export function cleanFieldValue(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t]+$/gm, '');
}

export type FieldPatch =
  | { fieldId: string; operation: 'set_value'; value: string }
  | { fieldId: string; operation: 'set_lock'; value: boolean };

export function parsePatches(input: unknown): FieldPatch[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 100) {
    throw new WorkError('INVALID_INPUT', '바꿀 내용(patches)이 없거나 너무 많습니다.');
  }
  return input.map((p) => {
    const o = p as Record<string, unknown>;
    if (typeof o?.fieldId !== 'string' || !/^s\d{1,3}$/.test(o.fieldId)) throw new WorkError('INVALID_INPUT', '필드 번호가 올바르지 않습니다.');
    if (o.operation === 'set_value' && typeof o.value === 'string') return { fieldId: o.fieldId, operation: 'set_value', value: o.value };
    if (o.operation === 'set_lock' && typeof o.value === 'boolean') return { fieldId: o.fieldId, operation: 'set_lock', value: o.value };
    throw new WorkError('INVALID_INPUT', '바꿀 내용의 형식이 올바르지 않습니다.');
  });
}

/**
 * 직원의 직접 수정. 잠금은 **AI 재생성·수정 후보**를 막는 것이라 직원 자신의 직접 수정은 막지 않는다.
 * 바뀐 것이 없으면 null(새 판을 만들지 않는다).
 */
export function applyPatches(fields: DocumentField[], patches: FieldPatch[]): { fields: DocumentField[]; changed: string[] } | null {
  const byId = new Map(fields.map((f) => [f.id, { ...f }]));
  const changed = new Set<string>();
  for (const p of patches) {
    const f = byId.get(p.fieldId);
    if (!f) throw new WorkError('INVALID_INPUT', `문서에 없는 필드입니다: ${p.fieldId}`);
    if (p.operation === 'set_lock') {
      if (f.locked !== p.value) {
        f.locked = p.value;
        changed.add(f.id);
      }
      continue;
    }
    const value = cleanFieldValue(p.value);
    if (value.length > MAX_SLOT_TEXT) throw new WorkError('INVALID_INPUT', `한 칸에 ${MAX_SLOT_TEXT.toLocaleString()}자까지 넣을 수 있습니다(${f.label}).`);
    if (f.type === 'text' && value.includes('\n')) throw new WorkError('INVALID_INPUT', `'${f.label}'은 한 줄로 적어 주세요.`);
    if (value !== f.value) {
      f.value = value;
      f.origin = 'user';
      changed.add(f.id);
    }
  }
  if (changed.size === 0) return null;
  return { fields: fields.map((f) => byId.get(f.id)!), changed: [...changed] };
}

/**
 * 생성·재생성 결과를 합친다. 잠긴 필드와 직원이 고친 필드는 그대로 둔다(개편 04 문서 6절 — 직접 수정·잠금·다른 영역 보존).
 * onlyIds가 있으면 그 필드만 바꾼다(선택 영역 수정).
 */
export function mergeGenerated(
  fields: DocumentField[],
  generated: Record<string, { value: string; evidenceIds?: string[] }>,
  opts: { origin: DocumentField['origin']; onlyIds?: string[]; keepUserEdits?: boolean } = { origin: 'ai' }
): { fields: DocumentField[]; changed: string[]; skippedLocked: string[] } {
  const changed: string[] = [];
  const skippedLocked: string[] = [];
  const keepUser = opts.keepUserEdits ?? true;
  const out = fields.map((f) => {
    const g = generated[f.id];
    if (!g) return f;
    if (opts.onlyIds && !opts.onlyIds.includes(f.id)) return f;
    if (f.locked) {
      skippedLocked.push(f.id);
      return f;
    }
    if (keepUser && f.origin === 'user' && !opts.onlyIds) return f;
    let value = cleanFieldValue(g.value).slice(0, MAX_SLOT_TEXT);
    if (f.type === 'text') value = value.replace(/\s*\n\s*/g, ' ').trim();
    if (value === f.value) return f;
    changed.push(f.id);
    return { ...f, value, origin: opts.origin, evidenceIds: g.evidenceIds ?? f.evidenceIds };
  });
  return { fields: out, changed, skippedLocked };
}

/** 파일 만들기 입력 — 빈 칸은 빈 글로 채워 {{표시}}가 남지 않게 한다 */
export function fillValues(fields: DocumentField[]): { slot_id: string; text: string }[] {
  return fields.map((f) => ({ slot_id: f.id, text: f.value }));
}

/** DB의 jsonb를 믿지 않고 꼴을 다시 맞춘다 */
export function normalizeStoredFields(input: unknown): DocumentField[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((f): f is Record<string, unknown> => Boolean(f) && typeof f === 'object' && typeof (f as { id?: unknown }).id === 'string')
    .map((f) => ({
      id: String(f.id),
      label: typeof f.label === 'string' ? f.label : String(f.id),
      kind: f.kind === 'section' || f.kind === 'cell' ? f.kind : 'marker',
      type: f.type === 'paragraph' ? 'paragraph' : 'text',
      value: typeof f.value === 'string' ? f.value : '',
      required: f.required === true,
      locked: f.locked === true,
      origin: (['empty', 'form', 'ai', 'user', 'restore'] as const).includes(f.origin as never) ? (f.origin as DocumentField['origin']) : 'empty',
      evidenceIds: Array.isArray(f.evidenceIds) ? f.evidenceIds.filter((x): x is string => typeof x === 'string') : [],
      hint: typeof f.hint === 'string' ? f.hint : null,
    }));
}
