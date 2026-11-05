import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { compareCommonEditions, commonSide, type CommonCompareRow } from '@/lib/common-edition-compare';
import { compareEndpoint } from '@/components/admin/EditionCompareModal';

/** 공통 자료실 두 판 비교(2026-11-05) — 원본 읽기·대조는 비서 문서와 같은 compareEditionFiles */

function row(over: Partial<CommonCompareRow>): CommonCompareRow {
  return {
    id: 'x',
    org_type: '지방공기업',
    title: '예산편성기준',
    edition_year: 2026,
    file_name: '예산편성기준.pdf',
    storage_path: `common/${over.id ?? 'x'}`,
    replaces_id: null,
    noda_status: 'ready',
    retired_at: null,
    created_at: null,
    ...over,
  };
}

const OLD = row({ id: 'old', edition_year: 2025, noda_status: 'retired', retired_at: '2026-01-02T00:00:00Z' });
const NEW = row({ id: 'new', replaces_id: 'old' });
const TEXT: Record<string, string> = { 'common/old': '1. 인건비 인상률 2.5%', 'common/new': '1. 인건비 인상률 3.0%' };

function deps(rows: CommonCompareRow[]) {
  return {
    loadRow: vi.fn(async (id: string) => rows.find((r) => r.id === id) ?? null),
    download: vi.fn(async (p: string) => (TEXT[p] ? new TextEncoder().encode(TEXT[p]) : null)),
    read: vi.fn(async (b: Buffer) => ({ kind: 'document' as const, text: b.toString('utf8'), tables: [], warnings: [] })),
  };
}

describe('공통 자료실 두 판 비교', () => {
  it('이름에 기준 연도를 붙여 두 판을 맞댄다', async () => {
    const out = await compareCommonEditions('new', deps([OLD, NEW]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.old).toMatchObject({ name: '예산편성기준(2025)', status: 'retired', effective_from: null });
    expect(out.data.new).toMatchObject({ name: '예산편성기준(2026)', status: 'ready' });
    const changed = out.data.comparison.rows.find((r) => r.kind === 'changed');
    expect(changed?.kind === 'changed' && changed.new.filter((p) => p.changed).map((p) => p.text)).toEqual(['3', '0']);
    expect(JSON.stringify(out.data)).not.toContain('common/old');
  });

  it('지난 판 표시는 retired_at으로도 본다', () => {
    expect(commonSide({ ...OLD, noda_status: 'deleting' }).status).toBe('retired');
  });

  it('바꾼 옛 판이 없으면 409, 옛 판이 없으면 404, 유형이 다르면 409', async () => {
    expect(await compareCommonEditions('old', deps([OLD, NEW]))).toMatchObject({ status: 409 });
    expect(await compareCommonEditions('new', deps([NEW]))).toMatchObject({ status: 404, message: '옛 판을 찾을 수 없습니다.' });
    expect(await compareCommonEditions('missing', deps([OLD, NEW]))).toMatchObject({ status: 404 });
    expect(await compareCommonEditions('new', deps([{ ...OLD, org_type: '공공기관' }, NEW]))).toMatchObject({ status: 409 });
  });

  it('원본이 없으면 읽지 않는다', async () => {
    const d = deps([{ ...OLD, storage_path: 'common/none' }, NEW]);
    expect(await compareCommonEditions('new', d)).toMatchObject({ status: 404, message: '옛 판의 원본 파일을 찾을 수 없습니다.' });
    expect(d.read).not.toHaveBeenCalled();
  });
});

describe('라우트·화면', () => {
  const route = readFileSync('src/app/api/super/common-documents/[id]/compare/route.ts', 'utf8');
  const page = readFileSync('src/app/super/common-library/page.tsx', 'utf8');

  it('슈퍼관리자만 — 첫 줄에서 막는다', () => {
    const at = route.indexOf('export async function GET');
    expect(route.slice(at, at + 200)).toContain('getSuperAdminFromRequest(request)');
  });

  it('엑셀은 같은 대조 뒤에 만든다', () => {
    expect(route.indexOf("get('format') === 'xlsx'")).toBeGreaterThan(route.indexOf('if (!outcome.ok)'));
    expect(route).toContain('compareXlsxHeaders(outcome.data.new.name)');
    expect(route).toContain('export const maxDuration = 300');
  });

  it('비교 창은 화면마다 주소만 다르다', () => {
    expect(compareEndpoint('common', 'abc')).toBe('/api/super/common-documents/abc/compare');
    expect(compareEndpoint('documents', 'abc')).toBe('/api/documents/abc/compare');
    expect(page).toContain("compareEndpoint('common', compareId)");
    // 바꾼 옛 판이 목록에 있는 새 판에만 단추
    expect(page).toContain('row.replaces_id && rows.some((r) => r.id === row.replaces_id)');
  });
});
