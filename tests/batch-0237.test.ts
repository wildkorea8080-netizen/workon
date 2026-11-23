import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

/**
 * 2026-11-20 — 못 읽은 것을 '없음·다시 올려 주세요'로 답하던 세 곳.
 * ① 비서 설정 열기(`GET /api/agents/[id]`): 앞에서 있는 비서임을 확인한 뒤 행을 다시 읽다 실패하면 '비서를 찾을 수 없습니다'(404) —
 *    편집 창이 비서가 지워진 줄 알게 했다. 이제 503.
 * ② 대화 공유 상태(`GET /api/conversations/[id]/share`): 읽기 실패도 '대화를 찾을 수 없습니다'(404). 공유 시작(POST)은 이미 갈랐다 — 이제 503.
 * ③ 첨부 확인(`confirmUpload`): 저장소 내려받기 실패가 모두 '올린 파일을 찾지 못했습니다. 다시 올려 주세요'(400)라,
 *    잠깐의 저장소 장애에 직원이 같은 파일을 다시 올렸다(먼저 올린 것은 pending으로 남아 보내지 않은 첨부 상한 20개를 채운다).
 *    이제 없음이 확실할 때만 400(`isStorageNotFound`, 0218), 그 밖은 503.
 */

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

describe('비서 설정 열기 (원본)', () => {
  const src = read('src/app/api/agents/[id]/route.ts');
  const get = src.slice(src.indexOf('export async function GET'), src.indexOf('export async function', src.indexOf('export async function GET') + 10));
  it('행을 못 읽으면 503, 정말 없을 때만 404', () => {
    expect(get).toContain(".select('*').eq('id', params.id).maybeSingle();");
    expect(get).toContain("if (error) return jsonError('비서 설정을 지금 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 503);");
    expect(get).toContain("if (!data) return jsonError('비서를 찾을 수 없습니다.', 404);");
    expect(get).not.toContain('if (error || !data)');
  });
});

describe('대화 공유 상태 (원본)', () => {
  const src = read('src/app/api/conversations/[id]/share/route.ts');
  const get = src.slice(src.indexOf('export async function GET'));
  it('못 읽으면 503, 정말 없을 때만 404', () => {
    expect(get).toContain("if (error) return fail('대화를 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 503);");
    expect(get).toContain("if (!data) return fail('대화를 찾을 수 없습니다.', 404);");
    expect(get.slice(0, get.indexOf('export async function', 10) > 0 ? get.indexOf('export async function', 10) : undefined)).not.toContain('if (error || !data)');
  });
});

describe('첨부 확인 (원본)', () => {
  const src = read('src/lib/attachments/store.ts');
  const confirm = src.slice(src.indexOf('const { data: blob, error: downloadError } = await bucket().download(row.storage_path);'));
  it('저장소가 지금 못 준 것은 503 — 다시 올리라고 하지 않는다', () => {
    expect(src).toContain("import { isStorageNotFound } from '@/lib/storage-error';");
    const unavailable = confirm.indexOf('if (downloadError && !isStorageNotFound(downloadError)) {');
    const missing = confirm.indexOf("message: '올린 파일을 찾지 못했습니다. 다시 올려 주세요.'");
    expect(unavailable).toBeGreaterThan(-1);
    expect(unavailable).toBeLessThan(missing);
    expect(confirm.slice(unavailable, missing)).toContain("status: 503, message: '올린 파일을 지금 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.'");
  });
  it('못 받은 경우 행을 묘비로 만들지 않는다(다시 시도하면 확인된다)', () => {
    const unavailable = confirm.slice(confirm.indexOf('if (downloadError && !isStorageNotFound(downloadError)) {'), confirm.indexOf('if (downloadError || !blob) {'));
    expect(unavailable).not.toContain('discardPending');
    expect(unavailable).not.toContain('TOMBSTONE');
  });
});
