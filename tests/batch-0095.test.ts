import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { pickAcrossAgents, ragEvalSetKey, type AcrossRunRow, type RagEvalResult, type RagEvalSummary } from '@/lib/rag-eval';
import { acrossEmptyNote } from '@/components/admin/RagEvalPanel';

/** 2026-11-12 — 문서 찾기 일괄 평가: 같은 세트로 잰 다른 비서와 견주기 */

const rows = [
  { question: '출장 일비는?', expected: '여비 규정', page: 12, keywords: ['2만원'] },
  { question: '점심 메뉴', expected: null, page: null },
];

describe('세트 지문', () => {
  it('공백·대소문자·보이지 않는 글자는 같게, 순서·기대 문서·쪽·핵심어가 다르면 다르게', () => {
    const key = ragEvalSetKey(rows);
    expect(key).toMatch(/^v1:2:[0-9a-f]{16}$/);
    expect(ragEvalSetKey([{ ...rows[0], question: '  출장  일비는?​' }, rows[1]])).toBe(key);
    expect(ragEvalSetKey([{ ...rows[0], expected: '여비 규정'.toUpperCase() }, rows[1]])).toBe(key);
    expect(ragEvalSetKey([rows[1], rows[0]])).not.toBe(key);
    expect(ragEvalSetKey([{ ...rows[0], page: 13 }, rows[1]])).not.toBe(key);
    expect(ragEvalSetKey([{ ...rows[0], keywords: ['3만원'] }, rows[1]])).not.toBe(key);
    expect(ragEvalSetKey([{ ...rows[0], expected: '복무 규정' }, rows[1]])).not.toBe(key);
    expect(ragEvalSetKey([rows[0]])).not.toBe(key);
  });
});

const sum = (hitRate: number | null, mrr: number | null, setKey?: string): RagEvalSummary => ({
  questions: 2, expected: 1, hits: 1, hitRate, withPage: 0, pageHits: 0, pageHitRate: null, mrr, offTopic: 1, offTopicRejected: 1, offTopicRejectRate: 1, errors: 0,
  counts: {} as RagEvalSummary['counts'], ...(setKey ? { setKey } : {}),
});
const results = rows.map((r, i) => ({ line: i + 1, ...r, verdict: 'hit', rank: 1, pageMatch: null, chunkCount: 1, topSimilarity: 0.9, topDocuments: [] })) as unknown as RagEvalResult[];

describe('같은 세트로 잰 다른 비서', () => {
  const key = ragEvalSetKey(rows);
  const base: AcrossRunRow = { id: 'r0', agent_id: 'a0', agent_version: 3, created_at: '2026-11-12T01:00:00Z', summary: sum(0.5, 0.5, key) };
  const names = new Map([['a0', '여비 비서'], ['a1', '복무 비서'], ['a2', '총무 비서']]);

  it('비서마다 가장 최근 실행, 기준 실행의 비서는 기준 실행 그대로, 찾음 비율·순위 점수 순', () => {
    const out = pickAcrossAgents(base, key, [
      { id: 'r1', agent_id: 'a1', agent_version: 1, created_at: '2026-11-10T00:00:00Z', summary: sum(0.2, 0.1, key) },
      { id: 'r2', agent_id: 'a1', agent_version: 2, created_at: '2026-11-11T00:00:00Z', summary: sum(1, 1, key) },
      { id: 'r3', agent_id: 'a2', agent_version: 1, created_at: '2026-11-11T00:00:00Z', summary: sum(0.5, 0.9, key) },
      { id: 'r4', agent_id: 'a0', agent_version: 4, created_at: '2026-11-12T02:00:00Z', summary: sum(1, 1, key) },
    ], names);
    expect(out.map((e) => [e.runId, e.agentName, e.current])).toEqual([['r2', '복무 비서', false], ['r3', '총무 비서', false], ['r0', '여비 비서', true]]);
  });
  it('다른 세트·평가할 수 없는 비서(이름 없음)는 빼고, 지문 없는 옛 기록은 결과로 다시 센다', () => {
    const out = pickAcrossAgents(base, key, [
      { id: 'x1', agent_id: 'a1', agent_version: 1, created_at: '2026-11-11T00:00:00Z', summary: sum(1, 1, 'v1:2:0000000000000000') },
      { id: 'x2', agent_id: 'a9', agent_version: 1, created_at: '2026-11-11T00:00:00Z', summary: sum(1, 1, key) },
      { id: 'x3', agent_id: 'a2', agent_version: 1, created_at: '2026-11-11T00:00:00Z', summary: sum(0.1, 0.1), results },
    ], names);
    expect(out.map((e) => e.runId)).toEqual(['r0', 'x3']);
  });
  it('연결(원본) — 새 실행에 지문을 남기고, 다른 비서 목록은 평가할 수 있는 비서만·결과 원문 없이', () => {
    const route = readFileSync('src/app/api/admin/rag-eval/route.ts', 'utf8');
    expect(route).toContain('setKey: ragEvalSetKey(results) };');
    expect(route).toContain(".eq('summary->>setKey', key).neq('agent_id', baseRow.agent_id)");
    expect(route).toContain('const agent = await evaluableAgent(agentId, actor);');
    expect(route).toContain("data: { setKey: key, entries: pickAcrossAgents(baseRow, key, runs, names) }");
    const panel = readFileSync('src/components/admin/RagEvalPanel.tsx', 'utf8');
    expect(panel).toContain('/api/admin/rag-eval?across=${encodeURIComponent(row.id)}');
    expect(acrossEmptyNote).toContain('같은 세트로 평가하면');
  });
});
