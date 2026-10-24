import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { buildAssignedDocumentRow, type AssignSourceDocument } from '@/lib/document-files';
import { nodaFilename } from '@/lib/noda';
import type { AgentAccessInfo } from '@/lib/agent-permissions';

/**
 * 문서 목록·삭제·붙이기 라우트 (S4-a Task 4).
 * 라우트를 실행하는 장치가 이 저장소에 없어 원본 글을 읽는다(agent-route-permissions.test.ts와 같은 방식).
 * 순서·조건의 동작은 document-reading.test.ts가 맡는다.
 */
const ORG = 'org-1';
const NOW = new Date('2026-10-23T00:00:00.000Z');

function target(over: Partial<AgentAccessInfo>): AgentAccessInfo {
  return {
    id: 'a1', tier: 'official', department_id: 'BUDGET', organization_id: ORG,
    visibility: 'organization', owner_id: null, created_by: null,
    is_active: true, is_published: true, deleted_at: null, approval_status: null,
    version: 1, approval_version: null, ...over,
  };
}

const source: AssignSourceDocument = {
  id: 'doc-1',
  department_id: 'TOP',
  organization_id: ORG,
  visibility: 'organization',
  uploaded_by: 'u-1',
  storage_path: 'documents/TOP/1-a.pdf',
  file_name: '2026 예산(최종).CSV',
  file_type: 'text/csv',
  title: '예산',
};

describe('붙인 행 (buildAssignedDocumentRow)', () => {
  it('새 id·자기 NODA 파일 이름·reading이고 키 집합이 같다', () => {
    const rows = [
      buildAssignedDocumentRow(source, target({ id: 'off' }), 'id-1', NOW),
      buildAssignedDocumentRow(source, target({ id: 'dep', tier: 'department' }), 'id-2', NOW),
      buildAssignedDocumentRow(source, target({ id: 'per', tier: 'personal' }), 'id-3', NOW),
    ];
    rows.forEach((row, i) => {
      const id = `id-${i + 1}`;
      expect(row.id).toBe(id);
      expect(row.noda_filename).toBe(nodaFilename(id, source.file_name));
      expect(String(row.noda_filename).endsWith('.CSV')).toBe(true);
      expect(row).toMatchObject({
        noda_status: 'reading',
        noda_read_started_at: NOW.toISOString(),
        noda_last_attempt_at: null,
        noda_reason: null,
        summary: null,
        metadata: {},
        embedding: null,
        storage_path: source.storage_path,
        file_name: source.file_name,
      });
    });
    expect(new Set(rows.map((r) => Object.keys(r).sort().join(','))).size).toBe(1);
    expect(Object.keys(rows[0])).not.toContain('organization_id');
  });

  it('원본의 NODA 칸·읽은 내용은 가져오지 않는다', () => {
    const polluted = { ...source, noda_filename: 'old__x.csv', noda_status: 'ready', summary: 's', metadata: { a: 1 } } as unknown as AssignSourceDocument;
    const row = buildAssignedDocumentRow(polluted, target({ id: 'off' }), 'id-9', NOW);
    expect(row.noda_filename).toBe(nodaFilename('id-9', source.file_name));
    expect(row.noda_status).toBe('reading');
    expect(row.summary).toBeNull();
    expect(row.metadata).toEqual({});
  });
});

describe('DELETE /api/documents', () => {
  const route = readFileSync('src/app/api/documents/route.ts', 'utf8');
  const del = route.slice(route.indexOf('export async function DELETE'));

  it('NODA → DB → 원본 순서', () => {
    const nodaAt = del.indexOf('noda.deleteDocument(');
    const dbAt = del.indexOf(".from('documents').delete()");
    const storageAt = del.indexOf('removeStorageFileIfUnused(');
    expect(nodaAt).toBeGreaterThan(-1);
    expect(nodaAt).toBeLessThan(dbAt);
    expect(dbAt).toBeLessThan(storageAt);
  });

  it('NODA에 간 적 있는 행만 NODA에 묻는다 (옛 행은 건너뜀)', () => {
    expect(del).toMatch(/doc\.agent_id && doc\.noda_filename && doc\.noda_status/);
    expect(del).toContain('nodaTenant(doc.agent_id)');
  });

  it('NODA 삭제가 실패하면 행을 지우지 않고 deleting', () => {
    expect(del).toContain("noda_status: 'deleting'");
    expect(route).toContain('문서 보관소에서 지우지 못했습니다. 잠시 뒤 다시 지워 주세요.');
    expect(del).toContain('NODA_DELETE_FAILED_MESSAGE');
    expect(del).toContain('status: 502');
    // 502로 돌려보내는 곳이 행 삭제보다 앞이다
    expect(del.indexOf('status: 502')).toBeLessThan(del.indexOf(".from('documents').delete()"));
    // 502를 돌려주기 전에 deleting 표시를 먼저 남기고, 그 오류를 확인한다
    expect(del.indexOf("noda_status: 'deleting'")).toBeLessThan(del.indexOf('status: 502'));
    expect(del).toContain('markError');
  });

  it('NODA 실패는 따로 둔 참거짓 표시로 가른다 — 던진 값이 비어도(throw undefined) 행을 지우지 않게', () => {
    expect(del).toContain('nodaFailed = true');
    expect(del).toContain('if (nodaFailed)');
    expect(del).not.toMatch(/if \(nodaError\)/);
  });

  it('권한 판정은 그대로다', () => {
    expect(del).toContain('canDeleteAgent(');
    expect(del).toContain('actor.managedDepartmentIds.includes(doc.department_id)');
  });

  it('지운 비서에 남은 문서는 그 부서를 관리하는 관리자가 지운다(canDeleteAgent는 지운 비서에 거짓)', () => {
    expect(del).toMatch(/agent\?\.deleted_at\s*\?\s*actor\.isAdmin && actor\.managedDepartmentIds\.includes\(doc\.department_id\)\s*:\s*Boolean\(agent\) && canDeleteAgent\(/);
  });
});

describe('GET /api/documents', () => {
  const route = readFileSync('src/app/api/documents/route.ts', 'utf8');
  const get = route.slice(route.indexOf('export async function GET'), route.indexOf('export async function DELETE'));

  it('reading 행을 맞추고 noda_status·noda_reason을 싣는다', () => {
    expect(get).toContain('reconcileReading(');
    for (const col of ['noda_status', 'noda_reason', 'noda_filename', 'noda_read_started_at', 'noda_last_attempt_at']) {
      expect(get).toContain(col);
    }
  });

  it('맞추기 실패는 목록을 막지 않는다', () => {
    expect(get).toMatch(/try \{[\s\S]*reconcileReading\([\s\S]*\} catch/);
  });

  it('범위는 visibilityFilter 그대로고, 맞춘 행에서 noda_filename은 화면에 내보내지 않는다', () => {
    expect(get).toContain('.or(visibleFilter)');
    expect(get).toMatch(/\{\s*noda_filename,[^}]*\.\.\.rest\s*\}\) => rest\)/);
  });
});

describe('POST /api/documents/assign', () => {
  const route = readFileSync('src/app/api/documents/assign/route.ts', 'utf8');

  it('새 행마다 새 id를 만들어 넘기고 documentIds를 돌려준다', () => {
    expect(route).toContain('crypto.randomUUID()');
    expect(route).toMatch(/buildAssignedDocumentRow\(src, targets\.get\(\w+\)!, crypto\.randomUUID\(\), now\)/);
    expect(route).toContain('documentIds');
  });
});
