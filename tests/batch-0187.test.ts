import { readFileSync } from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-19 — 슈퍼관리자 API 키 '검증'·기관별 키 현황.
 * 예전: 저장한 시스템 키의 '검증'은 화면의 가린 키('sk-ant-…••••')를 보내 늘 '유효하지 않은 키'였다.
 * Anthropic 장애(500·529)도 '유효한 키', 시간 초과는 500, 거절이면 Anthropic 영문 원문을 화면에 보였다.
 * 기관별 키 현황은 읽기 실패를 '키 없음'·'이번 달 호출 0'으로 보였다.
 */

const state = { stored: null as null | { key_value: string }, storedError: null as unknown, orgError: null as unknown, usageError: null as unknown };

vi.mock('@/lib/super-auth', () => ({ getSuperAdminFromRequest: () => ({ sub: 'sa' }) }));
vi.mock('@/lib/crypto', () => ({
  decryptApiKey: (v: string) => { if (v === 'broken') throw new Error('x'); return `plain:${v}`; },
  maskApiKey: (v: string) => v.slice(0, 4),
}));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'is', 'eq', 'not', 'order', 'limit', 'gte', 'range']) b[n] = () => b;
      const respond = () => {
        if (table === 'api_keys') return { data: state.storedError ? null : state.stored ? [state.stored] : [], error: state.storedError };
        if (table === 'organizations') return { data: state.orgError ? null : [{ id: 'o1', name: '가', status: 'active' }], error: state.orgError };
        if (table === 'usage_logs') return { data: state.usageError ? null : [{ organization_id: 'o1' }], count: 1, error: state.usageError };
        return { data: null, error: null };
      };
      b.maybeSingle = async () => {
        const r = respond();
        return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error };
      };
      b.then = (res: (v: unknown) => unknown) => Promise.resolve(respond()).then(res);
      return b;
    },
  },
}));

import {
  KEY_INVALID_MESSAGE, KEY_UNKNOWN_MESSAGE, anthropicKeyVerdict, parseVerifyRequest,
} from '@/lib/api-key-verify';
import { POST as verifySystem } from '@/app/api/super/api-keys/verify/route';
import { POST as verifyOrg } from '@/app/api/super/organizations/[id]/verify-key/route';
import { GET as orgKeys } from '@/app/api/super/api-keys/organizations/route';

const fetchMock = vi.fn();
const req = (body: unknown) => new Request('http://x/', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
}) as never;

beforeEach(() => {
  state.stored = null; state.storedError = null; state.orgError = null; state.usageError = null;
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('anthropicKeyVerdict', () => {
  it('맞음·틀림·확인 못 함', () => {
    for (const s of [200, 400, 404, 429]) expect(anthropicKeyVerdict(s).valid).toBe(true);
    for (const s of [401, 403]) expect(anthropicKeyVerdict(s)).toEqual({ valid: false, message: KEY_INVALID_MESSAGE });
    for (const s of [500, 502, 529, null]) expect(anthropicKeyVerdict(s)).toEqual({ valid: null, message: KEY_UNKNOWN_MESSAGE });
  });
});

describe('parseVerifyRequest', () => {
  it('틀린 요청·가린 키는 거절, 앞뒤 공백은 뗌', () => {
    for (const b of [null, [], {}, { keyType: 'voyage', keyValue: 'k' }, { keyType: 'anthropic' }, { keyType: 'anthropic', keyValue: 'sk-ant-ab••••' },
      { keyType: 'anthropic', keyValue: 'a b' }, { keyType: 'anthropic', keyValue: 'x'.repeat(501) }, { keyType: 'anthropic', keyValue: 5 }]) {
      expect(parseVerifyRequest(b).ok).toBe(false);
    }
    expect(parseVerifyRequest({ keyType: 'anthropic', keyValue: ' sk-ant-1 ' })).toEqual({ ok: true, value: { keyType: 'anthropic', key: 'sk-ant-1', stored: false } });
    expect(parseVerifyRequest({ keyType: 'anthropic', key: 'k2' })).toMatchObject({ ok: true, value: { key: 'k2' } });
    expect(parseVerifyRequest({ keyType: 'anthropic', stored: true })).toEqual({ ok: true, value: { keyType: 'anthropic', key: null, stored: true } });
  });
});

describe('POST /api/super/api-keys/verify', () => {
  it('저장한 키는 서버가 풀어서 확인한다', async () => {
    state.stored = { key_value: 'enc' };
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ model: 'claude-haiku-4-5' }), { status: 200 }));
    const body = await (await verifySystem(req({ keyType: 'anthropic', stored: true }))).json();
    expect(body).toMatchObject({ ok: true, valid: true, model: 'claude-haiku-4-5' });
    expect(fetchMock.mock.calls[0][1].headers['x-api-key']).toBe('plain:enc');
  });
  it('저장한 키 없음 404·못 읽음 503·못 풂 500 — Anthropic을 부르지 않음', async () => {
    expect((await verifySystem(req({ keyType: 'anthropic', stored: true }))).status).toBe(404);
    state.storedError = { code: 'XX000' };
    expect((await verifySystem(req({ keyType: 'anthropic', stored: true }))).status).toBe(503);
    state.storedError = null; state.stored = { key_value: 'broken' };
    expect((await verifySystem(req({ keyType: 'anthropic', stored: true }))).status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('Anthropic 장애·시간 초과는 확인 못 함, 거절은 원문 없이', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 529 }));
    expect(await (await verifySystem(req({ keyType: 'anthropic', keyValue: 'k' }))).json()).toMatchObject({ ok: true, valid: null });
    fetchMock.mockRejectedValueOnce(new DOMException('timeout', 'TimeoutError'));
    expect(await (await verifySystem(req({ keyType: 'anthropic', keyValue: 'k' }))).json()).toMatchObject({ ok: true, valid: null });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'invalid x-api-key' } }), { status: 401 }));
    const body = await (await verifySystem(req({ keyType: 'anthropic', keyValue: 'k' }))).json();
    expect(body).toMatchObject({ ok: true, valid: false, message: KEY_INVALID_MESSAGE });
    expect(JSON.stringify(body)).not.toContain('invalid x-api-key');
  });
  it('깨진 몸·가린 키는 400', async () => {
    expect((await verifySystem(req('{깨짐'))).status).toBe(400);
    expect((await verifySystem(req({ keyType: 'anthropic', keyValue: 'sk-ant-ab••••' }))).status).toBe(400);
  });
});

describe('POST /api/super/organizations/[id]/verify-key', () => {
  const call = (b: unknown) => verifyOrg(req(b), { params: { id: 'o1' } });
  it('깨진 몸 400(예전 500)·저장한 키 요청 400', async () => {
    expect((await call('{깨짐')).status).toBe(400);
    expect((await call({ keyType: 'anthropic', stored: true })).status).toBe(400);
  });
  it('연결 실패는 500이 아니라 확인 못 함', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('network'));
    expect(await (await call({ keyType: 'anthropic', key: 'k' })).json()).toMatchObject({ ok: true, valid: null });
  });
});

describe('GET /api/super/api-keys/organizations', () => {
  it('기관·키·사용 기록을 못 읽으면 503', async () => {
    expect((await orgKeys(req(undefined))).status).toBe(200);
    state.orgError = { code: 'XX000' };
    expect((await orgKeys(new Request('http://x/') as never)).status).toBe(503);
    state.orgError = null; state.usageError = { code: 'XX000' };
    expect((await orgKeys(new Request('http://x/') as never)).status).toBe(503);
  });
});

describe('원본 확인 — 화면', () => {
  it('저장한 키 검증은 가린 키가 아니라 stored', () => {
    const s = readFileSync('src/app/super/api-keys/page.tsx', 'utf8');
    expect(s).not.toContain('data?.keys?.[provider]?.masked');
    expect(s).toContain('{ keyType: provider, stored: true }');
    expect(s).toContain("'기관별 키 현황을 불러오지 못했습니다.'");
  });
  it('기관 상세는 확인 못 함을 따로 보인다', () => {
    expect(readFileSync('src/app/super/organizations/[id]/page.tsx', 'utf8')).toContain("'⚠️ 확인하지 못함'");
  });
});
