import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BAD_BODY_MESSAGE, readJsonObject } from '@/lib/request-body';

// 0269(큰 묶음) — 깨진 요청 몸을 500 대신 400으로.
// 라우트 열셋(비서 만들기·고치기·나만의 비서, 대화, 문서 붙이기·지우기, 프롬프트 다듬기, 초대 가입·가입,
// 슈퍼관리자 로그인·첫 설정·시스템 API 키 저장)이 `await request.json()`을 그대로 불러, 몸이 JSON이 아니거나
// null·배열이면 던지거나 `body.email`에서 TypeError가 나 500 '서버 오류'로 답했다 — 시스템 API 키 저장은 try가 없어
// 빈 500이었다. 깨진 요청은 400이어야 운영 감시가 서버 장애로 세지 않는다.
// 이제 readJsonObject 한 곳으로 읽고, 모든 라우트를 훑어 같은 꼴이 다시 들어오지 못하게 막는다.

function routes(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? routes(p) : p.endsWith('route.ts') ? [p] : [];
  });
}

const req = (body: string | undefined) =>
  new Request('http://x/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body }) });

describe('readJsonObject', () => {
  it('JSON 객체만 받는다', async () => {
    expect(await readJsonObject(req('{"a":1}'))).toEqual({ a: 1 });
    expect(await readJsonObject(req('{}'))).toEqual({});
  });
  it('JSON이 아니거나 객체가 아니면 null(던지지 않음)', async () => {
    for (const b of [undefined, '', '{', 'null', '[]', '[1]', '"x"', '3', 'true']) {
      expect(await readJsonObject(req(b)), String(b)).toBeNull();
    }
  });
  it('안내 글', () => {
    expect(BAD_BODY_MESSAGE).toBe('요청 형식이 올바르지 않습니다.');
  });
});

describe('모든 API 라우트', () => {
  it('요청 몸을 그냥 `await request.json()`으로 읽지 않는다(.catch·자기 try 안이 아니면)', () => {
    const offenders: string[] = [];
    for (const f of routes('src/app/api')) {
      const s = readFileSync(f, 'utf8');
      const re = /await (request|req|_req)\.json\(\)(?!\s*\.catch)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(s))) {
        // 바로 앞이 `try {` + 대입이면(그 자리에서 400·기본값으로 받는 꼴) 괜찮다
        const before = s.slice(Math.max(0, m.index - 80), m.index);
        if (/try\s*\{\s*(const|let)?\s*[\w{},\s]*=\s*$/.test(before)) continue;
        offenders.push(`${f}:${s.slice(0, m.index).split('\n').length}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('고친 라우트는 readJsonObject로 읽는다', () => {
    for (const f of [
      'src/app/api/agents/personal/route.ts',
      'src/app/api/agents/personal/[id]/route.ts',
      'src/app/api/agents/route.ts',
      'src/app/api/agents/[id]/route.ts',
      'src/app/api/chat/route.ts',
      'src/app/api/documents/assign/route.ts',
      'src/app/api/documents/route.ts',
      'src/app/api/enhance-prompt/route.ts',
      'src/app/api/register/route.ts',
      'src/app/api/signup/route.ts',
      'src/app/api/super/api-keys/system/route.ts',
      'src/app/api/super/auth/login/route.ts',
      'src/app/api/super/auth/setup/route.ts',
    ]) {
      const s = readFileSync(f, 'utf8');
      expect(s, f).toContain('await readJsonObject(request)');
      expect(s, f).toMatch(/if \(!(body|raw|parsed)\) return [^\n]*BAD_BODY_MESSAGE[^\n]*400/);
    }
  });
});
