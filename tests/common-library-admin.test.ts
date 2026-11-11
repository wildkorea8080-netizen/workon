import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { ADMIN_COMMON_COLUMNS, adminCommonList, type CommonLibraryRow } from '@/lib/common-library-admin';

/** 기관 관리자가 보는 공통 기준 문서(2026-11-06) — 대화와 같은 규칙으로 '지금 근거로 쓰는' 현재 판만, 읽기만 */
const read = (p: string) => readFileSync(p, 'utf8');

function row(over: Partial<CommonLibraryRow>): CommonLibraryRow {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    org_type: '공공기관',
    title: '예산편성기준',
    edition_year: 2026,
    usage_terms: '공공누리 1유형 · 2026-10-25 확인',
    file_name: '예산편성기준.pdf',
    size_bytes: 2048,
    noda_status: 'ready',
    retired_at: null,
    replaces_id: null,
    created_at: '2026-10-25T15:30:00Z',
    ...over,
  };
}

describe('공통 기준 문서 목록', () => {
  it('기관 유형이 없거나 표 밖이면 빈 목록', () => {
    expect(adminCommonList(null, [row({})])).toEqual({ orgType: null, documents: [], pendingCount: 0 });
    expect(adminCommonList('없는 유형', [row({})]).orgType).toBeNull();
  });

  it('근거로 쓰는 현재 판만 — 읽는 중·실패는 개수로, 지난 판·지우는 중은 셈에서 뺌', () => {
    const list = adminCommonList('공공기관', [
      row({ id: 'a0000000-0000-0000-0000-000000000001', title: '회계기준' }),
      row({ id: 'a0000000-0000-0000-0000-000000000002', noda_status: 'reading' }),
      row({ id: 'a0000000-0000-0000-0000-000000000003', noda_status: 'failed' }),
      row({ id: 'a0000000-0000-0000-0000-000000000004', noda_status: 'retired', retired_at: '2026-10-01T00:00:00Z' }),
      row({ id: 'a0000000-0000-0000-0000-000000000005', noda_status: 'deleting' }),
    ]);
    expect(list.documents.map((d) => d.title)).toEqual(['회계기준']);
    expect(list.pendingCount).toBe(2);
  });

  it('ready 새 판이 대신하는 옛 판은 근거가 아니다(판 바뀌는 중 — 개수로)', () => {
    const oldId = 'b0000000-0000-0000-0000-000000000001';
    const list = adminCommonList('공공기관', [
      row({ id: oldId, edition_year: 2025 }),
      row({ id: 'b0000000-0000-0000-0000-000000000002', edition_year: 2026, replaces_id: oldId }),
    ]);
    expect(list.documents.map((d) => d.editionYear)).toEqual([2026]);
    expect(list.pendingCount).toBe(1);
  });

  it('이름 순(같으면 새 연도 먼저), 내보내는 칸은 표시용뿐', () => {
    const list = adminCommonList('공공기관', [
      row({ id: 'c0000000-0000-0000-0000-000000000001', title: '회계기준', edition_year: 2026 }),
      row({ id: 'c0000000-0000-0000-0000-000000000002', title: '경영평가 편람', edition_year: 2025 }),
      row({ id: 'c0000000-0000-0000-0000-000000000003', title: '경영평가 편람', edition_year: 2026 }),
    ]);
    expect(list.documents.map((d) => `${d.title}${d.editionYear}`)).toEqual(['경영평가 편람2026', '경영평가 편람2025', '회계기준2026']);
    expect(Object.keys(list.documents[0]).sort()).toEqual(['createdAt', 'editionYear', 'fileName', 'hasPreviousEdition', 'id', 'sizeBytes', 'title', 'usageTerms']);
  });

  it('저장소 경로·NODA 칸은 읽지도 않는다', () => {
    expect(ADMIN_COMMON_COLUMNS).not.toMatch(/storage_path|noda_filename|noda_doc_id|noda_reason|uploaded_by/);
  });
});

describe('공통 기준 문서 라우트·화면', () => {
  it('관리자만, 요청자 기관의 유형으로만 고르고 현재 판만 읽는다', () => {
    const route = read('src/app/api/admin/common-documents/route.ts');
    expect(route).toContain("if (!isAdminSession(session)) return jsonError('관리자 권한이 필요합니다.', 403);");
    expect(route).toContain(".eq('org_type', orgType).is('retired_at', null)");
    expect(route).toContain(".eq('id', actor.organizationId)");
    expect(route).not.toMatch(/searchParams|request\.json/);
  });

  it('화면은 읽기만 — 원본은 대화 근거 창과 같은 주소(같은 유형 권한), 새 탭은 noopener', () => {
    const panel = read('src/components/admin/CommonLibraryPanel.tsx');
    expect(panel).toContain('/api/common-documents/${encodeURIComponent(d.id)}/original');
    expect(panel).toContain('rel="noopener noreferrer"');
    expect(panel).not.toMatch(/method:\s*'(POST|DELETE|PATCH|PUT)'/);
    expect(read('src/app/admin/documents/page.tsx')).toContain('<CommonLibraryPanel />');
  });
});
