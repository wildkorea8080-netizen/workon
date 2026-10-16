import { readHwpxMarkers, fillHwpx } from './hwpx';
import { readHwpxAutoSlots, fillHwpxAutoSlots } from './hwpx-auto';
import { DocFillError } from './errors';

/**
 * 채우기 엔진 입구. 형식을 고르고, 자리에 번호를 붙이고, 상한을 건다.
 * DB·저장소를 모른다 — 바이트를 받아 바이트를 돌려준다(설계 2절).
 * 실패는 던지지 않고 { ok: false, reason }으로 돌려준다. 이유는 사용자에게 간다.
 */
export const MAX_SLOTS = 100;
export const MAX_SLOT_TEXT = 6000;
export const HWPX_MIME = 'application/hwp+zip';
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export type TemplateFormat = 'hwpx' | 'docx' | 'hwp' | 'unknown';

export interface Slot {
  id: string;
  label: string;
  kind: 'marker' | 'section' | 'cell';
  path: string[];
  hint: string | null;
}

export type ReadResult =
  | { ok: true; format: 'hwpx' | 'docx'; mode: 'fill' | 'fallback'; reason?: string; slots: Slot[] }
  | { ok: false; reason: string };

export type FillOutcome =
  | {
      ok: true;
      bytes: Buffer;
      mimeType: string;
      extension: 'hwpx' | 'docx';
      mode: 'fill' | 'fallback';
      filled: string[];
      unfilled: string[];
    }
  | { ok: false; reason: string };

export function detectFormat(fileName: string, bytes: Buffer): TemplateFormat {
  const ext = fileName.toLowerCase().split('.').pop();
  const isZip = bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  const isCfb = bytes.length > 7 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
  if (ext === 'hwpx' && isZip) return 'hwpx';
  if (ext === 'docx' && isZip) return 'docx';
  if (ext === 'hwp' && isCfb) return 'hwp';
  return 'unknown';
}

const UNSUPPORTED: Record<Exclude<TemplateFormat, 'hwpx'>, string> = {
  docx: 'Word(DOCX) 양식은 아직 채울 수 없습니다. 한글에서 HWPX로 저장해 올려 주세요.',
  hwp: '옛 한글(HWP) 형식은 직접 채울 수 없습니다. 한글에서 HWPX로 다시 저장해 올려 주세요.',
  unknown: '양식 파일 형식을 알 수 없습니다. 한글(HWPX) 파일을 올려 주세요.',
};

const NO_MARKERS =
  '이 양식에서 채울 자리를 찾지 못했습니다. 채울 자리에 {{항목 이름}}처럼 표시를 넣어 다시 올려 주세요.';

function tooManySlots(count: number): ReadResult {
  return { ok: false, reason: `채울 자리가 ${count}곳이라 상한(${MAX_SLOTS}곳)을 넘습니다.` };
}

/** 표시({{이름}})가 있으면 표시, 없으면 자동으로 찾은 자리. 둘 다 없으면 실패 */
async function readHwpxSlots(bytes: Buffer): Promise<ReadResult> {
  const labels = await readHwpxMarkers(bytes);
  if (labels.length > 0) {
    if (labels.length > MAX_SLOTS) return tooManySlots(labels.length);
    return {
      ok: true,
      format: 'hwpx',
      mode: 'fill',
      slots: labels.map((label, i) => ({ id: `s${i + 1}`, label, kind: 'marker' as const, path: [], hint: null })),
    };
  }
  const auto = await readHwpxAutoSlots(bytes);
  if (auto.length === 0) return { ok: false, reason: NO_MARKERS };
  if (auto.length > MAX_SLOTS) return tooManySlots(auto.length);
  return { ok: true, format: 'hwpx', mode: 'fill', slots: auto };
}

export async function readTemplate(bytes: Buffer, fileName: string): Promise<ReadResult> {
  const format = detectFormat(fileName, bytes);
  if (format !== 'hwpx') return { ok: false, reason: UNSUPPORTED[format] };
  try {
    return await readHwpxSlots(bytes);
  } catch (error) {
    if (error instanceof DocFillError) return { ok: false, reason: error.message };
    throw error;
  }
}

export async function fillTemplate(
  bytes: Buffer,
  fileName: string,
  values: { slot_id: string; text: string }[],
  // 대체 경로(Task 7)에서 쓴다. 지금은 받기만 한다
  _opts?: { title?: string; fallbackTemplate?: Buffer | null }
): Promise<FillOutcome> {
  const read = await readTemplate(bytes, fileName);
  if (!read.ok) return read;

  const labelById = new Map(read.slots.map((s) => [s.id, s.label]));
  const unknown = values.filter((v) => !labelById.has(v.slot_id)).map((v) => v.slot_id);
  if (unknown.length > 0) {
    return { ok: false, reason: `양식에 없는 자리 번호입니다: ${unknown.join(', ')}. read_template으로 자리를 다시 읽어 주세요.` };
  }
  const tooLong = values.filter((v) => v.text.length > MAX_SLOT_TEXT).map((v) => labelById.get(v.slot_id)!);
  if (tooLong.length > 0) {
    return { ok: false, reason: `한 자리에 ${MAX_SLOT_TEXT}자까지 넣을 수 있습니다. 넘은 자리: ${tooLong.join(', ')}` };
  }

  try {
    if (read.slots[0].kind === 'marker') {
      const result = await fillHwpx(bytes, new Map(values.map((v) => [labelById.get(v.slot_id)!, v.text])));
      return { ok: true, bytes: result.bytes, mimeType: HWPX_MIME, extension: 'hwpx', mode: read.mode, filled: result.filled, unfilled: result.unfilled };
    }
    const result = await fillHwpxAutoSlots(bytes, new Map(values.map((v) => [v.slot_id, v.text])));
    const names = (ids: string[]) => ids.map((id) => labelById.get(id) ?? id);
    return {
      ok: true,
      bytes: result.bytes,
      mimeType: HWPX_MIME,
      extension: 'hwpx',
      mode: read.mode,
      filled: names(result.filled),
      unfilled: names(result.unfilled),
    };
  } catch (error) {
    if (error instanceof DocFillError) return { ok: false, reason: error.message };
    throw error;
  }
}
