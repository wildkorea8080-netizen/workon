// src/lib/apps/batch-spec.ts
// 입력형 앱 일괄 실행(0077) — 규칙만(핵심어 규칙 잎 파일 keyword-match.ts 말고는 아무것도 import하지 않는다: 화면도 읽는다).
// 직원이 엑셀에서 복사해 붙인 표(탭 구분)나 CSV를 첫 줄 머리글(입력 항목 이름 또는 키)로 읽어 줄마다 입력값으로 만든다.
// 머리글에 '기대 핵심어' 칸을 두면(0088) 그 줄의 결과에 그 핵심어가 모두 들어 있는지 실행기가 본다 — 앱 답변을 여러 건 한 번에 재는 길.

import { missingKeywords } from '@/lib/keyword-match';

export const BATCH_MAX_ROWS = 100;
/** 한 직원이 동시에 돌릴 수 있는 일괄 실행 수 */
export const BATCH_MAX_RUNNING = 3;
export const BATCH_NAME_MAX = 80;
export const BATCH_TEXT_MAX = 400_000;
/** 줄 하나가 모델 오류로 실패하면 다시 해 볼 횟수(첫 시도 포함) */
export const BATCH_MAX_ATTEMPTS = 2;
/** `running`으로 이만큼 지나면 실행기가 끊긴 것으로 보고 다시 차지한다 */
export const BATCH_STALE_MS = 15 * 60_000;
export const BATCH_TITLE_PREFIX = '[일괄] ';
/** 연동이 박아 둔 앱 판과 지금 판이 다를 때(비동기 연동 0087) — 기다리는 연동의 409와 같은 뜻 */
export const BATCH_APP_VERSION_CHANGED = '앱 설정이 바뀌어 이 연동으로는 실행할 수 없습니다.';
export const BATCH_FILES_UNSUPPORTED = "파일 첨부가 꼭 필요한 앱은 '파일마다 한 건'으로 일괄 실행해 주세요.";
/** 파일마다 한 건(2026-11-10) — 한 번에 올릴 파일 수. 직원의 '보내지 않은 첨부' 상한(20)을 실행 때 다시 붙일 몫까지 남기려고 10 */
export const BATCH_MAX_FILES = 10;
export const BATCH_FILE_PREFIX = 'app-batch-files';
export const BATCH_FILES_NOT_ALLOWED = '파일을 받지 않는 앱입니다. 앱 설정에서 파일 첨부를 켠 앱만 파일마다 실행할 수 있습니다.';
export const BATCH_FILE_ROWS_MISMATCH = '파일마다 실행할 때 표는 한 줄(모든 파일에 같은 입력)이거나 파일 수와 같은 줄 수(올린 순서대로 짝)여야 합니다.';

/** 기대 핵심어(0088) — 이 머리글(공백·대소문자 무시) 칸은 입력 항목이 아니라 그 줄의 결과를 재는 핵심어다. 앱 입력 항목 이름과 같으면 입력 항목이 먼저 */
export const BATCH_EXPECT_HEADERS = ['기대 핵심어', '기대 답', '핵심어', 'expect'];
/** 한 줄의 기대 핵심어 글 상한·핵심어 수 상한 */
export const BATCH_EXPECT_MAX = 500;
export const BATCH_EXPECT_MAX_KEYWORDS = 20;

/** 기대 핵심어 글 → 핵심어(쉼표·세미콜론·가운뎃점·줄바꿈으로 나눔, 다듬고 같은 것·빈 것 빼고 20개) */
export function splitExpectKeywords(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const raw of text.split(/[,;·\n\r]+/)) {
    const k = raw.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
    if (k && !out.includes(k)) out.push(k);
    if (out.length >= BATCH_EXPECT_MAX_KEYWORDS) break;
  }
  return out;
}

/** 기대 핵심어 다듬기 — 비면 null, 너무 길면 'too_long' */
export function normalizeExpect(raw: unknown): string | null | 'too_long' {
  if (typeof raw !== 'string') return null;
  const text = splitExpectKeywords(raw).join(', ');
  if (!text) return null;
  return text.length > BATCH_EXPECT_MAX ? 'too_long' : text;
}

/** 결과 글에 없는 기대 핵심어 — 실행기가 줄을 마칠 때 한 번 재 `expect_missing`에 둔다 */
export function expectMissing(result: string, expect: string): string[] {
  return missingKeywords(result, splitExpectKeywords(expect));
}

/** 줄 하나의 핵심어 판정 꼴 — 화면·엑셀 */
export function expectVerdict(expect: string | null | undefined, missing: string[] | null | undefined): string {
  if (!expect) return '';
  if (!missing) return '재지 않음';
  return missing.length ? `빠짐: ${missing.join(', ')}` : '맞음';
}

/** 줄이 가진 파일 사본 하나 — `path`는 화면으로 내보내지 않는다 */
export type BatchFile = { id: string; name: string; size: number; path: string };

export function batchFilePath(organizationId: string, userId: string, fileId: string, ext: string): string {
  return `${BATCH_FILE_PREFIX}/${organizationId}/${userId}/${fileId}.${ext}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** DB 칸 → 파일 사본(꼴이 틀리거나 일괄 실행 접두사 밖이면 null) */
export function batchFileOf(raw: unknown): BatchFile | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { id, name, size, path } = raw as Record<string, unknown>;
  if (typeof id !== 'string' || !UUID_RE.test(id) || typeof name !== 'string' || !name || typeof size !== 'number' || !Number.isFinite(size)
    || typeof path !== 'string' || !path.startsWith(`${BATCH_FILE_PREFIX}/`) || path.includes('..')) return null;
  return { id: id.toLowerCase(), name, size, path };
}

/** 요청의 첨부 id 목록 — 없으면 빈 목록, 꼴이 틀리거나 상한을 넘으면 null. 겹친 id는 한 번(올린 순서 유지) */
export function parseBatchAttachmentIds(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > BATCH_MAX_FILES || raw.some((v) => typeof v !== 'string' || !UUID_RE.test(v))) return null;
  return [...new Set((raw as string[]).map((v) => v.toLowerCase()))];
}

/** 파일마다 한 건 — 줄 하나면 모든 파일에, 파일 수와 같으면 순서대로 짝. 아니면 null */
export function pairRowsWithFiles<R>(rows: R[], fileCount: number): R[] | null {
  if (fileCount < 1) return null;
  if (rows.length === 1) return Array.from({ length: fileCount }, () => rows[0]);
  return rows.length === fileCount ? rows : null;
}

export type BatchStatus = 'running' | 'done' | 'cancelled' | 'stopped';
export type BatchItemStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
export const BATCH_STATUS_LABELS: Record<BatchStatus, string> = { running: '실행 중', done: '마침', cancelled: '그만둠', stopped: '멈춤' };
export const BATCH_ITEM_STATUS_LABELS: Record<BatchItemStatus, string> = { pending: '기다림', running: '실행 중', done: '완료', failed: '실패', skipped: '건너뜀' };

export interface BatchView {
  id: string; agentId: string; agentName: string | null; name: string; status: BatchStatus; total: number;
  done: number; failed: number; skipped: number; pending: number; stopReason: string | null; createdAt: string; finishedAt: string | null;
  /** 기대 핵심어를 잰 줄 수 / 그중 모두 들어 있던 줄 수(0088) — 기대 핵심어가 없는 묶음은 0·0 */
  expectChecked?: number; expectPassed?: number;
}
export interface BatchItemView {
  position: number; status: BatchItemStatus; error: string | null; conversationId: string | null; inputs: Record<string, string>;
  /** 파일마다 한 건이면 그 줄의 파일 이름 */
  fileName?: string | null;
  /** 기대 핵심어(0088)와 결과에 없던 핵심어(재지 않았으면 null) */
  expect?: string | null; expectMissing?: string[] | null;
}

type Field = { key: string; label: string };

/** 한 줄을 칸으로 — 큰따옴표로 감싼 칸(안의 구분자·"" 이스케이프) 지원. 여러 줄 칸은 표 전체 읽기(`splitRecords`)가 맡는다 */
function splitRecords(text: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let row: string[] = []; let cell = ''; let quoted = false; let i = 0;
  const pushCell = () => { row.push(cell); cell = ''; };
  const pushRow = () => { pushCell(); records.push(row); row = []; };
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 2; continue; }
      if (ch === '"') { quoted = false; i++; continue; }
      cell += ch; i++; continue;
    }
    if (ch === '"' && cell === '') { quoted = true; i++; continue; }
    if (ch === delimiter) { pushCell(); i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { pushRow(); i++; continue; }
    cell += ch; i++;
  }
  if (cell !== '' || row.length) pushRow();
  return records;
}

const norm = (s: string) => s.normalize('NFC').replace(/[\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('ko');

/**
 * 붙인 표·CSV → 줄마다 입력값(항목 키 → 글). 첫 줄은 머리글 — 입력 항목의 이름이나 키(대소문자·공백 무시). 모르는 머리글·같은 항목 두 번은 오류.
 * 빈 줄은 건너뛴다. 머리글에 없는 항목은 그 줄에서 비워 둔다(필수인지는 서버가 앱 규칙으로 다시 본다). 구분자는 첫 줄에 탭이 있으면 탭, 아니면 쉼표
 */
export function parseBatchTable(text: string, fields: Field[]): { ok: true; rows: Record<string, string>[]; expects: string[] } | { ok: false; errors: string[] } {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, errors: ['붙인 표가 비었습니다. 첫 줄에 입력 항목 이름을 두고 아래에 한 줄씩 적어 주세요.'] };
  if (text.length > BATCH_TEXT_MAX) return { ok: false, errors: [`표가 너무 깁니다(${BATCH_TEXT_MAX.toLocaleString('ko-KR')}자까지).`] };
  const body = text.replace(/^﻿/, '');
  const firstLine = body.split(/\r?\n/, 1)[0] ?? '';
  const records = splitRecords(body, firstLine.includes('\t') ? '\t' : ',').filter((r) => r.some((c) => c.trim()));
  if (records.length < 2) return { ok: false, errors: ['머리글 아래에 실행할 줄이 없습니다.'] };
  const header = records[0];
  const errors: string[] = [];
  let expectCol = -1;
  const keys: (string | null)[] = header.map((h, i) => {
    const name = norm(h);
    if (!name) return null;
    const field = fields.find((f) => norm(f.label) === name || norm(f.key) === name);
    if (!field && BATCH_EXPECT_HEADERS.some((e) => norm(e) === name)) {
      if (expectCol >= 0) errors.push('기대 핵심어 칸이 머리글에 두 번 있습니다.');
      expectCol = i;
      return null;
    }
    if (!field) { errors.push(`머리글 ${i + 1}번째 칸 '${h.trim().slice(0, 40)}'은(는) 이 앱의 입력 항목이 아닙니다. 입력 항목 이름(${fields.map((f) => f.label).join(', ')})을 쓰세요.`); return null; }
    return field.key;
  });
  const used = keys.filter((k): k is string => Boolean(k));
  for (const k of new Set(used)) if (used.filter((x) => x === k).length > 1) errors.push(`'${fields.find((f) => f.key === k)?.label ?? k}' 항목이 머리글에 두 번 있습니다.`);
  if (!used.length && !errors.length) errors.push('머리글에서 이 앱의 입력 항목을 찾지 못했습니다.');
  const lines = records.slice(1);
  if (lines.length > BATCH_MAX_ROWS) errors.push(`한 번에 ${BATCH_MAX_ROWS}줄까지 실행합니다(지금 ${lines.length}줄).`);
  if (errors.length) return { ok: false, errors };
  const rows = lines.map((cells, r) => {
    if (cells.length > header.length && cells.slice(header.length).some((c) => c.trim())) errors.push(`${r + 2}번째 줄: 머리글보다 칸이 많습니다.`);
    const row: Record<string, string> = {};
    keys.forEach((k, i) => { if (k) row[k] = (cells[i] ?? '').trim(); });
    return row;
  });
  const expects = lines.map((cells, r) => {
    const e = expectCol >= 0 ? normalizeExpect(cells[expectCol] ?? '') : null;
    if (e === 'too_long') { errors.push(`${r + 2}번째 줄: 기대 핵심어는 ${BATCH_EXPECT_MAX}자까지입니다.`); return ''; }
    return e ?? '';
  });
  if (errors.length) return { ok: false, errors: errors.slice(0, 10) };
  return { ok: true, rows, expects };
}

/** 일괄 실행 이름 다듬기 — 비면 앱 이름 + 날짜를 화면이 정한다 */
export function normalizeBatchName(raw: unknown): string | null {
  const name = typeof raw === 'string' ? raw.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim() : '';
  return name && name.length <= BATCH_NAME_MAX ? name : null;
}
