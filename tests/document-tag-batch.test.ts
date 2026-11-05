import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { batchDraftTargets, draftResultOf, draftText, MAX_BATCH_DRAFTS, runDraftQueue, type DraftResult } from '@/lib/document-tag-batch';

/** 여러 문서에 한 번에 AI 태그 초안(2026-11-05) — 대상 고르기, 한도에 닿으면 남은 문서를 부르지 않음, 저장은 사람이 고른 것만 */

describe('대상', () => {
  const doc = (id: string, over: Record<string, unknown> = {}) => ({ id, noda_status: 'ready', retired_at: null, tags: [] as string[], ...over });
  it('태그 없는 문서만(기본), 지난 판·삭제 대기 빼고, 목록 순서로 20개까지', () => {
    const docs = [doc('a'), doc('b', { tags: ['여비'] }), doc('c', { noda_status: 'retired' }), doc('d', { retired_at: '2026-11-01' }), doc('e', { noda_status: 'deleting' }), doc('f', { noda_status: 'failed', tags: null })];
    expect(batchDraftTargets(docs).map((d) => d.id)).toEqual(['a', 'f']);
    expect(batchDraftTargets(docs, { onlyUntagged: false }).map((d) => d.id)).toEqual(['a', 'b', 'f']);
    expect(batchDraftTargets(Array.from({ length: 30 }, (_, i) => doc(`x${i}`)))).toHaveLength(MAX_BATCH_DRAFTS);
  });
});

describe('응답 갈래', () => {
  it('성공은 제안, 한도·로그인은 멈춤, 그 밖은 그 문서만 실패', () => {
    expect(draftResultOf(200, { ok: true, data: { suggestions: ['여비', 3] } })).toEqual({ kind: 'ok', suggestions: ['여비'] });
    expect(draftResultOf(429, { ok: false, error: { message: '이번 달 사용 한도를 넘었습니다.' } })).toEqual({ kind: 'stop', message: '이번 달 사용 한도를 넘었습니다.' });
    expect(draftResultOf(401, null).kind).toBe('stop');
    expect(draftResultOf(403, { ok: false, error: { message: '권한이 없습니다.' } })).toEqual({ kind: 'failed', message: '권한이 없습니다.' });
    expect(draftResultOf(502, null)).toEqual({ kind: 'failed', message: '태그 초안을 만들지 못했습니다.' });
  });
});

describe('차례 돌리기', () => {
  it('동시에 둘까지, 결과는 넣은 자리, 던지면 그 일만 실패', async () => {
    let live = 0;
    let peak = 0;
    const results = await runDraftQueue(['a', 'b', 'c', 'd'], async (id) => {
      live += 1; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live -= 1;
      if (id === 'c') throw new Error('x');
      return { kind: 'ok', suggestions: [id] };
    }, { concurrency: 2 });
    expect(peak).toBe(2);
    expect(results).toEqual([
      { kind: 'ok', suggestions: ['a'] }, { kind: 'ok', suggestions: ['b'] }, { kind: 'failed', message: '태그 초안을 만들지 못했습니다.' }, { kind: 'ok', suggestions: ['d'] },
    ]);
  });

  it('멈춤이 나오면 아직 시작하지 않은 문서는 부르지 않고 건너뜀으로 알린다', async () => {
    const called: string[] = [];
    const seen: [string, string][] = [];
    const results = await runDraftQueue(['a', 'b', 'c', 'd'], async (id): Promise<DraftResult> => {
      called.push(id);
      return id === 'a' ? { kind: 'stop', message: '한도' } : { kind: 'ok', suggestions: [] };
    }, { concurrency: 1, onResult: (id, r) => seen.push([id, r.kind]) });
    expect(called).toEqual(['a']);
    expect(results.map((r) => r.kind)).toEqual(['stop', 'skipped', 'skipped', 'skipped']);
    expect(seen).toEqual([['a', 'stop'], ['b', 'skipped'], ['c', 'skipped'], ['d', 'skipped']]);
  });

  it('빈 목록이면 아무것도 부르지 않는다', async () => {
    expect(await runDraftQueue([], async () => ({ kind: 'ok', suggestions: [] }))).toEqual([]);
  });
});

describe('검토 글·화면', () => {
  it('지금 태그 뒤에 제안을 겹치지 않게 잇는다', () => {
    expect(draftText(['여비'], ['여비', '복무'])).toBe('여비, 복무');
    expect(draftText(null, ['복무'])).toBe('복무');
  });

  it('화면 — 시작 전에 사용량을 묻고, 저장은 고른 것만·분류표로 먼저 보고, 서버 새 라우트 없음', () => {
    const ui = readFileSync('src/components/admin/TagBatchDraft.tsx', 'utf8');
    expect(ui).toContain('window.confirm(');
    expect(ui).toContain('문서마다 AI 사용량이 기록됩니다');
    expect(ui).toContain("rows.filter((r) => r.accept && r.state === 'ready')");
    expect(ui).toContain('applyVocabulary(checked.tags, vocabulary)');
    expect(ui).toContain('`/api/documents/${id}/tag-suggest`');
    expect(readFileSync('src/components/admin/DocumentsManager.tsx', 'utf8')).toContain('<TagBatchDraft');
    expect(readFileSync('src/lib/document-tag-batch.ts', 'utf8')).not.toMatch(/supabase|config'/);
  });
});
