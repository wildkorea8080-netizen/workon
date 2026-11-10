// src/lib/apps/batch-spec.ts
// 입력형 앱 일괄 실행(0077) — 규칙만(아무것도 import하지 않는다: 화면도 읽는다).
// 직원이 엑셀에서 복사해 붙인 표(탭 구분)나 CSV를 첫 줄 머리글(입력 항목 이름 또는 키)로 읽어 줄마다 입력값으로 만든다.

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
export const BATCH_FILES_UNSUPPORTED = '파일 첨부가 꼭 필요한 앱은 일괄 실행할 수 없습니다(줄마다 파일을 붙일 수 없습니다).';

export type BatchStatus = 'running' | 'done' | 'cancelled' | 'stopped';
export type BatchItemStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
export const BATCH_STATUS_LABELS: Record<BatchStatus, string> = { running: '실행 중', done: '마침', cancelled: '그만둠', stopped: '멈춤' };
export const BATCH_ITEM_STATUS_LABELS: Record<BatchItemStatus, string> = { pending: '기다림', running: '실행 중', done: '완료', failed: '실패', skipped: '건너뜀' };

export interface BatchView {
  id: string; agentId: string; agentName: string | null; name: string; status: BatchStatus; total: number;
  done: number; failed: number; skipped: number; pending: number; stopReason: string | null; createdAt: string; finishedAt: string | null;
}
export interface BatchItemView {
  position: number; status: BatchItemStatus; error: string | null; conversationId: string | null; inputs: Record<string, string>;
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
export function parseBatchTable(text: string, fields: Field[]): { ok: true; rows: Record<string, string>[] } | { ok: false; errors: string[] } {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, errors: ['붙인 표가 비었습니다. 첫 줄에 입력 항목 이름을 두고 아래에 한 줄씩 적어 주세요.'] };
  if (text.length > BATCH_TEXT_MAX) return { ok: false, errors: [`표가 너무 깁니다(${BATCH_TEXT_MAX.toLocaleString('ko-KR')}자까지).`] };
  const body = text.replace(/^﻿/, '');
  const firstLine = body.split(/\r?\n/, 1)[0] ?? '';
  const records = splitRecords(body, firstLine.includes('\t') ? '\t' : ',').filter((r) => r.some((c) => c.trim()));
  if (records.length < 2) return { ok: false, errors: ['머리글 아래에 실행할 줄이 없습니다.'] };
  const header = records[0];
  const errors: string[] = [];
  const keys: (string | null)[] = header.map((h, i) => {
    const name = norm(h);
    if (!name) return null;
    const field = fields.find((f) => norm(f.label) === name || norm(f.key) === name);
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
  if (errors.length) return { ok: false, errors: errors.slice(0, 10) };
  return { ok: true, rows };
}

/** 일괄 실행 이름 다듬기 — 비면 앱 이름 + 날짜를 화면이 정한다 */
export function normalizeBatchName(raw: unknown): string | null {
  const name = typeof raw === 'string' ? raw.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim() : '';
  return name && name.length <= BATCH_NAME_MAX ? name : null;
}
