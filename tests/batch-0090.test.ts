import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
import {
  AUTO_INDEX_BATCH, AUTO_INDEX_BUDGET_MS, AUTO_INDEX_CANDIDATES, autoIndexReferences, type AutoIndexDeps, type PendingIndexRow, type ReferenceIndex,
} from '@/lib/document-references';
import { APP_DRAFT_BADGE, APP_DRAFT_FOLLOWUP_NOTE } from '@/lib/apps/draft';

/** 2026-11-12 묶음 — ① 문서 참조 색인 자동 채우기(5분 실행기) ② 시험 판 실행 대화의 이름표·이어 묻기 안내 */

const row = (id: string, over: Partial<PendingIndexRow> = {}): PendingIndexRow => ({
  id, department_id: 'd1', organization_id: 'o1', visibility: 'organization', storage_path: `p/${id}.hwpx`, file_name: `${id}.hwpx`, noda_status: 'ready', ...over,
});

function deps(rows: PendingIndexRow[], over: Partial<AutoIndexDeps> = {}) {
  const saved: Array<{ id: string; org: string; index: ReferenceIndex }> = [];
  let t = 0;
  const d: AutoIndexDeps = {
    listPendingAll: vi.fn(async () => rows),
    readText: vi.fn(async () => ({ ok: true as const, text: '「여비 규정」에 따라 「복무 규정」을 본다', truncated: false })),
    saveIndex: vi.fn(async (id: string, org: string, index: ReferenceIndex) => { saved.push({ id, org, index }); return true; }),
    now: () => t,
    // 섞지 않는다(첫 자리 그대로)
    random: () => 0.999999,
    ...over,
  };
  return { d, saved, advance: (ms: number) => { t += ms; } };
}

describe('참조 색인 자동 채우기', () => {
  it('한 번에 두 개, 그 문서의 기관으로 인용 열쇠를 저장', async () => {
    const t = deps([row('a'), row('b', { organization_id: 'o2' }), row('c')]);
    expect(await autoIndexReferences(t.d)).toEqual({ indexed: 2, skipped: 0, deferred: 0 });
    expect(t.d.listPendingAll).toHaveBeenCalledWith(AUTO_INDEX_CANDIDATES);
    expect(t.saved.map((s) => [s.id, s.org])).toEqual([['a', 'o1'], ['b', 'o2']]);
    expect(t.saved[0].index).toMatchObject({ v: 1, status: 'ok' });
    expect((t.saved[0].index as { keys: string[] }).keys.length).toBe(2);
    expect(AUTO_INDEX_BATCH).toBe(2);
  });
  it('지우는 중·원본 없음은 읽지 않고 건너뜀, 다시 읽어도 같은 실패(413·422)도 건너뜀', async () => {
    const t = deps([row('a', { noda_status: 'deleting' }), row('b', { storage_path: null })]);
    expect(await autoIndexReferences(t.d)).toEqual({ indexed: 0, skipped: 2, deferred: 0 });
    expect(t.d.readText).not.toHaveBeenCalled();
    expect(t.saved.map((s) => (s.index as { reason?: string }).reason)).toEqual(['deleting', 'no_file']);
    const big = deps([row('a'), row('b')], { readText: vi.fn(async (p: string) => (p.includes('a') ? { ok: false as const, status: 413, message: '' } : { ok: false as const, status: 422, message: '' })) });
    expect(await autoIndexReferences(big.d)).toEqual({ indexed: 0, skipped: 2, deferred: 0 });
    expect(big.saved.map((s) => (s.index as { reason?: string }).reason)).toEqual(['too_large', 'unreadable']);
  });
  it('저장소가 잠깐 안 되거나(503·던짐) 저장이 실패하면 미루고 색인을 남기지 않는다', async () => {
    const t = deps([row('a'), row('b')], { readText: vi.fn(async (p: string) => { if (p.includes('a')) throw new Error('net'); return { ok: false as const, status: 503, message: '' }; }) });
    expect(await autoIndexReferences(t.d)).toEqual({ indexed: 0, skipped: 0, deferred: 2 });
    expect(t.saved).toEqual([]);
    const s = deps([row('a')], { saveIndex: vi.fn(async () => false) });
    expect(await autoIndexReferences(s.d)).toEqual({ indexed: 0, skipped: 0, deferred: 1 });
    const thrown = deps([row('a')], { saveIndex: vi.fn(async () => { throw new Error('db'); }) });
    expect(await autoIndexReferences(thrown.d)).toEqual({ indexed: 0, skipped: 0, deferred: 1 });
  });
  it('기관이 없는 행은 건너뛰고, 목록을 못 읽으면 아무것도 안 한다(던지지 않음)', async () => {
    const t = deps([row('a', { organization_id: null }), row('b')]);
    await autoIndexReferences(t.d);
    expect(t.saved.map((s) => s.id)).toEqual(['b']);
    const bad = deps([], { listPendingAll: vi.fn(async () => { throw new Error('db'); }) });
    expect(await autoIndexReferences(bad.d)).toEqual({ indexed: 0, skipped: 0, deferred: 0 });
  });
  it('후보를 섞어 고른다 — 잠깐 실패한 맨 앞 문서만 되풀이해 집지 않게', async () => {
    const t = deps([row('a'), row('b'), row('c'), row('d')], { random: () => 0 });
    await autoIndexReferences(t.d);
    expect(t.saved.map((s) => s.id)).not.toEqual(['a', 'b']);
    expect(t.saved).toHaveLength(2);
  });
  it('시간 예산을 넘기면 다음 문서를 시작하지 않는다', async () => {
    const holder: { advance?: (ms: number) => void } = {};
    const t = deps([row('a'), row('b')], { readText: vi.fn(async () => { holder.advance!(AUTO_INDEX_BUDGET_MS + 1); return { ok: true as const, text: '', truncated: false }; }) });
    holder.advance = t.advance;
    expect(await autoIndexReferences(t.d)).toEqual({ indexed: 1, skipped: 0, deferred: 0 });
  });
  it('연결(원본) — 5분 실행기가 나란히 부르고 던져도 실행기는 이어 가며, 모든 기관의 색인 없는 문서를 최근 것부터', () => {
    const route = readFileSync('src/app/api/cron/app-schedules/route.ts', 'utf8');
    expect(route).toContain('autoIndexReferences(autoIndexDeps()).catch(() => null)');
    const db = readFileSync('src/lib/document-references-db.ts', 'utf8');
    expect(db).toMatch(/listPendingAll\(limit\) \{[\s\S]*\.not\('organization_id', 'is', null\)[\s\S]*\.is\('metadata->references', null\)[\s\S]*\.order\('created_at', \{ ascending: false \}\)/);
    // 저장은 그 문서의 기관으로 조건을 건다(saveReferenceIndex)
    expect(db).toMatch(/\.update\(\{ metadata: \{ \.\.\.base, references: index \} \}\)\s+\.eq\('id', id\)\s+\.eq\('organization_id', organizationId\)/);
  });
});

describe('시험 판 실행 대화', () => {
  it('이름표·안내 글', () => {
    expect(APP_DRAFT_BADGE).toBe('시험 판 실행');
    expect(APP_DRAFT_FOLLOWUP_NOTE).toContain('지금 판');
  });
  it('연결(원본) — 저장된 답변의 app_draft로 이름표, 이어 실행 길은 숨기고, 입력창 위 안내', () => {
    const chat = readFileSync('src/components/chat/ChatInterface.tsx', 'utf8');
    expect(chat).toContain("appDraft: m.role === 'assistant' && m.source_references?.app_draft ? true : undefined,");
    expect(chat).toContain('badge={msg.appDraft ? APP_DRAFT_BADGE : undefined}');
    expect(chat).toContain("msg.role === 'assistant' && !msg.appDraft && <AppResumeLink");
    expect(chat).toContain('{messages.some((m) => m.appDraft) && (');
  });
});
