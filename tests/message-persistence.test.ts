import { describe, it, expect } from 'vitest';

/**
 * 배치 삽입 시 컬럼 합집합 문제.
 *
 * PostgREST는 여러 행을 한 번에 넣을 때 모든 행의 컬럼을 합집합으로 맞추고,
 * 그 컬럼이 없는 행에는 **명시적 NULL**을 넣는다. 컬럼에 기본값이 있어도
 * 우회되므로 NOT NULL 컬럼이면 배치 전체가 실패한다.
 *
 * 실제로 이것 때문에 대화 메시지가 한 건도 저장되지 않았다. 답변은 이미
 * 스트리밍된 뒤라 사용자는 정상으로 보고, 새로고침하면 내용이 사라졌다.
 *
 * DB를 띄우지 않고 규칙만 고정한다 — 같은 실수를 코드 리뷰에서 잡을 수 있게.
 */

/** 배치로 넣을 행들이 같은 키 집합을 갖는지 */
function hasUniformKeys(rows: Record<string, unknown>[]): boolean {
  if (rows.length <= 1) return true;
  const keys = rows.map((row) => Object.keys(row).sort().join(','));
  return keys.every((k) => k === keys[0]);
}

describe('배치 삽입 — 행마다 키가 같아야 한다', () => {
  it('키가 어긋나면 잡아낸다', () => {
    // 실제로 실패했던 형태: 사용자 행에만 source_references가 없었다
    const rows = [
      { conversation_id: 'c1', role: 'user', content: '질문' },
      { conversation_id: 'c1', role: 'assistant', content: '답변', source_references: {} },
    ];
    expect(hasUniformKeys(rows)).toBe(false);
  });

  it('모든 행에 넣으면 통과한다', () => {
    const rows = [
      { conversation_id: 'c1', role: 'user', content: '질문', source_references: {} },
      { conversation_id: 'c1', role: 'assistant', content: '답변', source_references: {} },
    ];
    expect(hasUniformKeys(rows)).toBe(true);
  });

  it('한 행짜리 삽입은 기본값이 정상 적용되므로 문제없다', () => {
    expect(hasUniformKeys([{ a: 1 }])).toBe(true);
  });
});

describe('대화 실행기의 메시지 삽입', () => {
  it('두 행이 같은 키를 갖는다', async () => {
    const { buildMessageRows } = await import('@/lib/assistant/persist');
    const rows = buildMessageRows({
      conversationId: 'c', userId: 'u', userContent: 'q', assistantText: 'a', chunks: [], links: [], files: [], attachments: [], agentVersion: 1, documentsSkipped: false,
    });
    expect(hasUniformKeys(rows)).toBe(true);
    expect(rows[0]).toHaveProperty('source_references');
  });

  const withAttachments = async () => {
    const { buildMessageRows } = await import('@/lib/assistant/persist');
    return buildMessageRows({
      conversationId: 'c', userId: 'u', userContent: '[첨부 파일: 예산.xlsx]\nq', assistantText: 'a', chunks: [], links: [], files: [],
      attachments: [{ id: 'att-1', file_name: '예산.xlsx' }], agentVersion: 1, documentsSkipped: false,
    });
  };

  it('첨부가 있어도 두 행의 칸 집합이 같다', async () => {
    expect(hasUniformKeys(await withAttachments())).toBe(true);
  });

  it('사용자 행 source_references.attachments', async () => {
    const rows = await withAttachments();
    // 저장소 경로는 싣지 않는다 — id와 이름만
    expect(rows[0].source_references).toEqual({ attachments: [{ id: 'att-1', file_name: '예산.xlsx' }] });
  });

  it('숫자 확인 결과가 있어도 두 행의 칸 집합이 같고, 답변 행 source_references에만 싣는다', async () => {
    const { buildMessageRows } = await import('@/lib/assistant/persist');
    const rows = buildMessageRows({
      conversationId: 'c', userId: 'u', userContent: 'q', assistantText: '합계 12,345', chunks: [], links: [], files: [],
      attachments: [{ id: 'att-1', file_name: '예산.xlsx' }], agentVersion: 1, documentsSkipped: false, numberCheck: { unverified: ['12,345'] },
    });
    expect(hasUniformKeys(rows)).toBe(true);
    expect((rows[1].source_references as Record<string, unknown>).number_check).toEqual({ unverified: ['12,345'] });
    expect(rows[0].source_references).not.toHaveProperty('number_check');
  });

  it('숫자 확인 결과가 없으면 number_check 칸을 남기지 않는다', async () => {
    const { buildMessageRows } = await import('@/lib/assistant/persist');
    const rows = buildMessageRows({
      conversationId: 'c', userId: 'u', userContent: 'q', assistantText: 'a', chunks: [], links: [], files: [], attachments: [], agentVersion: 1, documentsSkipped: false, numberCheck: null,
    });
    expect(rows[1].source_references).not.toHaveProperty('number_check');
  });

  it('문서 없이 답한 턴이면 답변 행에 documents_skipped, 두 행 칸 집합은 같다', async () => {
    const { buildMessageRows } = await import('@/lib/assistant/persist');
    const rows = buildMessageRows({
      conversationId: 'c', userId: 'u', userContent: 'q', assistantText: 'a', chunks: [], links: [], files: [], attachments: [], agentVersion: 1,
      documentsSkipped: true,
    });
    expect(hasUniformKeys(rows)).toBe(true);
    expect((rows[1].source_references as Record<string, unknown>).documents_skipped).toBe(true);
    expect(rows[0].source_references).not.toHaveProperty('documents_skipped');
  });

  it('문서를 찾은 턴이면 documents_skipped 칸을 남기지 않는다', async () => {
    const { buildMessageRows } = await import('@/lib/assistant/persist');
    const rows = buildMessageRows({
      conversationId: 'c', userId: 'u', userContent: 'q', assistantText: 'a', chunks: [], links: [], files: [], attachments: [], agentVersion: 1,
      documentsSkipped: false,
    });
    expect(hasUniformKeys(rows)).toBe(true);
    expect(rows[1].source_references).not.toHaveProperty('documents_skipped');
  });

  it('NODA 검증 결과가 있으면 답변 행 source_references.verify에만, 두 행 칸 집합은 같다', async () => {
    const { buildMessageRows } = await import('@/lib/assistant/persist');
    const verify = { grounded: false, unsupported_numbers: ['50'], unknown_refs: [3] };
    const rows = buildMessageRows({
      conversationId: 'c', userId: 'u', userContent: 'q', assistantText: 'a', chunks: [], links: [], files: [], attachments: [], agentVersion: 1,
      documentsSkipped: false, verify,
    });
    expect(hasUniformKeys(rows)).toBe(true);
    expect((rows[1].source_references as Record<string, unknown>).verify).toEqual(verify);
    expect(rows[0].source_references).not.toHaveProperty('verify');
  });

  it('NODA 검증 결과가 없으면 verify 칸을 남기지 않는다', async () => {
    const { buildMessageRows } = await import('@/lib/assistant/persist');
    for (const verify of [undefined, null]) {
      const rows = buildMessageRows({
        conversationId: 'c', userId: 'u', userContent: 'q', assistantText: 'a', chunks: [], links: [], files: [], attachments: [], agentVersion: 1,
        documentsSkipped: false, verify,
      });
      expect(hasUniformKeys(rows)).toBe(true);
      expect(rows[1].source_references).not.toHaveProperty('verify');
    }
  });

  it('조각의 쪽·칸·절·스캔 판독을 저장한다', async () => {
    const { buildMessageRows } = await import('@/lib/assistant/persist');
    const rows = buildMessageRows({
      conversationId: 'c', userId: 'u', userContent: 'q', assistantText: 'a', links: [], files: [], attachments: [], agentVersion: 1, documentsSkipped: false,
      chunks: [{ documentId: 'd', documentTitle: '규정', chunkIndex: 0, text: '', similarity: 0.86, page: 12, cellRange: null, section: '제3장 › 여비', ocr: true }],
    });
    expect((rows[1].source_references as { chunks: unknown[] }).chunks).toEqual([
      { documentId: 'd', documentTitle: '규정', chunkIndex: 0, similarity: 0.86, page: 12, cellRange: null, section: '제3장 › 여비', ocr: true },
    ]);
  });

  it('근거 원문과 NODA 번호를 저장한다 — 지난 대화에서도 근거 창을 열 수 있게', async () => {
    const { buildMessageRows } = await import('@/lib/assistant/persist');
    const rows = buildMessageRows({
      conversationId: 'c', userId: 'u', userContent: 'q', assistantText: '구성한다 [2]', links: [], files: [], attachments: [], agentVersion: 1, documentsSkipped: false,
      chunks: [{ documentId: 'd', documentTitle: '규정', chunkIndex: 0, n: 2, text: '제7조 ② 위원 25명', similarity: 0.86, page: 43 }],
    });
    const [saved] = (rows[1].source_references as { chunks: Record<string, unknown>[] }).chunks;
    expect(saved.n).toBe(2);
    expect(saved.text).toBe('제7조 ② 위원 25명');
  });

  it('공통 자료실 조각의 scope·editionYear가 답변 행에 실리고 두 행의 칸 집합은 같다(S5)', async () => {
    const { buildMessageRows } = await import('@/lib/assistant/persist');
    const rows = buildMessageRows({
      conversationId: 'c', userId: 'u', userContent: 'q', assistantText: '일비 [1], 기준 [2]', links: [], files: [], attachments: [], agentVersion: 1, documentsSkipped: false,
      chunks: [
        { documentId: 'd', documentTitle: '규정', chunkIndex: 0, n: 1, text: '일비', similarity: 0.86 },
        { documentId: 'c', documentTitle: '예산편성기준', chunkIndex: 1, n: 2, text: '기준', similarity: 0.88, scope: 'common', editionYear: 2026 },
      ],
    });
    expect(hasUniformKeys(rows)).toBe(true);
    const [agent, common] = (rows[1].source_references as { chunks: Record<string, unknown>[] }).chunks;
    expect(common).toMatchObject({ scope: 'common', editionYear: 2026, n: 2 });
    // 비서 조각에는 칸이 없다 — 저장된 JSON에서 빠진다
    const saved = JSON.parse(JSON.stringify(agent)) as Record<string, unknown>;
    expect(saved).not.toHaveProperty('scope');
    expect(saved).not.toHaveProperty('editionYear');
  });

  it('저장 실패를 화면에 알린다', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/lib/assistant/stream.ts', 'utf8');
    const start = src.indexOf('if (saveError)');
    expect(start).toBeGreaterThan(-1);
    expect(src.slice(start, start + 300)).toContain("event: 'error'");
  });

  it('참고 자료를 붙일 때 인용 규칙도 함께 넣는다', async () => {
    // 프리셋마다 적지 않고 여기 한 곳에 두는 이유: 이 실패는 특정 비서의
    // 문제가 아니라 문서를 근거로 답하는 모든 경로에서 생긴다.
    const { docSearchAddendum } = await import('@/lib/capabilities/doc-search');
    const text = docSearchAddendum({ context: '[1] 규정\nt', chunks: [{ documentId: 'd', chunkIndex: 0, text: 't', similarity: 0.5 }], hasDocuments: true, skipped: false })!;
    expect(text).toContain('참고 자료(이 기관 문서):');
    expect(text).toContain('자료 인용 규칙');
    expect(text).toContain('단위');
  });
});
