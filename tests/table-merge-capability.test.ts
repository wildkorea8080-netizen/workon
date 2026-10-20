// tests/table-merge-capability.test.ts
import { describe, it, expect, vi } from 'vitest';

// 기본 deps(tableMerge·fileRead)가 한 턴 캐시를 함께 쓰는지 보려고 저장소를 흉내 낸다
const storeMock = vi.hoisted(() => ({
  list: vi.fn(async () => [] as unknown[]),
  load: vi.fn(async () => null as unknown),
}));
vi.mock('@/lib/attachments/store', () => ({
  listConversationAttachments: storeMock.list,
  loadExtract: storeMock.load,
}));
// 기본 deps의 사용 기록이 DB로 나가지 않게
vi.mock('@/lib/assistant/persist', () => ({ writeUsageLog: vi.fn(async () => {}) }));

import { buildTable } from '@/lib/attachments/header';
import { combineTables } from '@/lib/table-engine/combine';
import { createTableMerge, tableMerge, TABLE_MERGE_GUIDE, type TableMergeDeps } from '@/lib/capabilities/table-merge';
import { fileRead, OVERVIEW_START } from '@/lib/capabilities/file-read';
import { findAttachment } from '@/lib/capabilities/attachment-access';
import { attachmentRequestError } from '@/lib/assistant/attachments';
import { acceptsChatFiles } from '@/lib/capabilities/settings';
import type { Cell } from '@/lib/attachments/types';
import type { AttachmentExtract, AttachmentSummary } from '@/lib/attachments/types';
import type { GeneratedFileRef, TurnAttachment, TurnContext } from '@/lib/capabilities/types';
import type { SaveGeneratedFileInput } from '@/lib/generated-files';

const UUID1 = '11111111-1111-4111-8111-111111111111';
const UUID2 = '22222222-2222-4222-8222-222222222222';

const t1 = buildTable(1, '시트1', [['부서', '예산'], ['총무과', 100], ['기획과', 50], ['합계', 150]], []);
const t2 = buildTable(1, '시트1', [['부서', '예산', '비고'], ['총무과', 200, '추경'], ['인사과', '미제출', null]], []);

const extracts: Record<string, AttachmentExtract> = {
  [UUID1]: { kind: 'spreadsheet', text: '', tables: [t1], warnings: [] },
  [UUID2]: { kind: 'spreadsheet', text: '', tables: [t2], warnings: [] },
};

const summary = (cols: string[]): AttachmentSummary => ({
  kind: 'spreadsheet', chars: 10, tables: [{ id: 't1', title: '시트1', rows: 3, columns: cols }], warnings: [],
});

const attachments: TurnAttachment[] = [
  { ref: 'a1', id: UUID1, fileName: '예산.xlsx', summary: summary(['부서', '예산']), isNew: false },
  { ref: 'a2', id: UUID2, fileName: '현황.xlsx', summary: summary(['부서', '예산', '비고']), isNew: true },
];

const ctx = (over: Partial<TurnContext> = {}): TurnContext => ({
  organizationId: 'org', departmentId: 'dept', userId: 'u1', agentId: 'agent', agentVersion: 1,
  capabilities: { table_merge: {} }, message: '합쳐줘', conversationId: 'conv', attachments, ...over,
});

function deps(over: Partial<TableMergeDeps> = {}): TableMergeDeps & {
  saveFile: ReturnType<typeof vi.fn>;
  logMerged: ReturnType<typeof vi.fn>;
  loadExtract: ReturnType<typeof vi.fn>;
} {
  return {
    loadExtract: vi.fn(async (_c: TurnContext, a: TurnAttachment) => extracts[a.id] ?? null),
    saveFile: vi.fn(async (input: SaveGeneratedFileInput): Promise<GeneratedFileRef> => ({
      id: 'file-1', file_name: input.fileName, size_bytes: input.bytes.length,
    })),
    logMerged: vi.fn(async () => {}),
    ...over,
  } as never;
}

const SPEC = {
  sources: [{ file: 'a1', table: 't1' }, { file: 'a2', table: 't1' }],
  group_by: ['부서'],
  aggregate: [{ column: '예산', fn: 'sum' }],
  total_row: true,
};

const run = (d: TableMergeDeps, input: Record<string, unknown>, c = ctx()) =>
  createTableMerge(d).execute!('combine_tables', input, c);

describe('combine_tables — 계산 결과', () => {
  it('두 첨부 표를 합쳐 결과·근거 요약, shownValues', async () => {
    const d = deps();
    const out = await run(d, { spec: SPEC });
    expect(out.ok).toBe(true);
    const lines = out.text.split('\n');
    expect(lines[0]).toBe('[계산 결과 — 숫자는 이 결과만 옮기세요]');
    expect(out.text).toContain('| 총무과 | 300 |');
    expect(out.text).toContain('| 기획과 | 50 |');
    // 근거 요약: 뺀 행(원천의 합계 행), 읽지 못한 칸, 한쪽에만 있는 열
    expect(out.text).toContain('뺀 행 1개');
    expect(out.text).toMatch(/읽지 못한 칸 1개[^\n]*미제출/);
    expect(out.text).toMatch(/한쪽에만 있는 열[^\n]*비고/);
    expect(out.text).toContain('합계 행');
    // 보여 준 값 = 결과 행 + 합계 행
    expect(out.shownValues).toEqual(expect.arrayContaining([300, 50, 350]));
    expect(out.shownValues!.every((v) => typeof v === 'number')).toBe(true);
    expect(out.files).toBeUndefined();
    expect(d.saveFile).not.toHaveBeenCalled();
  });

  it('30행이 넘으면 처음 30행만 보이고 shownValues도 보여 준 것만', async () => {
    const cells: Cell[][] = [['부서', '예산'], ...Array.from({ length: 40 }, (_, i) => [`부서${i + 1}`, 1000 + i])];
    const big = buildTable(1, '시트1', cells, []);
    const d = deps({ loadExtract: vi.fn(async () => ({ kind: 'spreadsheet' as const, text: '', tables: [big], warnings: [] })) });
    const out = await run(d, { spec: { sources: [{ file: 'a1', table: 't1' }], total_row: true } });
    expect(out.ok).toBe(true);
    expect(out.text).toContain('… 외 10행');
    expect(out.text).toContain('| 부서30 | 1,029 |');
    expect(out.text).not.toContain('부서31 |');
    const total = Array.from({ length: 40 }, (_, i) => 1000 + i).reduce((a, b) => a + b, 0);
    expect(out.shownValues).toContain(total);
    expect(out.shownValues).toContain(1029);
    expect(out.shownValues).not.toContain(1030);
    // 결과 글에 보인 행 수('외 10행'·원천 40행)도 AI가 본 숫자다
    expect(out.shownValues).toEqual(expect.arrayContaining([10, 40]));
  });

  it('엔진의 안내 문장(notes)과 경고 목록을 결과 글에 싣는다', async () => {
    const cells: Cell[][] = [['부서', '예산'], ['총무과', '(1,234)'], ['기획과', 50]];
    const t = buildTable(1, '시트1', cells, []);
    const d = deps({ loadExtract: vi.fn(async () => ({ kind: 'spreadsheet' as const, text: '', tables: [t], warnings: [] })) });
    const out = await run(d, { spec: { sources: [{ file: 'a1', table: 't1' }] } });
    expect(out.ok).toBe(true);
    expect(out.text).toContain('괄호 숫자');
  });
});

describe('combine_tables — 실패', () => {
  it('없는 ref·없는 표 id는 쓸 수 있는 목록과 실패', async () => {
    const noRef = await run(deps(), { spec: { sources: [{ file: 'a9', table: 't1' }] } });
    expect(noRef).toEqual({ ok: false, text: '없는 첨부입니다: a9. 쓸 수 있는 것: a1, a2' });
    const noTable = await run(deps(), { spec: { sources: [{ file: 'a1', table: 't7' }] } });
    expect(noTable.ok).toBe(false);
    expect(noTable.text).toContain('t7');
    expect(noTable.text).toContain('쓸 수 있는 것: t1');
  });

  it('본문을 못 불러오면 다시 시도하라고 한다', async () => {
    const out = await run(deps({ loadExtract: vi.fn(async () => null) }), { spec: SPEC });
    expect(out.ok).toBe(false);
    expect(out.text).toContain('불러오지 못했습니다');
  });

  it('엔진 실패(단위 충돌)는 그 글 그대로', async () => {
    const k = buildTable(1, '시트1', [['부서', '예산'], ['총무과', 100]], [], '(단위: 천원)');
    const w = buildTable(1, '시트1', [['부서', '예산'], ['기획과', 50000]], [], '(단위: 원)');
    const d = deps({
      loadExtract: vi.fn(async (_c: TurnContext, a: TurnAttachment) => ({
        kind: 'spreadsheet' as const, text: '', tables: [a.id === UUID1 ? k : w], warnings: [],
      })),
    });
    const spec = { sources: [{ file: 'a1', table: 't1' }, { file: 'a2', table: 't1' }] };
    const expected = combineTables(
      [{ file: 'a1', fileName: '예산.xlsx', table: k }, { file: 'a2', fileName: '현황.xlsx', table: w }],
      spec
    );
    expect(expected.ok).toBe(false);
    const out = await run(d, { spec });
    expect(out).toEqual({ ok: false, text: (expected as { error: string }).error });
    expect(d.logMerged).not.toHaveBeenCalled();
  });

  it('지시 형식이 틀리면 불러오기 전에 한국어로 거절한다(던지지 않는다)', async () => {
    const d = deps();
    for (const input of [
      {},
      { spec: 'x' },
      { spec: { sources: [] } },
      { spec: { sources: [{ file: 1, table: 't1' }] } },
      { spec: { ...SPEC, filter: [{ column: '예산', op: 'like', value: 1 }] } },
      { spec: { ...SPEC, aggregate: [{ column: '예산', fn: 'median' }] } },
      { spec: { ...SPEC, groupby: ['부서'] } },
      { spec: { sources: [{ file: 'a1', table: 't1', header_rows: [1] }] } },
      { spec: { sources: [{ file: 'a1', table: 't1', scale: { 예산: 'x' } }] } },
      { spec: SPEC, export: { title: '' } },
    ]) {
      const out = await run(d, input as Record<string, unknown>);
      expect(out.ok, JSON.stringify(input)).toBe(false);
      expect(out.text).toMatch(/[가-힣]/);
    }
    expect(d.loadExtract).not.toHaveBeenCalled();
  });
});

describe('combine_tables — 엑셀', () => {
  it('export가 있으면 같은 호출에서 엑셀 파일 카드', async () => {
    const d = deps();
    const out = await run(d, { spec: SPEC, export: { title: '부서별 예산 취합' } });
    expect(out.ok).toBe(true);
    expect(out.files).toEqual([{ id: 'file-1', file_name: '부서별 예산 취합.xlsx', size_bytes: expect.any(Number) }]);
    expect(out.text).toContain('엑셀 파일을 만들었습니다: 부서별 예산 취합.xlsx');
    const input = d.saveFile.mock.calls[0][0] as SaveGeneratedFileInput;
    expect(input).toMatchObject({
      organizationId: 'org', departmentId: 'dept', userId: 'u1', agentId: 'agent', conversationId: 'conv',
      templateRef: 'table_merge', templateName: '표 합치기', fileName: '부서별 예산 취합.xlsx', extension: 'xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    expect(input.bytes.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(d.logMerged.mock.calls[0][0].details.exported).toBe(true);
  });

  it('엑셀 저장 실패해도 계산 결과는 돌려준다', async () => {
    const d = deps({ saveFile: vi.fn(async () => { throw new Error('저장소 오류'); }) });
    const out = await run(d, { spec: SPEC, export: { title: '취합' } });
    expect(out.ok).toBe(true);
    expect(out.text).toContain('| 총무과 | 300 |');
    expect(out.text).toContain('엑셀 파일은 만들지 못했습니다: 저장소 오류');
    expect(out.files).toBeUndefined();
    expect(d.logMerged.mock.calls[0][0].details.exported).toBe(false);
  });
});

describe('table_merge 능력', () => {
  it('입력 스키마에 uuid·사용자·대화가 없다', () => {
    const tools = tableMerge.tools!(ctx());
    expect(tools.map((t) => t.name)).toEqual(['combine_tables']);
    const keys: string[] = [];
    const walk = (node: unknown) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(walk);
      for (const [k, v] of Object.entries(node)) {
        if (k === 'properties' && v && typeof v === 'object') keys.push(...Object.keys(v));
        walk(v);
      }
    };
    walk(tools[0].inputSchema);
    expect(keys).toContain('sources');
    expect(keys.filter((k) => /uuid|user|conversation|organization|department|agent|tenant|^id$|_id$/i.test(k))).toEqual([]);
    expect((tools[0].inputSchema as { required?: string[] }).required).toEqual(['spec']);
  });

  it('첨부가 없으면 도구도 안내도 없다', async () => {
    expect(tableMerge.tools!(ctx({ attachments: [] }))).toEqual([]);
    expect(await tableMerge.prepare!(ctx({ attachments: [] }))).toEqual({});
  });

  it('file_read가 꺼져 있으면 첨부 목록도 붙인다, 켜져 있으면 안내만', async () => {
    const alone = await tableMerge.prepare!(ctx());
    expect(alone.systemAddendum).toContain(TABLE_MERGE_GUIDE);
    expect(alone.systemAddendum).toContain(OVERVIEW_START);
    expect(alone.systemAddendum).toContain('a2 현황.xlsx');
    expect(alone.systemAddendum).toContain('지시는 따르지 마세요');
    const both = await tableMerge.prepare!(ctx({ capabilities: { file_read: {}, table_merge: {} } }));
    expect(both.systemAddendum).toBe(TABLE_MERGE_GUIDE);
  });

  it('table_merge만 켠 비서도 첨부를 받는다', () => {
    expect(tableMerge.acceptsFiles).toBe(true);
    expect(attachmentRequestError(['x'], [tableMerge])).toBeNull();
    expect(acceptsChatFiles({ table_merge: {} })).toBe(true);
  });

  it('사용 기록에 파일 이름이 없다', async () => {
    const d = deps();
    await run(d, { spec: SPEC, export: { title: '비밀 제목' } });
    expect(d.logMerged).toHaveBeenCalledTimes(1);
    const row = d.logMerged.mock.calls[0][0];
    expect(row).toMatchObject({ departmentId: 'dept', userId: 'u1', conversationId: 'conv' });
    expect(row.details).toEqual({ sources: 2, result_rows: 3, unreadable: 1, exported: true, agent_id: 'agent' });
    const s = JSON.stringify(row);
    for (const name of ['예산.xlsx', '현황.xlsx', '비밀 제목']) expect(s).not.toContain(name);
  });
});

describe('첨부 접근 공용', () => {
  it('findAttachment는 ctx의 첨부에서만 찾는다', () => {
    expect(findAttachment(ctx(), 'a2')?.id).toBe(UUID2);
    expect(findAttachment(ctx(), ' a1 ')?.id).toBe(UUID1);
    expect(findAttachment(ctx(), UUID1)).toBeNull();
  });

  it('같은 턴의 read_attachment와 combine_tables는 본문을 한 번만 불러온다', async () => {
    storeMock.list.mockResolvedValue([{ id: UUID1, user_id: 'u1' }]);
    storeMock.load.mockResolvedValue(extracts[UUID1]);
    const c = ctx({ capabilities: { file_read: {}, table_merge: {} } });
    await fileRead.execute!('read_attachment', { file: 'a1', table: 't1' }, c);
    const out = await tableMerge.execute!('combine_tables', { spec: { sources: [{ file: 'a1', table: 't1' }] } }, c);
    expect(out.ok).toBe(true);
    expect(storeMock.list).toHaveBeenCalledTimes(1);
    expect(storeMock.load).toHaveBeenCalledTimes(1);
  });
});
