import { describe, expect, it, vi } from 'vitest';
import { createHmac } from 'crypto';
import { readFileSync } from 'fs';
import { verifyNodaSignature, applyNodaEvent, WEBHOOK_MAX_AGE_MS } from '@/lib/noda-webhook';
import { READ_LIMIT_REASON, type ReadingDeps, type StoredDocument } from '@/lib/document-reading';
import { nodaFilename, nodaTenant } from '@/lib/noda';

/**
 * NODA 웹훅(2026-10-24) — 읽기 결과를 목록을 아무도 열지 않아도 받는다.
 * 로그인 없이 열리는 주소라 서명이 유일한 자격이다. 다른 비서·다른 기관의 행을 건드리면 안 된다.
 */

const SECRET = 'whsec_test';
const AGENT = '11111111-2222-4333-8444-555555555555';
const OTHER = '21111111-2222-4333-8444-555555555555';
const DOC = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const NOW = Date.parse('2026-10-24T08:40:00Z');

const sign = (ts: string, body: string, secret = SECRET) =>
  `sha256=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;

describe('verifyNodaSignature', () => {
  const body = '{"event":"ping"}';
  const ts = String(Math.floor(NOW / 1000));
  it('맞는 서명·5분 안이면 통과', () => {
    expect(verifyNodaSignature({ rawBody: body, timestamp: ts, signature: sign(ts, body), secret: SECRET, now: NOW })).toEqual({ ok: true });
  });
  it('서명이 다르면 거절', () => {
    expect(verifyNodaSignature({ rawBody: body, timestamp: ts, signature: sign(ts, body, 'other'), secret: SECRET, now: NOW }).ok).toBe(false);
    expect(verifyNodaSignature({ rawBody: body + ' ', timestamp: ts, signature: sign(ts, body), secret: SECRET, now: NOW }).ok).toBe(false);
  });
  it('5분 넘게 지난(또는 앞선) 시각은 거절 — 되풀이 막기', () => {
    const old = String(Math.floor((NOW - WEBHOOK_MAX_AGE_MS - 1000) / 1000));
    expect(verifyNodaSignature({ rawBody: body, timestamp: old, signature: sign(old, body), secret: SECRET, now: NOW }).ok).toBe(false);
    const future = String(Math.floor((NOW + WEBHOOK_MAX_AGE_MS + 1000) / 1000));
    expect(verifyNodaSignature({ rawBody: body, timestamp: future, signature: sign(future, body), secret: SECRET, now: NOW }).ok).toBe(false);
  });
  it('ISO 시각·밀리초 시각도 읽는다', () => {
    const isoTs = new Date(NOW).toISOString();
    expect(verifyNodaSignature({ rawBody: body, timestamp: isoTs, signature: sign(isoTs, body), secret: SECRET, now: NOW }).ok).toBe(true);
    const msTs = String(NOW);
    expect(verifyNodaSignature({ rawBody: body, timestamp: msTs, signature: sign(msTs, body), secret: SECRET, now: NOW }).ok).toBe(true);
  });
  it('머리글이 없거나 꼴이 틀리면 거절(던지지 않음)', () => {
    expect(verifyNodaSignature({ rawBody: body, timestamp: null, signature: null, secret: SECRET, now: NOW }).ok).toBe(false);
    expect(verifyNodaSignature({ rawBody: body, timestamp: ts, signature: 'abc', secret: SECRET, now: NOW }).ok).toBe(false);
    expect(verifyNodaSignature({ rawBody: body, timestamp: 'x', signature: sign('x', body), secret: SECRET, now: NOW }).ok).toBe(false);
  });
});

function doc(over: Partial<StoredDocument> = {}): StoredDocument {
  return {
    id: DOC, agent_id: AGENT, storage_path: 'p', file_name: '규정.pdf', noda_status: 'reading', noda_reason: null,
    noda_filename: nodaFilename(DOC, '규정.pdf'), noda_doc_id: null, noda_read_started_at: null, noda_last_attempt_at: null,
    noda_read_at: null, created_at: new Date(0).toISOString(), ...over,
  };
}

function world(rows: StoredDocument[] = [doc()]) {
  const docs = new Map(rows.map((r) => [r.id, r]));
  const deletes: { tenant: string; filename: string }[] = [];
  const log = vi.fn(async () => {});
  const deps = {
    store: {
      async getRow(id: string) { const d = docs.get(id); return d ? { ...d } : null; },
      async restart() { return false; },
      async claim() { return false; },
      async finish(id: string, patch: Partial<StoredDocument>) {
        const d = docs.get(id);
        if (!d || d.noda_status !== 'reading') return false;
        Object.assign(d, patch);
        return true;
      },
      async download() { return null; },
    },
    noda: {
      async deleteDocument(tenant: string, filename: string) { deletes.push({ tenant, filename }); return { deleted: true }; },
    },
    now: () => NOW,
    log,
  } as unknown as ReadingDeps;
  return { docs, deletes, log, deps };
}

const base = { delivery: 'd1', at: new Date(NOW).toISOString(), tenant: nodaTenant(AGENT), filename: nodaFilename(DOC, '규정.pdf') };

describe('applyNodaEvent', () => {
  it('document.ready → 그 비서의 읽는 중 행을 ready로(doc_id·읽은 때)', async () => {
    const { docs, deps } = world();
    expect(await applyNodaEvent({ ...base, event: 'document.ready', doc_id: 'sha256:x', chunks: 3 }, { agent: deps })).toBe('updated');
    expect(docs.get(DOC)).toMatchObject({ noda_status: 'ready', noda_doc_id: 'sha256:x' });
    expect(docs.get(DOC)!.noda_read_at).not.toBeNull();
  });
  it('document.unreadable → unreadable, 이유의 문서 id 앞부분을 뗀다', async () => {
    const { docs, deps } = world();
    await applyNodaEvent({ ...base, event: 'document.unreadable', readable: false, reason: `${DOC}__규정.pdf PASSWORD_PROTECTED` }, { agent: deps });
    expect(docs.get(DOC)).toMatchObject({ noda_status: 'unreadable', noda_reason: '규정.pdf PASSWORD_PROTECTED' });
  });
  it('document.failed 403 → failed(한도), 409 → 그대로(다시 걸기는 목록이 한다)', async () => {
    const a = world();
    await applyNodaEvent({ ...base, event: 'document.failed', status: 403, error: '한도' }, { agent: a.deps });
    expect(a.docs.get(DOC)).toMatchObject({ noda_status: 'failed', noda_reason: READ_LIMIT_REASON });
    const b = world();
    expect(await applyNodaEvent({ ...base, event: 'document.failed', status: 409, error: '같은 이름' }, { agent: b.deps })).toBe('unchanged');
    expect(b.docs.get(DOC)!.noda_status).toBe('reading');
  });
  it('같은 알림이 두 번 와도 한 번만 바뀐다(이미 ready면 unchanged)', async () => {
    const { deps } = world();
    await applyNodaEvent({ ...base, event: 'document.ready', doc_id: 'x' }, { agent: deps });
    expect(await applyNodaEvent({ ...base, event: 'document.ready', doc_id: 'x' }, { agent: deps })).toBe('unchanged');
  });
  it('보관함의 비서와 행의 비서가 다르면 건드리지 않고 기록한다', async () => {
    const { docs, deps, log, deletes } = world([doc({ agent_id: OTHER })]);
    expect(await applyNodaEvent({ ...base, event: 'document.ready', doc_id: 'x' }, { agent: deps })).toBe('mismatch');
    expect(docs.get(DOC)!.noda_status).toBe('reading');
    expect(deletes).toEqual([]);
    expect(log).toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain('규정');
  });
  it('NODA 파일 이름이 행과 다르면 건드리지 않는다', async () => {
    const { docs, deps } = world([doc({ noda_filename: nodaFilename(DOC, '다른.pdf') })]);
    expect(await applyNodaEvent({ ...base, event: 'document.ready', doc_id: 'x' }, { agent: deps })).toBe('mismatch');
    expect(docs.get(DOC)!.noda_status).toBe('reading');
  });
  it('행이 없는 문서가 읽혔으면(읽는 도중 지움) 그 보관함의 사본을 지운다', async () => {
    const { deps, deletes } = world([]);
    expect(await applyNodaEvent({ ...base, event: 'document.ready', doc_id: 'x' }, { agent: deps })).toBe('orphan');
    expect(deletes).toEqual([{ tenant: nodaTenant(AGENT), filename: base.filename }]);
  });
  it('비서 보관함이 아닌 tenant·문서 id 없는 파일 이름·ping·removed·모르는 알림은 무시', async () => {
    const { deps, deletes } = world();
    expect(await applyNodaEvent({ ...base, tenant: 'workon-check', event: 'document.ready' }, { agent: deps })).toBe('ignored');
    expect(await applyNodaEvent({ ...base, filename: 'noda-check.txt', event: 'document.ready' }, { agent: deps })).toBe('ignored');
    expect(await applyNodaEvent({ event: 'ping' }, { agent: deps })).toBe('ignored');
    expect(await applyNodaEvent({ ...base, event: 'document.removed' }, { agent: deps })).toBe('ignored');
    expect(await applyNodaEvent({ ...base, event: 'something.else' }, { agent: deps })).toBe('ignored');
    expect(deletes).toEqual([]);
  });
});

describe('웹훅 라우트', () => {
  const src = readFileSync('src/app/api/noda/webhook/route.ts', 'utf8');
  it('본문 글 그대로로 서명을 확인하고, 비밀값이 없으면 503', () => {
    expect(src).toContain('await request.text()');
    expect(src).toContain('verifyNodaSignature(');
    expect(src).toContain('NODA_WEBHOOK_SECRET');
    expect(src).toMatch(/status: 503/);
    expect(src).toMatch(/status: 401/);
  });
});

describe('applyNodaEvent — 공통 보관함', () => {
  const TYPE = '지방자치단체' as const;
  const COMMON_DOC = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const commonFilename = `${COMMON_DOC}__여비 규정(2026).pdf`;
  const cbase = { delivery: 'd2', at: new Date(NOW).toISOString(), tenant: 'workon-c-local', filename: commonFilename };

  function cdoc(over: Partial<StoredDocument> = {}): StoredDocument {
    return {
      id: COMMON_DOC, agent_id: undefined, org_type: TYPE, storage_path: 'p', file_name: '여비.pdf', noda_status: 'reading',
      noda_reason: null, noda_filename: commonFilename, noda_doc_id: null, noda_read_started_at: null,
      noda_last_attempt_at: null, noda_read_at: null, created_at: new Date(0).toISOString(), ...over,
    };
  }
  function cworld(rows: StoredDocument[] = [cdoc()]) {
    const w = world(rows);
    const afterReady = vi.fn(async (_id: string) => {});
    (w.deps as unknown as { afterReady: typeof afterReady }).afterReady = afterReady;
    return { ...w, afterReady };
  }
  // 비서 쪽은 불리면 안 된다 — 어느 쪽 deps가 쓰였는지 가른다
  const agentDeps = () => world([]).deps;

  it('공통 보관함 알림은 그 유형의 행만 ready로 바꾸고 afterReady를 부른다', async () => {
    const c = cworld();
    expect(await applyNodaEvent({ ...cbase, event: 'document.ready', doc_id: 'sha256:c' }, { agent: agentDeps(), common: c.deps })).toBe('updated');
    expect(c.docs.get(COMMON_DOC)).toMatchObject({ noda_status: 'ready', noda_doc_id: 'sha256:c' });
    expect(c.afterReady).toHaveBeenCalledTimes(1);
    expect(c.afterReady).toHaveBeenCalledWith(COMMON_DOC);
  });

  it('ready가 아닌 알림·이미 바뀐 행은 afterReady를 부르지 않는다', async () => {
    const a = cworld();
    await applyNodaEvent({ ...cbase, event: 'document.unreadable', reason: 'x' }, { common: a.deps });
    expect(a.afterReady).not.toHaveBeenCalled();
    const b = cworld([cdoc({ noda_status: 'ready' })]);
    expect(await applyNodaEvent({ ...cbase, event: 'document.ready' }, { common: b.deps })).toBe('unchanged');
    expect(b.afterReady).not.toHaveBeenCalled();
  });

  it('afterReady가 던져도 읽기 결과는 그대로이고 기록만 남는다', async () => {
    const c = cworld();
    (c.afterReady as unknown as { mockRejectedValueOnce: (e: unknown) => void }).mockRejectedValueOnce(new Error('x'));
    expect(await applyNodaEvent({ ...cbase, event: 'document.ready' }, { common: c.deps })).toBe('updated');
    expect(c.docs.get(COMMON_DOC)!.noda_status).toBe('ready');
    expect(c.log).toHaveBeenCalledWith(expect.objectContaining({ level: 'warning' }));
  });

  it('다른 유형의 행·다른 파일 이름이면 건드리지 않고 security warning(파일 이름 없음)', async () => {
    const a = cworld([cdoc({ org_type: '공공기관' })]);
    expect(await applyNodaEvent({ ...cbase, event: 'document.ready' }, { common: a.deps })).toBe('mismatch');
    expect(a.docs.get(COMMON_DOC)!.noda_status).toBe('reading');
    expect(a.afterReady).not.toHaveBeenCalled();
    expect(a.deletes).toEqual([]);
    expect(a.log).toHaveBeenCalledWith(expect.objectContaining({ level: 'warning', category: 'security' }));
    expect(JSON.stringify(a.log.mock.calls)).not.toContain('여비');
    const b = cworld([cdoc({ noda_filename: `${COMMON_DOC}__다른(2026).pdf` })]);
    expect(await applyNodaEvent({ ...cbase, event: 'document.ready' }, { common: b.deps })).toBe('mismatch');
    expect(b.docs.get(COMMON_DOC)!.noda_status).toBe('reading');
    expect(JSON.stringify(b.log.mock.calls)).not.toContain('여비');
  });

  it('비서 행(org_type 없음)이 공통 보관함 이름으로 오면 건드리지 않는다', async () => {
    const c = cworld([cdoc({ org_type: null, agent_id: AGENT })]);
    expect(await applyNodaEvent({ ...cbase, event: 'document.ready' }, { common: c.deps })).toBe('mismatch');
    expect(c.docs.get(COMMON_DOC)!.noda_status).toBe('reading');
  });

  it('공통 보관함에서 행이 없는 문서가 읽혔으면 그 보관함 사본을 지운다', async () => {
    const c = cworld([]);
    expect(await applyNodaEvent({ ...cbase, event: 'document.ready' }, { common: c.deps })).toBe('orphan');
    expect(c.deletes).toEqual([{ tenant: 'workon-c-local', filename: commonFilename }]);
    expect(c.afterReady).not.toHaveBeenCalled();
  });

  it('유형 열쇠를 모르는 공통 보관함 이름은 무시한다', async () => {
    const c = cworld();
    expect(await applyNodaEvent({ ...cbase, tenant: 'workon-c-mars', event: 'document.ready' }, { common: c.deps })).toBe('ignored');
    expect(c.deletes).toEqual([]);
  });

  it('비서 보관함 알림은 비서 deps만 쓴다', async () => {
    const agent = world();
    const c = cworld();
    expect(await applyNodaEvent({ ...base, event: 'document.ready', doc_id: 'x' }, { agent: agent.deps, common: c.deps })).toBe('updated');
    expect(agent.docs.get(DOC)!.noda_status).toBe('ready');
    expect(c.afterReady).not.toHaveBeenCalled();
  });
});
