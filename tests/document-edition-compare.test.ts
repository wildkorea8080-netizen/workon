import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import type { ActorScope } from '@/lib/agent-permissions';
import { AttachmentReadError } from '@/lib/attachments/reader';
import { MAX_UPLOAD_BYTES } from '@/lib/file-types';
import {
  compareDocumentEditions,
  type CompareDeps,
  type CompareDocumentRow,
} from '@/lib/document-edition-compare';

/** 신구 대비 라우트의 권한·행 확인·원본 읽기(2026-11-05). 대조 규칙은 edition-compare.test.ts */

const ORG = 'org-1';
const AGENT = 'agent-1';
const actor: ActorScope = {
  userId: 'u1',
  isAdmin: true,
  departmentId: 'd1',
  organizationId: ORG,
  visibleDepartmentIds: ['d1'],
  managedDepartmentIds: ['d1'],
  managesWholeOrganization: false,
};

function row(over: Partial<CompareDocumentRow>): CompareDocumentRow {
  return {
    id: 'x',
    agent_id: AGENT,
    department_id: 'd1',
    organization_id: ORG,
    visibility: 'organization',
    storage_path: `p/${over.id ?? 'x'}`,
    file_name: '여비규정.hwpx',
    title: null,
    replaces_id: null,
    effective_from: null,
    noda_status: 'ready',
    retired_at: null,
    created_at: '2026-11-01T00:00:00Z',
    ...over,
  };
}

const OLD = row({ id: 'old', noda_status: 'retired', retired_at: '2026-11-02T00:00:00Z', title: '여비 규정(2025)' });
const NEW = row({ id: 'new', replaces_id: 'old', effective_from: '2026-01-01', title: '여비 규정(2026)' });
const TEXT: Record<string, string> = { 'p/old': '제2조(일비) 일비는 20,000원\n부칙', 'p/new': '제2조(일비) 일비는 25,000원\n부칙' };

function deps(rows: CompareDocumentRow[], over: Partial<CompareDeps> = {}): CompareDeps {
  return {
    loadRow: vi.fn(async (id: string, org: string) => rows.find((r) => r.id === id && r.organization_id === org) ?? null),
    download: vi.fn(async (path: string) => (TEXT[path] ? new TextEncoder().encode(TEXT[path]) : null)),
    read: vi.fn(async (bytes: Buffer) => ({ kind: 'document' as const, text: bytes.toString('utf8'), tables: [], warnings: [] })),
    ...over,
  };
}

describe('두 판 비교', () => {
  it('새 판과 그 옛 판을 맞대고 이름·시행일·상태를 돌려준다', async () => {
    const out = await compareDocumentEditions('new', actor, deps([OLD, NEW]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.old).toMatchObject({ id: 'old', name: '여비 규정(2025)', status: 'retired' });
    expect(out.data.new).toMatchObject({ id: 'new', name: '여비 규정(2026)', effective_from: '2026-01-01' });
    expect(out.data.comparison.stats.changed).toBe(1);
    // 저장소 경로는 응답에 싣지 않는다
    expect(JSON.stringify(out.data)).not.toContain('p/old');
  });

  it('제목이 없으면 파일 이름으로 보인다', async () => {
    const out = await compareDocumentEditions('new', actor, deps([{ ...OLD, title: null }, NEW]));
    expect(out.ok && out.data.old.name).toBe('여비규정.hwpx');
  });

  it('바꾼 옛 판이 없으면 409', async () => {
    const out = await compareDocumentEditions('old', actor, deps([OLD, NEW]));
    expect(out).toMatchObject({ ok: false, status: 409 });
  });

  it('다른 기관·볼 수 없는 문서는 있는지도 알리지 않는다(404)', async () => {
    expect(await compareDocumentEditions('new', actor, deps([OLD, { ...NEW, organization_id: 'org-2' }]))).toMatchObject({ status: 404 });
    expect(
      await compareDocumentEditions('new', actor, deps([OLD, { ...NEW, visibility: 'department', department_id: 'other' }]))
    ).toMatchObject({ status: 404 });
    // 옛 판만 볼 수 없어도 맞대지 않는다
    expect(
      await compareDocumentEditions('new', actor, deps([{ ...OLD, visibility: 'department', department_id: 'other' }, NEW]))
    ).toMatchObject({ status: 404, message: '옛 판을 찾을 수 없습니다.' });
  });

  it('기관을 모르면 아무것도 읽지 않는다', async () => {
    const d = deps([OLD, NEW]);
    expect(await compareDocumentEditions('new', { ...actor, organizationId: null }, d)).toMatchObject({ status: 403 });
    expect(d.loadRow).not.toHaveBeenCalled();
  });

  it('다른 비서의 문서끼리는 맞대지 않는다', async () => {
    const out = await compareDocumentEditions('new', actor, deps([{ ...OLD, agent_id: 'agent-2' }, NEW]));
    expect(out).toMatchObject({ status: 409 });
  });

  it('원본이 없거나 너무 크면 읽지 않는다', async () => {
    expect(await compareDocumentEditions('new', actor, deps([{ ...OLD, storage_path: null }, NEW]))).toMatchObject({ status: 404 });
    expect(
      await compareDocumentEditions('new', actor, deps([{ ...OLD, storage_path: 'p/none' }, NEW]))
    ).toMatchObject({ status: 404, message: '옛 판의 원본 파일을 찾을 수 없습니다.' });
    const big = deps([OLD, NEW], { download: vi.fn(async () => new Uint8Array(MAX_UPLOAD_BYTES + 1)) });
    expect(await compareDocumentEditions('new', actor, big)).toMatchObject({ status: 413 });
    expect(big.read).not.toHaveBeenCalled();
  });

  it('읽지 못한 판은 어느 판인지와 이유를 알린다', async () => {
    const d = deps([OLD, NEW], {
      read: vi.fn(async (bytes: Buffer) => {
        if (bytes.toString('utf8').includes('25,000')) throw new AttachmentReadError('파일에서 읽을 글이 없습니다.');
        return { kind: 'document' as const, text: 'x', tables: [], warnings: [] };
      }),
    });
    expect(await compareDocumentEditions('new', actor, d)).toEqual({
      ok: false,
      status: 422,
      message: '새 판을 읽지 못했습니다: 파일에서 읽을 글이 없습니다.',
    });
  });

  it('읽기 경고는 판을 붙여 싣는다', async () => {
    const d = deps([OLD, NEW], {
      read: vi.fn(async (bytes: Buffer) => ({
        kind: 'document' as const,
        text: bytes.toString('utf8'),
        tables: [],
        warnings: bytes.toString('utf8').includes('20,000') ? ['글자 인식(OCR)으로 읽었습니다'] : [],
      })),
    });
    const out = await compareDocumentEditions('new', actor, d);
    expect(out.ok && out.data.warnings).toEqual(['옛 판: 글자 인식(OCR)으로 읽었습니다']);
  });
});

describe('라우트', () => {
  const src = readFileSync('src/app/api/documents/[id]/compare/route.ts', 'utf8');

  it('로그인·기관 확인 뒤 기관으로 한정해 행을 읽는다', () => {
    expect(src).toContain('getServerAuthSession');
    expect(src).toContain('getActorScope');
    expect(src).toContain(".eq('organization_id', organizationId)");
  });

  it('스캔 PDF를 읽을 시간을 둔다', () => {
    expect(src).toContain('export const maxDuration = 300');
  });
});

describe('화면', () => {
  it('바꾼 옛 판이 목록에 있는 새 판에만 비교 단추를 단다', async () => {
    const { canCompareWithPrevious } = await import('@/components/admin/DocumentsManager');
    const docs = [{ id: 'old' }, { id: 'new', replaces_id: 'old' }, { id: 'orphan', replaces_id: 'gone' }] as any[];
    expect(canCompareWithPrevious(docs[1], docs)).toBe(true);
    expect(canCompareWithPrevious(docs[0], docs)).toBe(false);
    expect(canCompareWithPrevious(docs[2], docs)).toBe(false);
  });

  it('바뀐 곳 요약', async () => {
    const { compareSummary } = await import('@/lib/edition-compare');
    expect(compareSummary({ same: 3, changed: 2, removed: 0, added: 1 })).toBe('고친 문단 2개 · 새 문단 1개');
    expect(compareSummary({ same: 3, changed: 0, removed: 0, added: 0 })).toBe('바뀐 문단이 없습니다');
  });

  it('비교 창은 서버 설정을 가져오지 않고 대조 결과의 타입만 쓴다', () => {
    const ui = readFileSync('src/components/admin/EditionCompareModal.tsx', 'utf8');
    expect(ui).toContain("from '@/lib/edition-compare'");
    expect(ui).not.toContain('document-edition-compare');
    expect(ui).not.toContain('@/lib/config');
  });
});

describe('실제 한글 파일', () => {
  it('두 HWPX를 실제 첨부 읽기로 읽어 바뀐 문단만 짚는다', async () => {
    const { priorFixture } = await import('./helpers/prior-fixture');
    const base = { 제목: '출장 여비 지급 기준', 개요: '일비는 1일 20,000원으로 한다.', '주요 내용': '숙박비는 실비로 지급한다.' };
    const oldBytes = await priorFixture(base);
    const newBytes = await priorFixture({ ...base, 개요: '일비는 1일 25,000원으로 한다.', '향후 계획': '교통비 기준을 새로 정한다.' });
    const files: Record<string, Buffer> = { 'p/old': oldBytes, 'p/new': newBytes };
    const out = await compareDocumentEditions('new', actor, {
      loadRow: async (id) => [OLD, NEW].find((r) => r.id === id) ?? null,
      download: async (p) => files[p] ?? null,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const { rows, stats } = out.data.comparison;
    const changed = rows.find((r) => r.kind === 'changed');
    expect(changed?.kind === 'changed' && changed.new.filter((p) => p.changed).map((p) => p.text)).toEqual(['25']);
    expect(rows.some((r) => r.kind === 'added' && r.new.includes('교통비 기준'))).toBe(true);
    expect(stats.removed).toBe(0);
  });
});
