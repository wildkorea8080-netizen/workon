import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-20 — 모델·공공 데이터 연결 목록(`/api/models`·`/api/connectors`)이 읽기 실패를 '좁은 목록'으로 답하지 않는다.
 * 판정(대화·저장)은 못 읽으면 가장 좁게 닫는다(기본 모델 하나·켤 수 있는 연결 없음) — 그 값을 **화면 목록**으로도 내보내,
 * 비서 편집 창이 허용된 모델을 '허용되지 않음 — 바꿔야 저장됩니다'로, 이미 켠 연결을 '범위 밖'으로 잘못 알렸다
 * (그 안내대로 모델을 기본으로 바꿔 저장하면 비서의 모델이 조용히 내려간다).
 * 이제 화면용 읽기는 못 읽으면 null → 503이고, 판정용은 예전처럼 닫는다.
 */

const state = vi.hoisted(() => ({
  session: { user: { id: 'u1', departmentId: 'd1' as string | undefined } },
  errors: {} as Record<string, unknown>,
  rows: {} as Record<string, unknown>,
}));

vi.mock('@/lib/auth', () => ({ getServerAuthSession: async () => state.session }));
vi.mock('@/lib/department-scope', () => ({
  getAccessScope: async () => ({ organizationId: 'o1', departmentIds: ['d1'] }),
  visibilityFilter: () => 'organization_id.eq.o1',
}));
vi.mock('@/lib/connectors', () => ({ connectorCatalog: () => [{ id: 'law', name: '국가법령정보', description: '', tools: [] }] }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq', 'is', 'in', 'or']) b[n] = () => b;
      const result = () => ({ data: state.errors[table] ? null : state.rows[table] ?? null, error: state.errors[table] ?? null });
      b.maybeSingle = async () => result();
      b.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, bad);
      return b;
    },
  },
}));

import { GET as models } from '@/app/api/models/route';
import { GET as connectors } from '@/app/api/connectors/route';
import { getAllowedModelIds, readAllowedModelIds, POLICY_FALLBACK_MODEL_ID } from '@/lib/model-policy';
import { getCapabilityScope, readCapabilityScope } from '@/lib/connector-scope';

const BOOM = { code: 'XX000', message: 'boom' };

beforeEach(() => {
  state.session = { user: { id: 'u1', departmentId: 'd1' } };
  state.errors = {};
  state.rows = {
    users: { department_id: 'd1' },
    departments: { organization_id: 'o1' },
    organizations: { allowed_models: ['claude-sonnet-4-6', 'claude-opus-5'] },
    agents: [{ capabilities: { public_data: { connectors: ['law'] } } }],
  };
});

describe('/api/models', () => {
  it('읽히면 기관 허용 목록', async () => {
    const res = await models();
    expect(res.status).toBe(200);
    expect((await res.json()).data.map((m: { id: string }) => m.id)).toEqual(['claude-sonnet-4-6', 'claude-opus-5']);
  });
  it('기관 정책을 못 읽으면 503(기본 모델 하나로 답하지 않음)', async () => {
    state.errors.organizations = BOOM;
    expect((await models()).status).toBe(503);
  });
  it('부서를 못 읽으면 503', async () => {
    state.errors.departments = BOOM;
    expect((await models()).status).toBe(503);
  });
  it('세션에 부서가 없는데 사용자를 못 읽으면 503', async () => {
    state.session.user.departmentId = undefined;
    state.errors.users = BOOM;
    expect((await models()).status).toBe(503);
  });
  it('정책을 정하지 않은 기관은 예전처럼 기본 모델', async () => {
    state.rows.organizations = { allowed_models: null };
    expect((await (await models()).json()).data.map((m: { id: string }) => m.id)).toEqual([POLICY_FALLBACK_MODEL_ID]);
  });
});

describe('/api/connectors', () => {
  it('읽히면 기관이 쓰는 연결을 켤 수 있다고 알린다', async () => {
    const body = await (await connectors()).json();
    expect(body.data).toMatchObject([{ id: 'law', allowedForPersonal: true }]);
  });
  it('공식 비서를 못 읽으면 503(켤 수 있는 연결 없음으로 답하지 않음)', async () => {
    state.errors.agents = BOOM;
    expect((await connectors()).status).toBe(503);
  });
  it('세션에 부서가 없는데 사용자를 못 읽으면 503', async () => {
    state.session.user.departmentId = undefined;
    state.errors.users = BOOM;
    expect((await connectors()).status).toBe(503);
  });
});

describe('판정용은 예전처럼 닫는다', () => {
  it('허용 모델 — 못 읽으면 기본 모델만, 화면용은 null', async () => {
    state.errors.organizations = BOOM;
    expect(await getAllowedModelIds('o1')).toEqual([POLICY_FALLBACK_MODEL_ID]);
    expect(await readAllowedModelIds('o1')).toBeNull();
  });
  it('능력 범위 — 못 읽으면 빈 범위, 화면용은 null', async () => {
    state.errors.agents = BOOM;
    expect((await getCapabilityScope('d1')).publicDataConnectors.size).toBe(0);
    expect(await readCapabilityScope('d1')).toBeNull();
  });
});
