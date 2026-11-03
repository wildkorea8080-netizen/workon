// tests/user-withdrawal.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';

/**
 * 슈퍼관리자 '계정 삭제' = 탈퇴 처리 (0047).
 * 행을 지우면 NO ACTION 외래 키에 막히고(23503), SET NULL로 풀면 사용 기록의 귀속이 사라진다.
 * 그래서 행은 남기고 로그인·개인 내용만 없앤다. 여기서는 순서와 실패 시 멈추는 지점을 본다.
 */

type DbError = { code?: string; message: string };
const steps: string[] = [];
const state = {
  user: null as null | Record<string, unknown>,
  loadError: null as null | DbError,
  convError: null as null | DbError,
  attachError: null as null | DbError,
  scheduleError: null as null | DbError,
  webhookError: null as null | DbError,
  webhookPatch: null as null | Record<string, unknown>,
  webhookFilters: [] as unknown[][],
  agents: [] as { id: string }[],
  stampError: null as null | DbError,
  stampedRows: [{ id: 'u1' }] as { id: string }[],
  authError: null as null | { message: string },
  softDeleteOk: true,
  updatePatch: null as null | Record<string, unknown>,
  updateFilters: [] as unknown[][],
  agentFilters: [] as unknown[][],
};
const logs: { level: string; message: string }[] = [];

vi.mock('@/lib/supabaseAdmin', () => {
  const builder = (table: string) => {
    let op = '';
    const filters: unknown[][] = [];
    const resolve = () => {
      if (table === 'users' && op === 'select') return { data: state.user, error: state.loadError };
      if (table === 'users' && op === 'update') {
        state.updateFilters = filters;
        return { data: state.stampError ? null : state.stampedRows, error: state.stampError };
      }
      if (table === 'conversations' && op === 'delete') return { error: state.convError };
      if (table === 'chat_attachments' && op === 'delete') return { error: state.attachError };
      if (table === 'app_schedules' && op === 'delete') return { error: state.scheduleError };
      if (table === 'app_webhooks' && op === 'update') { state.webhookFilters = filters; return { error: state.webhookError }; }
      if (table === 'agents' && op === 'select') {
        state.agentFilters = filters;
        return { data: state.agents, error: null };
      }
      return { data: null, error: null };
    };
    const q: Record<string, unknown> = {
      select(...args: unknown[]) {
        if (!op) { op = 'select'; steps.push(`${table}.select`); }
        return q;
      },
      update(patch: Record<string, unknown>) {
        op = 'update'; if (table === 'users') state.updatePatch = patch; else state.webhookPatch = patch; steps.push(`${table}.update`); return q;
      },
      delete() { op = 'delete'; steps.push(`${table}.delete`); return q; },
      eq(...args: unknown[]) { filters.push(['eq', ...args]); return q; },
      is(...args: unknown[]) { filters.push(['is', ...args]); return q; },
      maybeSingle: () => Promise.resolve(resolve()),
      then: (ok: (v: unknown) => unknown) => Promise.resolve(resolve()).then(ok),
    };
    return q;
  };
  return {
    supabaseAdmin: {
      from: (table: string) => builder(table),
      auth: {
        admin: {
          deleteUser: (id: string) => {
            steps.push(`auth.deleteUser:${id}`);
            return Promise.resolve({ error: state.authError });
          },
        },
      },
    },
  };
});

vi.mock('@/lib/generated-files', () => ({
  listUserFilePaths: async (id: string) => { steps.push(`listUserFilePaths:${id}`); return ['generated/o/c/f.hwpx']; },
  removeUserFiles: async (id: string, paths: string[]) => { steps.push(`removeUserFiles:${id}:${paths.join(',')}`); },
}));
vi.mock('@/lib/attachments/store', () => ({
  listUserAttachmentPaths: async (id: string) => { steps.push(`listUserAttachmentPaths:${id}`); return ['chat-uploads/o/u1/a.xlsx', 'chat-uploads/o/u1/a.json']; },
  removeUserAttachmentObjects: async (id: string, paths: string[]) => { steps.push(`removeUserAttachmentObjects:${id}:${paths.join(',')}`); },
}));

vi.mock('@/lib/agent-store', () => ({
  softDeleteAgent: async (id: string, actor: string) => { steps.push(`softDeleteAgent:${id}:${actor}`); return state.softDeleteOk; },
}));

vi.mock('@/lib/logger', () => ({
  logSystem: async (p: { level: string; message: string }) => { logs.push(p); },
}));

const { withdrawUser, withdrawnEmail, withdrawErrorMessage, canSignIn } = await import('@/lib/user-withdrawal');

beforeEach(() => {
  steps.length = 0;
  logs.length = 0;
  Object.assign(state, {
    user: { id: 'u1', email: 'kim@gov.kr', full_name: '김주무관', is_super_admin: false, deleted_at: null },
    loadError: null,
    convError: null,
    attachError: null,
    scheduleError: null,
    webhookError: null,
    webhookPatch: null,
    webhookFilters: [],
    agents: [{ id: 'a1' }],
    stampError: null,
    stampedRows: [{ id: 'u1' }],
    authError: null,
    softDeleteOk: true,
    updatePatch: null,
    updateFilters: [],
    agentFilters: [],
  });
});

describe('withdrawUser — 순서', () => {
  it('경로 수집(생성 파일·첨부) → 대화 삭제 → 안 묶인 첨부 행 삭제 → 앱 예약 삭제·연동 회수 → 개인 비서 → 행 도장 → 저장소 → Auth 순으로 간다', async () => {
    const r = await withdrawUser('u1', 'admin1');
    expect(r).toEqual({ ok: true, before: { email: 'kim@gov.kr', full_name: '김주무관' } });
    expect(steps).toEqual([
      'users.select',
      'listUserFilePaths:u1',
      'listUserAttachmentPaths:u1',
      'conversations.delete',
      'chat_attachments.delete',
      'app_schedules.delete',
      'app_webhooks.update',
      'agents.select',
      'softDeleteAgent:a1:admin1',
      'users.update',
      'removeUserFiles:u1:generated/o/c/f.hwpx',
      'removeUserAttachmentObjects:u1:chat-uploads/o/u1/a.xlsx,chat-uploads/o/u1/a.json',
      'auth.deleteUser:u1',
    ]);
  });

  it('안 묶인 첨부 행 삭제가 실패하면 500으로 멈추고 도장·저장소·Auth는 건드리지 않는다(다시 시도할 수 있게)', async () => {
    state.attachError = { message: 'down' };
    const r = await withdrawUser('u1', 'admin1');
    expect(r).toMatchObject({ ok: false, status: 500 });
    expect(steps).not.toContain('users.update');
    expect(steps.some((s) => s.startsWith('removeUserFiles') || s.startsWith('removeUserAttachmentObjects'))).toBe(false);
    expect(steps.some((s) => s.startsWith('auth.deleteUser'))).toBe(false);
  });

  it('앱 예약은 지우고(저장한 입력값이 개인 내용) 쓰는 앱 연동은 탈퇴 사유와 함께 회수한다(0050)', async () => {
    await withdrawUser('u1', 'admin1');
    expect(state.webhookPatch).toMatchObject({ status: 'revoked', revoked_reason: '계정 탈퇴로 회수했습니다.' });
    expect(typeof state.webhookPatch?.revoked_at).toBe('string');
    expect(state.webhookFilters).toEqual([['eq', 'user_id', 'u1'], ['eq', 'status', 'active']]);
  });

  it('앱 예약 삭제나 연동 회수가 실패하면 500으로 멈추고 도장은 찍지 않는다(다시 시도할 수 있게)', async () => {
    for (const key of ['scheduleError', 'webhookError'] as const) {
      steps.length = 0;
      state.scheduleError = null; state.webhookError = null;
      state[key] = { message: 'down' };
      expect(await withdrawUser('u1', 'admin1')).toMatchObject({ ok: false, status: 500 });
      expect(steps).not.toContain('users.update');
      expect(steps.some((s) => s.startsWith('auth.deleteUser'))).toBe(false);
    }
  });

  it('사용자 행을 지우지 않는다 — 도장만 찍는다', async () => {
    await withdrawUser('u1', 'admin1');
    expect(steps).not.toContain('users.delete');
    expect(state.updatePatch).toMatchObject({
      is_active: false,
      email: withdrawnEmail('u1'),
      favorite_agent_ids: [],
    });
    expect(typeof state.updatePatch?.deleted_at).toBe('string');
    // 이름·부서는 사용 기록의 귀속이라 건드리지 않는다
    expect(state.updatePatch).not.toHaveProperty('full_name');
    expect(state.updatePatch).not.toHaveProperty('department_id');
    // 아직 도장이 없는 행만 — 동시에 두 번 눌러도 한 번만
    expect(state.updateFilters).toContainEqual(['is', 'deleted_at', null]);
  });

  it('그 사람의 숨기지 않은 개인 비서만 고른다 — 부서·공식 비서는 기관 것이라 남긴다', async () => {
    await withdrawUser('u1', 'admin1');
    expect(state.agentFilters).toEqual([
      ['eq', 'owner_id', 'u1'],
      ['eq', 'tier', 'personal'],
      ['is', 'deleted_at', null],
    ]);
  });
});

describe('withdrawUser — 실패하면 멈춘다', () => {
  it('대화 삭제가 23503이면 409와 한국어 문장, 도장·저장소·Auth는 건드리지 않는다', async () => {
    state.convError = { code: '23503', message: 'violates foreign key constraint' };
    const r = await withdrawUser('u1', 'admin1');
    expect(r).toEqual({ ok: false, status: 409, message: withdrawErrorMessage({ code: '23503' }) });
    expect(steps).not.toContain('users.update');
    expect(steps.some((s) => s.startsWith('removeUserFiles'))).toBe(false);
    expect(steps.some((s) => s.startsWith('auth.deleteUser'))).toBe(false);
    expect(logs.some((l) => l.level === 'error')).toBe(true);
  });

  it('도장이 실패하면 저장소 파일을 지우지 않는다 (다시 시도할 수 있게)', async () => {
    state.stampError = { code: '57014', message: 'timeout' };
    const r = await withdrawUser('u1', 'admin1');
    expect(r).toEqual({ ok: false, status: 500, message: '계정 삭제 중 오류가 발생했습니다.' });
    expect(steps.some((s) => s.startsWith('removeUserFiles'))).toBe(false);
    expect(steps.some((s) => s.startsWith('auth.deleteUser'))).toBe(false);
  });

  it('도장이 0행이면(동시에 이미 처리됨) 409, 저장소는 건드리지 않는다', async () => {
    state.stampedRows = [];
    const r = await withdrawUser('u1', 'admin1');
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(steps.some((s) => s.startsWith('removeUserFiles'))).toBe(false);
  });

  it('이미 삭제된 계정은 아무것도 하지 않는다', async () => {
    state.user = { ...state.user, deleted_at: '2026-10-01T00:00:00Z' };
    const r = await withdrawUser('u1', 'admin1');
    expect(r).toEqual({ ok: false, status: 409, message: '이미 삭제된 계정입니다.' });
    expect(steps).toEqual(['users.select']);
  });

  it('슈퍼관리자는 이 경로로 처리하지 않는다', async () => {
    state.user = { ...state.user, is_super_admin: true };
    const r = await withdrawUser('u1', 'admin1');
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(steps).toEqual(['users.select']);
  });

  it('없는 사용자는 404', async () => {
    state.user = null;
    expect(await withdrawUser('u1', 'admin1')).toMatchObject({ ok: false, status: 404 });
  });

  it('개인 비서 숨기기가 실패해도 계속하고 로그를 남긴다', async () => {
    state.softDeleteOk = false;
    const r = await withdrawUser('u1', 'admin1');
    expect(r.ok).toBe(true);
    expect(logs.some((l) => l.message.includes('개인 비서'))).toBe(true);
  });

  it('Auth 삭제가 실패해도 성공으로 본다 — 로그인은 is_active가 막는다', async () => {
    state.authError = { message: 'not found' };
    const r = await withdrawUser('u1', 'admin1');
    expect(r.ok).toBe(true);
    expect(logs.some((l) => l.level === 'warning')).toBe(true);
  });
});

describe('canSignIn', () => {
  it('비활성과 삭제를 모두 막는다', () => {
    expect(canSignIn({ is_active: true, deleted_at: null })).toBe(true);
    expect(canSignIn({})).toBe(true); // 칸이 없던 옛 행
    expect(canSignIn({ is_active: false, deleted_at: null })).toBe(false);
    expect(canSignIn({ is_active: true, deleted_at: '2026-10-17T00:00:00Z' })).toBe(false);
  });
});

describe('연결 지점 (원본 확인)', () => {
  it('라우트는 users 행을 지우지 않고 withdrawUser를 부른다', () => {
    const src = readFileSync('src/app/api/super/accounts/users/[id]/route.ts', 'utf8');
    expect(src).toContain('withdrawUser(params.id, admin.sub)');
    expect(src).not.toMatch(/from\('users'\)\s*\.delete\(\)/);
  });

  it('로그인 두 경로 모두 canSignIn을 거친다', () => {
    const src = readFileSync('src/lib/nextAuthOptions.ts', 'utf8');
    expect(src.match(/canSignIn\(/g)?.length).toBe(2);
    expect(src.match(/is_active, deleted_at/g)?.length).toBe(2);
  });

  it('사용자 목록은 삭제된 계정을 뺀다', () => {
    for (const f of [
      'src/app/api/users/route.ts',
      'src/app/api/super/accounts/users/route.ts',
      'src/app/api/super/organizations/[id]/users/route.ts',
      'src/app/api/super/organizations/[id]/route.ts',
    ]) {
      expect(readFileSync(f, 'utf8'), f).toContain(".is('deleted_at', null)");
    }
  });

  it('0047이 deleted_at 칸을 더한다', () => {
    const sql = readFileSync('supabase/migrations/0047_user_withdrawal.sql', 'utf8');
    expect(sql).toMatch(/ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at timestamptz/);
  });
});
