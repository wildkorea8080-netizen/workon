// src/lib/work/workflows/items/verify.ts
import { normalizeDate } from '../regulations/evidence';

/**
 * 원자료에서 뽑은 항목(요청사항·결정·미결 과제…) — 공통 검사(순수 함수, DB·모델을 모름).
 *
 * 접수공문·회의·인수인계가 함께 쓴다. 지키는 것(카탈로그 validationRules):
 *  - 항목마다 원자료 **원문 인용**을 단다. 인용이 그 원자료에 없으면 '원문에서 확인 못함'으로 표시한다(버리지 않는다 — 직원이 본다)
 *  - 날짜(기한)·사람(담당·화자)은 **원자료에 적힌 것만**. 적혀 있지 않으면 비우고 '확인 필요' — 화자·담당·기한 추측 금지
 *  - '접수 후 7일 이내' 같은 상대 기한은 날짜로 바꾸지 않고 원문 그대로 둔 채 '확인 필요'
 *  - (인수인계) 비밀번호·계정 비밀은 지운다
 */
export type ColumnType = 'text' | 'date' | 'person' | 'enum';

export interface ColumnSpec {
  key: string;
  label: string;
  type: ColumnType;
  options?: readonly string[];
  /** 모델에게 주는 설명 */
  hint: string;
}

export interface ItemsSpec {
  /** 항목 묶음 이름(처리표·후속조치표…) */
  name: string;
  /** 첫 열 — 항목 구분(enum) */
  typeColumn: ColumnSpec & { type: 'enum'; options: readonly string[] };
  columns: readonly ColumnSpec[];
  /** 원자료 밖에서 뽑을 메타 값(장소·주관 등) — 원자료에 적힌 것만 */
  meta: readonly ColumnSpec[];
  /** 모델이 쓸 1~3문장 요약을 받는가(양식에 '개요' 칸이 있을 때) */
  wantsSummary: boolean;
  redactSecrets: boolean;
  /** 모델에게 주는 업무별 규칙 */
  rules: readonly string[];
}

export type ItemFlag = 'quote_not_found' | 'date_unverified' | 'relative_deadline' | 'person_unverified' | 'secret_removed' | 'source_unknown';

export interface RawItem {
  type: string;
  values: Record<string, string>;
  sourceId: string;
  quote: string;
}

export interface ExtractedItem {
  /** 'I1'… */
  id: string;
  type: string;
  values: Record<string, string>;
  sourceId: string | null;
  sourceName: string | null;
  quote: string;
  flags: ItemFlag[];
  /** 지운·비운 값의 원래 글(직원 확인용 — 비밀값은 남기지 않는다) */
  notes: string[];
}

export interface VerifySource {
  id: string;
  name: string;
  text: string;
}

export const MAX_ITEMS = 80;
const MAX_VALUE = 500;
const MAX_QUOTE = 300;

/** 비교용 — 공백·줄바꿈을 지운다(원문 줄바꿈이 달라도 같은 글로 본다) */
export function squash(s: string): string {
  return s.replace(/[\s ​﻿]+/g, '');
}

/** 날짜 값이 원문에 적힌 꼴 중 하나로 있는가 — 2026-10-30 ↔ '2026. 10. 30.'·'10. 30.'·'10월 30일' */
export function dateAppearsIn(iso: string, text: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return false;
  const [y, mo, d] = [m[1], String(Number(m[2])), String(Number(m[3]))];
  const hay = squash(text);
  const variants = [
    `${y}-${m[2]}-${m[3]}`,
    `${y}.${mo}.${d}`,
    `${y}.${m[2]}.${m[3]}`,
    `${y}년${mo}월${d}일`,
    `${y}/${mo}/${d}`,
    `${y}${m[2]}${m[3]}`,
    `${mo}월${d}일`,
  ];
  if (variants.some((v) => hay.includes(v))) return true;
  // 해를 줄인 '11. 10.' — 앞이 숫자·점이 아닐 때만(2025.11.10. 같은 다른 해의 날짜 꼬리와 헷갈리지 않게)
  return new RegExp(`(^|[^0-9.])${mo}\\.${d}\\.`).test(hay);
}

const RELATIVE = /(이내|후|부터|전까지|즉시|지체\s*없이|경과|익월|다음\s*달|매월|매주|매년|분기\s*말)/;

/** 비밀번호·계정 비밀 — '비밀번호: abc', 'PW=1234', 'ID/PW : a / b' 의 값 부분 */
const SECRET = /((?:비밀\s*번호|패스\s*워드|암호|password|passwd|pwd|pw|비번|접속\s*키|api\s*key|토큰|token)\s*[:=：]\s*)(\S+)/gi;
const IDPW = /((?:ID\s*\/\s*PW|아이디\s*\/\s*비밀번호)\s*[:=：]?\s*)([^\n]+)/gi;

export function redactSecrets(s: string): { text: string; removed: boolean } {
  let removed = false;
  const text = s
    .replace(IDPW, (_m, head: string) => {
      removed = true;
      return `${head}[삭제됨]`;
    })
    .replace(SECRET, (_m, head: string) => {
      removed = true;
      return `${head}[삭제됨]`;
    });
  return { text, removed };
}

function clean(v: unknown, max: number): string {
  return typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max) : '';
}

/**
 * 모델이 뽑은 항목 → 검사한 항목. 순서는 모델 순서, 번호는 I1부터.
 * 날짜는 'YYYY-MM-DD'로 맞춘 뒤 원문에 그 날짜가 있어야 남는다. 사람 값은 원문에 그 글이 있어야 남는다
 */
export function verifyItems(raw: RawItem[], sources: VerifySource[], spec: ItemsSpec): ExtractedItem[] {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const allText = sources.map((s) => s.text).join('\n');
  const out: ExtractedItem[] = [];
  for (const r of raw.slice(0, MAX_ITEMS)) {
    const flags = new Set<ItemFlag>();
    const notes: string[] = [];
    const src = byId.get(r.sourceId) ?? null;
    if (!src) flags.add('source_unknown');
    let quote = clean(r.quote, MAX_QUOTE);
    const type = spec.typeColumn.options.includes(r.type) ? r.type : spec.typeColumn.options[spec.typeColumn.options.length - 1];
    if (!quote || !src || !squash(src.text).includes(squash(quote))) flags.add('quote_not_found');
    const ground = src ? src.text : allText;
    const values: Record<string, string> = {};
    for (const c of spec.columns) {
      let v = clean(r.values?.[c.key], MAX_VALUE);
      if (!v) {
        values[c.key] = '';
        continue;
      }
      if (c.type === 'date') {
        const iso = normalizeDate(v);
        if (!iso) {
          if (RELATIVE.test(v)) {
            flags.add('relative_deadline');
            notes.push(`${c.label}: '${v}' — 날짜로 바꾸지 않음(상대 기한)`);
          } else {
            flags.add('date_unverified');
            notes.push(`${c.label}: '${v}' — 날짜로 읽지 못함`);
          }
          values[`${c.key}Text`] = v;
          v = '';
        } else if (!dateAppearsIn(iso, ground)) {
          flags.add('date_unverified');
          notes.push(`${c.label}: '${v}' — 원자료에서 찾지 못해 비움`);
          v = '';
        } else v = iso;
      } else if (c.type === 'person') {
        if (!squash(ground).includes(squash(v))) {
          flags.add('person_unverified');
          notes.push(`${c.label}: '${v}' — 원자료에 없어 비움`);
          v = '';
        }
      } else if (c.type === 'enum' && c.options && !c.options.includes(v)) {
        v = '';
      }
      values[c.key] = v;
    }
    if (spec.redactSecrets) {
      for (const k of Object.keys(values)) {
        const r2 = redactSecrets(values[k]);
        if (r2.removed) {
          values[k] = r2.text;
          flags.add('secret_removed');
        }
      }
      const q = redactSecrets(quote);
      if (q.removed) {
        quote = q.text;
        flags.add('secret_removed');
      }
    }
    out.push({ id: `I${out.length + 1}`, type, values, sourceId: src?.id ?? null, sourceName: src?.name ?? null, quote, flags: [...flags], notes });
  }
  return out;
}

/** 메타 값(장소·주관…) — 원자료에 적힌 것만. 날짜는 위 규칙과 같다 */
export function verifyMeta(raw: Record<string, unknown>, sources: VerifySource[], spec: ItemsSpec): { values: Record<string, string>; notes: string[] } {
  const all = sources.map((s) => s.text).join('\n');
  const values: Record<string, string> = {};
  const notes: string[] = [];
  for (const c of spec.meta) {
    let v = clean(raw?.[c.key], 200);
    if (v && c.type === 'date') {
      const iso = normalizeDate(v);
      v = iso && dateAppearsIn(iso, all) ? iso : '';
    } else if (v && !squash(all).includes(squash(v))) {
      notes.push(`${c.label}: '${v}' — 원자료에 없어 비움`);
      v = '';
    }
    if (spec.redactSecrets && v) v = redactSecrets(v).text;
    values[c.key] = v;
  }
  return { values, notes };
}

export const FLAG_LABEL: Record<ItemFlag, string> = {
  quote_not_found: '원문에서 확인 못함',
  date_unverified: '날짜 확인 필요',
  relative_deadline: '상대 기한 — 날짜 확인 필요',
  person_unverified: '담당·화자 확인 필요',
  secret_removed: '비밀값 지움',
  source_unknown: '출처 불명',
};
