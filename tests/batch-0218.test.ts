import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isStorageNotFound } from '@/lib/storage-error';

/**
 * 2026-11-20 — 저장소에서 원본을 '지금 못 받은 것'과 '없는 것'을 가른다.
 * `attachStoredObject`(지난 파일 다시 붙이기·앱 예약의 올린 파일·일괄 실행의 파일 줄)는 내려받기 실패를 모두
 * 404 '원본 파일이 더 남아 있지 않습니다'로 답했다. 일괄 실행은 404를 '사본이 없음 — 다시 해도 같음'으로 보아
 * 잠깐의 저장소 장애에 그 줄을 **다시 해 보지 않고** 실패로 끝냈다(다른 실패는 한 번 더 해 본다).
 * 이제 없음이 확실할 때만 404, 그 밖은 503. 문서 태그 AI 초안의 원본 받기도 같다.
 */

const state = vi.hoisted(() => ({ downloadError: null as unknown }));

vi.mock('@/lib/attachments/store', () => ({
  createUpload: vi.fn(async () => ({ ok: false, status: 429, message: '상한' })),
  confirmUpload: vi.fn(), deleteAttachment: vi.fn(),
}));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    storage: { from: () => ({ download: async () => (state.downloadError ? { data: null, error: state.downloadError } : { data: new Blob(['a,b\n1,2\n'], { type: 'text/csv' }), error: null }) }) },
  },
}));

import { attachStoredObject } from '@/lib/attachments/reuse';
import { runBatchItem } from '@/lib/apps/batches';

beforeEach(() => { state.downloadError = null; });

const actor = { userId: 'u1', departmentId: 'd1', organizationId: 'o1' };
const source = { storage_path: 'app-batch-files/o1/u1/x.csv', file_name: '표.csv' };

describe('isStorageNotFound', () => {
  it('없음: HTTP 404·몸의 statusCode 404·NoSuchKey·Object not found', () => {
    expect(isStorageNotFound({ status: 404, statusCode: '404', message: 'x' })).toBe(true);
    expect(isStorageNotFound({ status: 400, statusCode: '404', message: 'Object not found' })).toBe(true);
    expect(isStorageNotFound({ status: 400, statusCode: 'NoSuchKey' })).toBe(true);
    expect(isStorageNotFound({ message: 'Object not found' })).toBe(true);
    expect(isStorageNotFound({ originalError: { status: 404 } })).toBe(true);
  });
  it('없음이 아님: 5xx·연결 실패·모르는 오류·빈 값', () => {
    expect(isStorageNotFound({ status: 500, statusCode: '500', message: 'Internal' })).toBe(false);
    expect(isStorageNotFound({ status: 503, statusCode: '503' })).toBe(false);
    expect(isStorageNotFound({ message: 'fetch failed', originalError: {} })).toBe(false);
    expect(isStorageNotFound(new Error('timeout'))).toBe(false);
    expect(isStorageNotFound(null)).toBe(false);
    expect(isStorageNotFound('404')).toBe(false);
  });
});

describe('attachStoredObject', () => {
  it('저장소가 지금 못 주면 503(없음으로 답하지 않음)', async () => {
    state.downloadError = { status: 500, statusCode: '500', message: 'Internal Server Error' };
    expect(await attachStoredObject(actor, source)).toMatchObject({ ok: false, status: 503 });
  });
  it('연결 실패도 503', async () => {
    state.downloadError = { message: 'fetch failed', originalError: {} };
    expect(await attachStoredObject(actor, source)).toMatchObject({ ok: false, status: 503 });
  });
  it('정말 없으면 404', async () => {
    state.downloadError = { status: 400, statusCode: '404', message: 'Object not found' };
    expect(await attachStoredObject(actor, source)).toMatchObject({ ok: false, status: 404 });
  });
});

describe('일괄 실행의 파일 줄', () => {
  const item = {
    id: 'i1', inputs: {}, file: { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', size: 8, path: source.storage_path, name: source.file_name },
    batch: { id: 'b1', user_id: 'u1', department_id: 'd1', organization_id: 'o1', agent_id: 'a1', app_version: 1 },
  } as never;
  const io = () => ({ files: { attach: (a: typeof actor, f: { path: string; name: string }) => attachStoredObject(a, { storage_path: f.path, file_name: f.name }), discard: vi.fn() }, runAs: vi.fn() });

  it('저장소 장애면 다시 해 볼 실패(failed)', async () => {
    state.downloadError = { status: 503, statusCode: '503', message: 'unavailable' };
    expect((await runBatchItem(item, Date.now() + 60_000, io() as never)).kind).toBe('failed');
  });
  it('사본이 정말 없으면 그 줄만 실패(rejected)', async () => {
    state.downloadError = { status: 404, statusCode: '404', message: 'Object not found' };
    const out = await runBatchItem(item, Date.now() + 60_000, io() as never);
    expect(out).toMatchObject({ kind: 'rejected', status: 400 });
    expect((out as { message: string }).message).toContain('사본이 남아 있지 않습니다');
  });
});

describe('문서 태그 AI 초안', () => {
  it('원본을 지금 못 받으면 404가 아니라 503', () => {
    const src = readFileSync('src/app/api/documents/[id]/tag-suggest/route.ts', 'utf8');
    const at = src.indexOf("if (downloadError && !isStorageNotFound(downloadError)) return jsonError('원본 파일을 지금 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 503);");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(src.indexOf("return jsonError('원본 파일을 찾을 수 없습니다.', 404);"));
  });
});
