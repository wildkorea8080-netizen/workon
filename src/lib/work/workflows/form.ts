// src/lib/work/workflows/form.ts
import type { WorkflowDefinition, WorkflowInput } from '../catalog';
import { WorkError } from '../types';

/**
 * 작업 입력 폼 검사 — 카탈로그의 입력 정의(형식·필수)대로. 모든 업무가 같이 쓴다.
 * 파일 입력(file-set)은 폼 값이 아니라 원자료(work_sources)로 따로 센다.
 */
export const LIMITS = { string: 200, longText: 10_000, listItems: 50, listItem: 200, records: 50 } as const;

export type FormValues = Record<string, string | string[] | { name: string; note?: string }[]>;

export interface FormCheck {
  values: FormValues;
  /** 비었거나 빠진 필수 입력(파일 제외) */
  missing: WorkflowInput[];
}

function clean(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
}

export function checkForm(def: WorkflowDefinition, input: unknown): FormCheck {
  if (input !== undefined && (typeof input !== 'object' || input === null || Array.isArray(input))) {
    throw new WorkError('INVALID_INPUT', '입력 형식이 올바르지 않습니다.');
  }
  const raw = (input ?? {}) as Record<string, unknown>;
  const values: FormValues = {};
  const missing: WorkflowInput[] = [];
  const known = new Set(def.inputs.map((i) => i.key));
  for (const k of Object.keys(raw)) if (!known.has(k)) throw new WorkError('INVALID_INPUT', `알 수 없는 입력입니다: ${k.slice(0, 40)}`);

  for (const inp of def.inputs) {
    if (inp.type === 'file-set') continue;
    const v = raw[inp.key];
    const bad = (msg: string): never => {
      throw new WorkError('INVALID_INPUT', `${inp.label}: ${msg}`);
    };
    if (v === undefined || v === null || v === '') {
      if (inp.required) missing.push(inp);
      continue;
    }
    switch (inp.type) {
      case 'string':
      case 'template': {
        if (typeof v !== 'string') bad('글로 적어 주세요.');
        const s = clean(v as string).replace(/\n+/g, ' ');
        if (s.length > LIMITS.string) bad(`${LIMITS.string}자까지 적을 수 있습니다.`);
        if (s) values[inp.key] = s;
        else if (inp.required) missing.push(inp);
        break;
      }
      case 'long-text': {
        if (typeof v !== 'string') bad('글로 적어 주세요.');
        const s = clean(v as string);
        if (s.length > LIMITS.longText) bad(`${LIMITS.longText.toLocaleString()}자까지 적을 수 있습니다.`);
        if (s) values[inp.key] = s;
        else if (inp.required) missing.push(inp);
        break;
      }
      case 'date': {
        if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) bad('날짜(YYYY-MM-DD)로 적어 주세요.');
        values[inp.key] = v as string;
        break;
      }
      case 'enum': {
        if (typeof v !== 'string' || !inp.options?.includes(v)) bad(`다음 중에서 고르세요: ${inp.options?.join(', ')}`);
        values[inp.key] = v as string;
        break;
      }
      case 'string-list': {
        const arr = typeof v === 'string' ? v.split(/[\n,]/) : v;
        if (!Array.isArray(arr) || arr.some((x) => typeof x !== 'string')) bad('목록으로 적어 주세요.');
        const items = (arr as string[]).map((x) => clean(x).replace(/\n+/g, ' ')).filter(Boolean);
        if (items.length > LIMITS.listItems) bad(`${LIMITS.listItems}개까지 적을 수 있습니다.`);
        if (items.some((x) => x.length > LIMITS.listItem)) bad(`항목 하나는 ${LIMITS.listItem}자까지입니다.`);
        if (items.length) values[inp.key] = items;
        else if (inp.required) missing.push(inp);
        break;
      }
      case 'record-list': {
        if (!Array.isArray(v)) bad('목록으로 적어 주세요.');
        const recs = (v as unknown[]).map((r) => {
          const o = (typeof r === 'string' ? { name: r } : r) as { name?: unknown; note?: unknown };
          if (typeof o?.name !== 'string') bad('항목마다 이름이 있어야 합니다.');
          const name = clean(o.name as string).replace(/\n+/g, ' ').slice(0, LIMITS.listItem);
          const note = typeof o.note === 'string' ? clean(o.note).slice(0, LIMITS.listItem) : undefined;
          return note ? { name, note } : { name };
        }).filter((r) => r.name);
        if (recs.length > LIMITS.records) bad(`${LIMITS.records}개까지 적을 수 있습니다.`);
        if (recs.length) values[inp.key] = recs;
        else if (inp.required) missing.push(inp);
        break;
      }
    }
  }
  return { values, missing };
}

/** 모델·문서에 넘길 '직원이 확인한 사실' 목록 */
export function formFacts(def: WorkflowDefinition, values: FormValues): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  for (const inp of def.inputs) {
    const v = values[inp.key];
    if (v === undefined || inp.type === 'template') continue;
    if (Array.isArray(v)) {
      const text = v.map((x) => (typeof x === 'string' ? x : x.note ? `${x.name} (${x.note})` : x.name)).join('\n');
      if (text) out.push({ label: inp.label, value: text });
    } else if (v) out.push({ label: inp.label, value: v });
  }
  return out;
}
