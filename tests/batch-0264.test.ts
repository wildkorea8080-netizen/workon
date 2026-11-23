import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { requestJson, serverErrorText } from '@/lib/ok-json';

// 0264 — 슈퍼관리자 '계정 관리'의 조작이 응답을 읽지 못하거나 연결이 끊기면 멈추던 것.
// 예전엔 `await res.json()`이 던지면(몸이 JSON이 아닌 500·연결 끊김) 계정 삭제는 '삭제 중'·확인 창이 그대로 남았고,
// 본인 비밀번호 바꾸기는 '저장 중'이 멈췄으며, 잠금 풀기·재발급·IP 잠금 확인·풀기는 아무것도 알리지 않았다(처리되지 않은 오류).
// 오류 글의 꼴도 API마다 달라(`error: '…'` / `error: { message }`) 한쪽만 읽으면 서버 안내가 버려졌다.

const src = readFileSync('src/app/super/accounts/page.tsx', 'utf8').replace(/\r\n/g, '\n');

type Res = { ok: boolean; status: number; json(): Promise<unknown> };
const reply = (status: number, body: unknown | Error): (() => Promise<Res>) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => { if (body instanceof Error) throw body; return body; },
});

describe('requestJson', () => {
  it('2xx이고 몸이 ok일 때만 ok', async () => {
    expect(await requestJson('/x', undefined, reply(200, { ok: true, data: 1 }))).toMatchObject({ ok: true, status: 200, body: { data: 1 } });
    expect((await requestJson('/x', undefined, reply(200, { ok: false }))).ok).toBe(false);
    expect(await requestJson('/x', undefined, reply(409, { ok: false, error: '겹침' }))).toMatchObject({ ok: false, status: 409, body: { error: '겹침' } });
  });
  it('몸을 못 읽거나 연결이 끊겨도 던지지 않는다', async () => {
    expect(await requestJson('/x', undefined, reply(500, new SyntaxError('Unexpected token <')))).toEqual({ ok: false, status: 500, body: null });
    expect(await requestJson('/x', undefined, async () => { throw new TypeError('Failed to fetch'); })).toEqual({ ok: false, status: 0, body: null });
  });
});

describe('serverErrorText', () => {
  it('글 꼴·객체 꼴 모두 읽고, 없으면 정해 둔 글', () => {
    expect(serverErrorText({ error: '본인 계정은 끌 수 없습니다.' }, 'x')).toBe('본인 계정은 끌 수 없습니다.');
    expect(serverErrorText({ error: { message: '이미 풀렸습니다.' } }, 'x')).toBe('이미 풀렸습니다.');
    expect(serverErrorText({ error: { message: '' } }, '실패')).toBe('실패');
    expect(serverErrorText({ ok: false }, '실패')).toBe('실패');
    expect(serverErrorText(null, '실패')).toBe('실패');
  });
});

describe('슈퍼관리자 계정 관리 화면', () => {
  it('조작은 던지지 않는 requestJson으로 하고 오류 글은 serverErrorText로', () => {
    expect(src).not.toMatch(/const data = await res\.json\(\);/);
    expect(src).not.toContain('data.error?.message ??');
    expect((src.match(/await requestJson\(/g) ?? []).length).toBeGreaterThanOrEqual(10);
  });
  it('계정 삭제·비밀번호 바꾸기는 실패해도 진행 표시를 푼다', () => {
    const del = src.slice(src.indexOf('const handleDelete = async'), src.indexOf('const activeCount'));
    expect(del.indexOf('setDeleting(false)')).toBeGreaterThan(del.indexOf('await requestJson('));
    const pw = src.slice(src.indexOf('const handleChangePw = async'), src.indexOf('return (', src.indexOf('const handleChangePw = async')));
    expect(pw).toContain('setPwSaving(false)');
    expect(pw).toContain("serverErrorText(r.body, '비밀번호를 바꾸지 못했습니다.')");
  });
});
