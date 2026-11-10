import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
import {
  BATCH_FILE_PREFIX, BATCH_MAX_FILES, batchFileOf, batchFilePath, pairRowsWithFiles, parseBatchAttachmentIds,
} from '@/lib/apps/batch-spec';
import { runBatchItem, runDueBatchItems, type BatchDeps, type BatchItemRun, type BatchRunIo } from '@/lib/apps/batches';
import { previewFileBatch } from '@/components/apps/AppBatchPanel';
import type { AppDefinition } from '@/lib/apps/definition';
import type { RunAsOutcome } from '@/lib/apps/run-as';

/** 일괄 실행의 '파일마다 한 건'(2026-11-10, 0079) — 파일 하나마다 줄 하나, 사본을 실행 때 새 첨부로 다시 붙이고, 묶음이 끝나면 사본을 지운다 */

const F1 = 'aaaaaaaa-1111-4111-8111-111111111111';
const F2 = 'bbbbbbbb-2222-4222-8222-222222222222';
const file = { id: F1, name: '민원1.hwpx', size: 1200, path: `${BATCH_FILE_PREFIX}/o1/u1/${F1}.hwpx` };

describe('꼴', () => {
  it('사본 경로·사본 읽기(접두사 밖·거슬러 오르기·꼴 틀림은 null)', () => {
    expect(batchFilePath('o1', 'u1', F1, 'pdf')).toBe(`app-batch-files/o1/u1/${F1}.pdf`);
    expect(batchFileOf(file)).toEqual(file);
    expect(batchFileOf({ ...file, id: F1.toUpperCase() })?.id).toBe(F1);
    for (const bad of [null, [], 'x', { ...file, path: `app-schedule-files/o1/u1/${F1}.hwpx` }, { ...file, path: `${BATCH_FILE_PREFIX}/../x` }, { ...file, id: 'nope' }, { ...file, name: '' }, { ...file, size: 'big' }]) {
      expect(batchFileOf(bad)).toBeNull();
    }
  });
  it('첨부 id 목록 — 없으면 빈 목록, 10개 넘거나 꼴이 틀리면 null, 겹치면 한 번(순서 유지)', () => {
    expect(parseBatchAttachmentIds(undefined)).toEqual([]);
    expect(parseBatchAttachmentIds([F2, F1, F2.toUpperCase()])).toEqual([F2, F1]);
    expect(parseBatchAttachmentIds(Array.from({ length: BATCH_MAX_FILES + 1 }, () => F1))).toBeNull();
    expect(parseBatchAttachmentIds(['x'])).toBeNull();
    expect(parseBatchAttachmentIds('x')).toBeNull();
  });
  it('줄과 파일 짝 — 한 줄이면 모든 파일에, 같은 수면 순서대로, 아니면 null', () => {
    expect(pairRowsWithFiles([{ a: 1 }], 3)).toEqual([{ a: 1 }, { a: 1 }, { a: 1 }]);
    expect(pairRowsWithFiles([{ a: 1 }, { a: 2 }], 2)).toEqual([{ a: 1 }, { a: 2 }]);
    expect(pairRowsWithFiles([{ a: 1 }, { a: 2 }], 3)).toBeNull();
    expect(pairRowsWithFiles([{ a: 1 }], 0)).toBeNull();
  });
});

describe('미리 보기(화면)', () => {
  const def = (required: boolean): AppDefinition => ({ schemaVersion: 1, fields: [{ key: 'topic', label: '주제', type: 'text', required }], output: 'bullets', attachments: { required: true } });
  it('표가 비면 빈 입력 한 줄을 모든 파일에 — 필수 항목이 있으면 표를 채우라고', () => {
    expect(previewFileBatch(def(false), '', 3)).toMatchObject({ ok: true, rows: [{}], maxCalls: 3 });
    const need = previewFileBatch(def(true), '', 2);
    expect(need.ok).toBe(false);
    expect(!need.ok && need.errors[0]).toContain('입력 표를 채워 주세요');
  });
  it('한 줄 표는 모든 파일에, 줄 수가 맞지 않으면 거절, 파일이 없으면 거절', () => {
    expect(previewFileBatch(def(true), '주제\n여비 민원', 2)).toMatchObject({ ok: true, rows: [{ topic: '여비 민원' }], maxCalls: 2 });
    expect(previewFileBatch(def(true), '주제\n가\n나', 3)).toMatchObject({ ok: false });
    expect(previewFileBatch(def(true), '주제\n가\n나', 2)).toMatchObject({ ok: true });
    expect(previewFileBatch(def(false), '', 0)).toMatchObject({ ok: false });
  });
});

describe('줄 하나 실행(runBatchItem)', () => {
  const batch = { id: 'b1', organization_id: 'o1', department_id: 'd1', user_id: 'u1', agent_id: 'a1', app_version: 2, status: 'running' as const };
  const item = (f: unknown): BatchItemRun => ({ id: 'i1', batch_id: 'b1', position: 1, inputs: { topic: '여비' }, status: 'pending', attempts: 0, claimed_at: null, batch, file: f });
  function io(attach: BatchRunIo['files']['attach'], outcome: RunAsOutcome = { kind: 'completed', conversationId: 'c1', messageId: 'm1' }) {
    const discard = vi.fn(async () => undefined);
    const runAs = vi.fn(async (_input: Parameters<BatchRunIo['runAs']>[0]) => outcome);
    return { value: { files: { attach, discard }, runAs } as BatchRunIo, discard, runAs };
  }
  const ready = async () => ({ ok: true as const, attachment: { id: 'att1', status: 'ready', error: null } as never });

  it('파일 없는 줄은 그대로 실행(첨부 없음)', async () => {
    const t = io(vi.fn(ready));
    await runBatchItem(item(null), 99, t.value);
    expect(t.runAs.mock.calls[0][0]).not.toHaveProperty('attachmentIds');
    expect(t.runAs.mock.calls[0][0]).toMatchObject({ userId: 'u1', departmentId: 'd1', agentId: 'a1', appVersion: 2, inputs: { topic: '여비' }, deadlineAt: 99 });
  });

  it('파일 줄은 사본을 그 직원의 새 첨부로 붙여 함께 실행하고, 마치면 첨부를 그대로 둔다', async () => {
    const attach = vi.fn(ready);
    const t = io(attach);
    expect(await runBatchItem(item(file), 99, t.value)).toMatchObject({ kind: 'completed' });
    expect(attach).toHaveBeenCalledWith({ userId: 'u1', departmentId: 'd1', organizationId: 'o1' }, file);
    expect(t.runAs.mock.calls[0][0]).toMatchObject({ attachmentIds: ['att1'] });
    expect(t.discard).not.toHaveBeenCalled();
  });

  it('시작 전에 거절되면 붙인 첨부를 묘비로', async () => {
    const t = io(vi.fn(ready), { kind: 'rejected', status: 409, message: '바뀜' });
    expect(await runBatchItem(item(file), 99, t.value)).toMatchObject({ kind: 'rejected', status: 409 });
    expect(t.discard).toHaveBeenCalledWith('u1', 'att1');
  });

  it('사본을 못 붙이면 — 던짐·일시 오류는 실패(한 번 더), 사본 없음은 그 줄만 실패(400), 실행하지 않음', async () => {
    const thrown = io(vi.fn(async () => { throw new Error('net'); }));
    expect(await runBatchItem(item(file), 99, thrown.value)).toMatchObject({ kind: 'failed', conversationId: null });
    const busy = io(vi.fn(async () => ({ ok: false as const, status: 429, message: '보내지 않은 첨부가 많습니다' })));
    expect(await runBatchItem(item(file), 99, busy.value)).toMatchObject({ kind: 'failed' });
    const gone = io(vi.fn(async () => ({ ok: false as const, status: 404, message: '없음' })));
    expect(await runBatchItem(item(file), 99, gone.value)).toMatchObject({ kind: 'rejected', status: 400 });
    for (const t of [thrown, busy, gone]) expect(t.runAs).not.toHaveBeenCalled();
  });

  it('붙인 파일을 읽지 못했으면 그 첨부를 묘비로 하고 그 줄만 실패(400) — 꼴이 틀린 파일 칸도', async () => {
    const t = io(vi.fn(async () => ({ ok: true as const, attachment: { id: 'att2', status: 'failed', error: '암호가 걸린 파일' } as never })));
    const out = await runBatchItem(item(file), 99, t.value);
    expect(out).toMatchObject({ kind: 'rejected', status: 400 });
    expect(out.kind === 'rejected' && out.message).toContain('암호가 걸린 파일');
    expect(t.discard).toHaveBeenCalledWith('u1', 'att2');
    expect(t.runAs).not.toHaveBeenCalled();
    const bad = io(vi.fn(ready));
    expect(await runBatchItem(item({ path: '/etc/passwd' }), 99, bad.value)).toMatchObject({ kind: 'rejected', status: 400 });
    expect(bad.runAs).not.toHaveBeenCalled();
  });
});

describe('실행기 — 묶음이 끝나면 사본 지우기', () => {
  const batch = { id: 'b1', organization_id: 'o1', department_id: 'd1', user_id: 'u1', agent_id: 'a1', app_version: 2, status: 'running' as const };
  const one: BatchItemRun = { id: 'i1', batch_id: 'b1', position: 1, inputs: {}, status: 'pending', attempts: 0, claimed_at: null, batch, file };
  const deps = (over: Partial<BatchDeps>) => {
    const cleanup = vi.fn(async () => undefined);
    const d: BatchDeps = {
      now: () => 0, openItems: async () => [one], claim: async () => true, run: async () => ({ kind: 'completed', conversationId: 'c', messageId: 'm' }),
      finishItem: async () => {}, stop: async () => true, settle: async () => true, log: async () => {}, cleanup, notifyFinished: async () => true, ...over,
    };
    return { d, cleanup };
  };
  it('마친 호출·멈춘 호출에서만 한 번, 지우기가 던져도 메일은 보낸다', async () => {
    const t = deps({});
    expect(await runDueBatchItems(t.d)).toMatchObject({ done: 1, notified: 1 });
    expect(t.cleanup).toHaveBeenCalledWith('b1');
    const stopped = deps({ run: async () => ({ kind: 'rejected', status: 403, message: 'x' }) });
    await runDueBatchItems(stopped.d);
    expect(stopped.cleanup).toHaveBeenCalledTimes(1);
    const notEnded = deps({ settle: async () => false });
    await runDueBatchItems(notEnded.d);
    expect(notEnded.cleanup).not.toHaveBeenCalled();
    const throws = deps({ cleanup: vi.fn(async () => { throw new Error('storage'); }) });
    expect(await runDueBatchItems(throws.d)).toMatchObject({ notified: 1 });
  });
});

describe('연결', () => {
  it('만들기는 요청자의 읽힌 첨부를 일괄 실행 경로로 복사해 줄마다 붙이고 원본을 묘비로, 실행기·그만두기·결과가 파일 칸을 쓴다', () => {
    const lib = readFileSync('src/lib/apps/batches.ts', 'utf8');
    expect(lib).toContain('copyAttachmentsTo({ userId: actor.userId, organizationId }, attachmentIds, (fileId, ext) => batchFilePath(organizationId, actor.userId, fileId, ext))');
    expect(lib).toContain('...(files[i] ? { file: files[i] } : {})');
    expect(lib).toContain('if (fileMode) await discardAttachments(actor.userId, attachmentIds);');
    expect(lib).toContain("select('id, batch_id, position, inputs, status, attempts, claimed_at, file')");
    expect(lib).toContain('run: (item, deadlineAt) => runBatchItem(item, deadlineAt)');
    expect(lib).toContain('cleanup: (batchId) => removeBatchFiles(batchId)');
    const cancel = lib.slice(lib.indexOf('export async function cancelBatch'), lib.indexOf('export async function removeBatchFiles'));
    expect(cancel).toContain('await removeBatchFiles(id)');
    expect(lib).toContain("fileName: batchFileOf(r.file)?.name ?? null");
    const copy = readFileSync('src/lib/apps/schedule-files.ts', 'utf8');
    expect(copy).toContain(".eq('user_id', actor.userId).eq('status', 'ready').in('id', attachmentIds)");
    const panel = readFileSync('src/components/apps/AppBatchPanel.tsx', 'utf8');
    expect(panel).toContain('파일마다 한 건');
    expect(panel).toContain("...(mode === 'files' ? { attachment_ids: readyIds } : {})");
    expect(readFileSync('supabase/migrations/0079_app_batch_files.sql', 'utf8')).toContain('ADD COLUMN IF NOT EXISTS file jsonb');
  });
});
