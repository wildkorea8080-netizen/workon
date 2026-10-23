import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { MAX_AGENT_DOCUMENTS } from '@/lib/file-types';
import { nodaFilename } from '@/lib/noda';
import type { ActorScope, AgentAccessInfo } from '@/lib/agent-permissions';

/**
 * 참고 문서 직접 올리기 (S4-a Task 3) — 주소 발급·확인에 쓰이는 검사와 행 만들기.
 * DB·저장소를 거치는 부분은 가짜로 바꾸고, 판정과 행 모양을 고정한다.
 */

// 개수 세기가 읽는 행 — 테스트가 바꾼다
let existingRows: { agent_id: string }[] = [];
let countError: { message: string } | null = null;
const inCalls: { column: string; values: string[] }[] = [];

vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        in: (column: string, values: string[]) => {
          inCalls.push({ column, values });
          return Promise.resolve({ data: existingRows, error: countError });
        },
      }),
    }),
    storage: { from: () => ({}) },
  },
}));

const loadAgentAccess = vi.fn();
vi.mock('@/lib/agent-store', () => ({
  loadAgentAccess: (id: string) => loadAgentAccess(id),
  recordAgentEvent: vi.fn(),
  enableAgentCapability: vi.fn(),
}));

import {
  DOCUMENT_CONFIRM_WINDOW_MS,
  buildNewDocumentRows,
  checkUploadFile,
  checkUploadTargets,
  documentStoragePath,
  isOrganizationSuspended,
  ORG_SUSPENDED_UPLOAD_MESSAGE,
  parseDocumentStoragePath,
} from '@/lib/document-upload';

const ORG = 'org-1';

function actor(over: Partial<ActorScope> = {}): ActorScope {
  return {
    userId: 'u-1', isAdmin: true, departmentId: 'PLAN', organizationId: ORG,
    visibleDepartmentIds: ['PLAN', 'TOP'], managedDepartmentIds: ['PLAN', 'BUDGET'],
    managesWholeOrganization: true, ...over,
  };
}

function agent(over: Partial<AgentAccessInfo>): AgentAccessInfo {
  return {
    id: 'a1', tier: 'official', department_id: 'PLAN', organization_id: ORG,
    visibility: 'organization', owner_id: null, created_by: null,
    is_active: true, is_published: true, deleted_at: null, approval_status: null,
    version: 1, approval_version: null, ...over,
  };
}

beforeEach(() => {
  existingRows = [];
  countError = null;
  inCalls.length = 0;
  loadAgentAccess.mockReset();
});

describe('checkUploadFile', () => {
  it('위험한 이름·막는 확장자·허용 밖 형식·20MB 초과를 거른다', () => {
    expect(checkUploadFile({ fileName: '../a.pdf', size: 1, mimeType: 'application/pdf' })).toMatchObject({ ok: false, status: 400, securityReason: 'dangerous_filename' });
    expect(checkUploadFile({ fileName: 'a.exe', size: 1, mimeType: '' })).toMatchObject({ ok: false, status: 415 });
    expect(checkUploadFile({ fileName: 'a.pdf', size: 20 * 1024 * 1024 + 1, mimeType: 'application/pdf' })).toMatchObject({ ok: false, status: 413 });
    expect(checkUploadFile({ fileName: '2026 예산(최종).CSV', size: 10, mimeType: 'text/csv' })).toEqual({ ok: true, ext: 'csv' });
    expect(checkUploadFile({ fileName: '메모.txt', size: 10, mimeType: 'text/plain' })).toMatchObject({ ok: true });
  });

  it('문구는 지운 업로드 라우트와 같다', () => {
    const bad = checkUploadFile({ fileName: 'a.exe', size: 1, mimeType: '' });
    expect(bad).toMatchObject({ message: expect.stringContaining('지원되지 않는 파일 형식입니다.') });
    expect(checkUploadFile({ fileName: 'a.pdf', size: 21 * 1024 * 1024, mimeType: '' })).toMatchObject({
      message: '파일 크기가 너무 큽니다. 최대 20MB까지 업로드할 수 있습니다.',
    });
    expect(checkUploadFile({ fileName: '-a.pdf', size: 1, mimeType: '' })).toMatchObject({
      message: '유효하지 않은 파일명입니다.',
    });
  });

  it('확장자가 허용 형식이어야 한다 — MIME만 맞아도 안 된다(NODA는 확장자로 읽는 방식을 정한다)', () => {
    for (const fileName of ['문서', '문서.', 'report.pdf.bin']) {
      expect(checkUploadFile({ fileName, size: 10, mimeType: 'application/pdf' })).toMatchObject({
        ok: false,
        status: 415,
        message: expect.stringContaining('지원되지 않는 파일 형식입니다.'),
      });
    }
    expect(checkUploadFile({ fileName: '규정.PDF', size: 10, mimeType: '' })).toEqual({ ok: true, ext: 'pdf' });
  });

  it('크기는 정수여야 한다', () => {
    expect(checkUploadFile({ fileName: 'a.pdf', size: Number.NaN, mimeType: '' })).toMatchObject({ ok: false, status: 400 });
    expect(checkUploadFile({ fileName: 'a.pdf', size: -1, mimeType: '' })).toMatchObject({ ok: false, status: 400 });
    expect(checkUploadFile({ fileName: 'a.pdf', size: 1.5, mimeType: '' })).toMatchObject({ ok: false, status: 400 });
  });
});

describe('저장소 경로', () => {
  it('부서·사용자·발급 시각을 담고 다시 읽힌다', () => {
    const p = documentStoragePath({ departmentId: 'd', userId: 'u', ext: 'pdf', now: 1700000000000, id: 'x' });
    expect(p).toBe('documents/d/u/1700000000000-x.pdf');
    expect(parseDocumentStoragePath(p)).toEqual({ departmentId: 'd', userId: 'u', issuedAt: 1700000000000, ext: 'pdf' });
    expect(parseDocumentStoragePath('documents/d/1700000000000-x.pdf')).toBeNull(); // 옛 경로
    expect(parseDocumentStoragePath('chat-uploads/o/u/x.pdf')).toBeNull();
  });

  it('거슬러 올라가는 조각·이상한 확장자는 읽지 않는다', () => {
    expect(parseDocumentStoragePath('documents/../u/1700000000000-x.pdf')).toBeNull();
    expect(parseDocumentStoragePath('documents/d/u/1700000000000-x.pdf/../../y')).toBeNull();
    expect(parseDocumentStoragePath('documents/d/u/1700000000000-x.')).toBeNull();
  });

  it('경로를 만들 때 조각에 슬래시가 있으면 던진다', () => {
    expect(() => documentStoragePath({ departmentId: 'a/b', userId: 'u', ext: 'pdf', now: 1, id: 'x' })).toThrow();
  });
});

describe('buildNewDocumentRows', () => {
  it('모두 같은 키 집합 · reading · 행마다 다른 NODA 파일 이름(원래 이름 그대로)', () => {
    const official = agent({ id: 'a1', tier: 'official', department_id: 'PLAN' });
    const dept = agent({ id: 'a2', tier: 'department', department_id: 'BUDGET', visibility: 'department' });
    const fileName = '2026 예산(최종).CSV';
    const now = new Date('2026-10-23T00:00:00Z');
    const rows = buildNewDocumentRows({
      ids: ['id-1', 'id-2'],
      agentIds: ['a1', 'a2'],
      targets: new Map([['a1', official], ['a2', dept]]),
      departmentId: 'PLAN',
      userId: 'u-1',
      storagePath: 'documents/PLAN/u-1/1-x.csv',
      fileName,
      fileType: 'text/csv',
      title: '예산',
      visibility: 'organization',
      now,
    });

    expect(rows).toHaveLength(2);
    expect(Object.keys(rows[0]).sort()).toEqual(Object.keys(rows[1]).sort());
    expect(rows[0].noda_filename).toBe(`id-1__${fileName}`);
    expect(rows[1].noda_filename).toBe(nodaFilename('id-2', fileName));
    expect(rows[0].noda_filename).not.toBe(rows[1].noda_filename);
    expect(String(rows[0].noda_filename).endsWith('.CSV')).toBe(true);
    for (const r of rows) {
      expect(r).toMatchObject({
        noda_status: 'reading',
        noda_read_started_at: now.toISOString(),
        noda_last_attempt_at: null,
        noda_reason: null,
        summary: null,
        metadata: {},
        embedding: null,
        uploaded_by: 'u-1',
        storage_path: 'documents/PLAN/u-1/1-x.csv',
        file_name: fileName,
        title: '예산',
      });
    }
    expect(rows[0]).toMatchObject({ id: 'id-1', agent_id: 'a1', visibility: 'organization', department_id: 'PLAN' });
    // 부서 비서에 붙인 문서는 그 비서의 부서 안에 둔다 — 올리는 사람이 기관 전체를 골라도 따르지 않는다
    expect(rows[1]).toMatchObject({ id: 'id-2', agent_id: 'a2', visibility: 'department', department_id: 'BUDGET' });
  });

  it('공식 비서에 부서 공개를 고르면 따른다', () => {
    const rows = buildNewDocumentRows({
      ids: ['i'], agentIds: ['a1'], targets: new Map([['a1', agent({})]]),
      departmentId: 'PLAN', userId: 'u', storagePath: 'p', fileName: 'a.pdf', fileType: null,
      title: 'a', visibility: 'department', now: new Date(0),
    });
    expect(rows[0]).toMatchObject({ visibility: 'department', file_type: null });
  });
});

describe('checkUploadTargets', () => {
  it('고른 비서를 전부 검사한다 — 뒤에 붙은 남의 비서도', async () => {
    loadAgentAccess.mockImplementation(async (id: string) =>
      id === 'mine' ? agent({ id: 'mine' }) : agent({ id: 'theirs', organization_id: 'other-org' }));
    const r = await checkUploadTargets(['mine', 'theirs'], actor());
    expect(r).toMatchObject({ ok: false, status: 403, message: '문서를 붙일 권한이 없는 비서가 포함돼 있습니다.' });
    expect(loadAgentAccess).toHaveBeenCalledWith('theirs');
  });

  it('같은 id는 한 번만 센다', async () => {
    loadAgentAccess.mockImplementation(async (id: string) => agent({ id }));
    const r = await checkUploadTargets(['a1', 'a1', 'a2'], actor());
    expect(r).toMatchObject({ ok: true, agentIds: ['a1', 'a2'] });
    expect(loadAgentAccess).toHaveBeenCalledTimes(2);
    expect(inCalls[0]).toEqual({ column: 'agent_id', values: ['a1', 'a2'] });
  });

  it('비었거나 문자열이 아니면 400', async () => {
    expect(await checkUploadTargets([], actor())).toMatchObject({ ok: false, status: 400, message: '에이전트를 하나 이상 선택해주세요.' });
    expect(await checkUploadTargets(undefined, actor())).toMatchObject({ ok: false, status: 400 });
    expect(await checkUploadTargets([1], actor())).toMatchObject({ ok: false, status: 400 });
  });

  it('비서당 개수 상한 — 하나라도 가득 차면 거절', async () => {
    loadAgentAccess.mockImplementation(async (id: string) => agent({ id }));
    existingRows = Array.from({ length: MAX_AGENT_DOCUMENTS }, () => ({ agent_id: 'a2' }));
    const r = await checkUploadTargets(['a1', 'a2'], actor());
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect((r as { message: string }).message).toContain(`${MAX_AGENT_DOCUMENTS}개`);
  });

  it('세는 데 실패하면 막지 않는다', async () => {
    loadAgentAccess.mockImplementation(async (id: string) => agent({ id }));
    countError = { message: 'boom' };
    existingRows = Array.from({ length: MAX_AGENT_DOCUMENTS }, () => ({ agent_id: 'a1' }));
    expect(await checkUploadTargets(['a1'], actor())).toMatchObject({ ok: true });
  });
});

describe('라우트 원본', () => {
  it('확인은 발급 창·경로 읽기·크기 상한을 쓴다', () => {
    const src = readFileSync('src/app/api/documents/confirm/route.ts', 'utf8');
    expect(src).toContain('DOCUMENT_CONFIRM_WINDOW_MS');
    expect(src).toContain('parseDocumentStoragePath');
    expect(src).toContain('MAX_UPLOAD_BYTES');
  });

  it('읽기 라우트는 최대 300초', () => {
    const src = readFileSync('src/app/api/documents/[id]/read/route.ts', 'utf8');
    expect(src).toContain('maxDuration = 300');
  });

  it('확인 창은 10분', () => {
    expect(DOCUMENT_CONFIRM_WINDOW_MS).toBe(600_000);
  });

  it('옛 업로드 라우트는 없다', () => {
    expect(() => readFileSync('src/app/api/upload/route.ts', 'utf8')).toThrow();
  });
});

describe('정지된 기관은 문서를 올리지 못한다 (판정 D)', () => {
  it('status가 suspended면 true, 그 밖·기관 없음·조회 실패는 false(checkTokenLimit과 같이 막지 않음)', async () => {
    expect(await isOrganizationSuspended(ORG, async () => 'suspended')).toBe(true);
    expect(await isOrganizationSuspended(ORG, async () => 'active')).toBe(false);
    expect(await isOrganizationSuspended(ORG, async () => null)).toBe(false);
    expect(await isOrganizationSuspended(null, async () => 'suspended')).toBe(false);
    expect(await isOrganizationSuspended(ORG, async () => { throw new Error('db down'); })).toBe(false);
  });

  it('문구는 정한 그대로', () => {
    expect(ORG_SUSPENDED_UPLOAD_MESSAGE).toBe('기관 이용이 정지되어 문서를 올릴 수 없습니다. 기관 관리자에게 문의하세요.');
  });

  it.each(['src/app/api/documents/upload-url/route.ts', 'src/app/api/documents/confirm/route.ts'])(
    '%s는 기관 정지를 보고 403으로 거절한다 — 주소 발급·행 만들기 전에',
    (path) => {
      const route = readFileSync(path, 'utf8');
      const at = route.indexOf('isOrganizationSuspended(actor.organizationId)');
      expect(at).toBeGreaterThan(-1);
      expect(route).toMatch(/isOrganizationSuspended\(actor\.organizationId\)\)\s*\{?\s*return jsonError\(ORG_SUSPENDED_UPLOAD_MESSAGE, 403\)/);
      for (const later of ['createSignedUploadUrl(', ".from('documents').insert("]) {
        const i = route.indexOf(later);
        if (i > -1) expect(at).toBeLessThan(i);
      }
    }
  );
});
