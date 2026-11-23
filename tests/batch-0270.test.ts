import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { API_ROUTES, BAD_ROUTE_ID_MESSAGE, NON_UUID_SEGMENTS, badRouteId } from '@/lib/api-route-ids';

// 0270(큰 묶음) — 주소의 id 자리가 uuid 꼴이 아니면 미들웨어가 404로.
// 읽기 실패를 503 '지금 못 읽음'으로 답하게 고쳐 오면서, 엉뚱한 id(`/api/agents/abc`)를 DB가 22P02로 거절한 것도
// 503 '잠시 뒤 다시'가 되었다(라우트 65파일이 id 꼴을 보지 않았다 — 예: loadAgentAccess가 AgentReadError를 던짐).
// 없는 주소는 404여야 한다. 라우트마다 고치지 않고 미들웨어가 라우트 목록으로 한 곳에서 가른다.

const U = '0f8fad5b-d9cb-469f-a165-70867728950e';

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? routeFiles(p) : n === 'route.ts' ? [p] : [];
  });
}
const onDisk = routeFiles('src/app/api')
  .map((p) => p.split(sep).join('/').replace('src/app/api/', '').replace(/\/route\.ts$/, ''))
  .sort();

describe('라우트 목록', () => {
  it('src/app/api의 route.ts와 같다 — 라우트를 더하거나 옮기면 api-route-ids.ts도 고친다', () => {
    const listed = [...API_ROUTES].sort();
    expect(onDisk.filter((r) => !listed.includes(r)), '목록에 없는 라우트').toEqual([]);
    expect(listed.filter((r) => !onDisk.includes(r)), '이제 없는 라우트').toEqual([]);
  });
  it('동적 자리 이름은 아는 것뿐 — 새 이름이면 uuid인지 보고 NON_UUID_SEGMENTS를 정한다', () => {
    const names = new Set(onDisk.flatMap((r) => r.split('/').filter((s) => s.startsWith('['))));
    expect([...names].sort()).toEqual(['[...nextauth]', '[documentId]', '[id]', '[proposalId]', '[runId]', '[templateId]', '[token]', '[versionId]']);
    expect([...NON_UUID_SEGMENTS]).toEqual(['[token]']);
  });
});

describe('badRouteId', () => {
  it('id 자리가 uuid가 아니면 참', () => {
    expect(badRouteId('/api/agents/abc')).toBe(true);
    expect(badRouteId('/api/agents/abc/history')).toBe(true);
    expect(badRouteId(`/api/agents/${U}/templates/builtin:report`)).toBe(true);
    expect(badRouteId('/api/work/tasks/1/runs/2')).toBe(true);
    expect(badRouteId(`/api/work/tasks/${U}/runs/x/execute`)).toBe(true);
    expect(badRouteId('/api/super/organizations/not-an-id')).toBe(true);
    expect(badRouteId("/api/conversations/' or 1=1")).toBe(true);
  });
  it('uuid면 거짓(대문자도)', () => {
    expect(badRouteId(`/api/agents/${U}`)).toBe(false);
    expect(badRouteId(`/api/agents/${U.toUpperCase()}/history`)).toBe(false);
    expect(badRouteId(`/api/work/tasks/${U}/runs/${U}/execute`)).toBe(false);
  });
  it('같은 자리의 고정 이름은 id가 아니다', () => {
    expect(badRouteId('/api/agents/personal')).toBe(false);
    expect(badRouteId('/api/agents/favorite')).toBe(false);
    expect(badRouteId('/api/documents/upload-url')).toBe(false);
    expect(badRouteId('/api/documents/references/build')).toBe(false);
    expect(badRouteId('/api/attachments/mine')).toBe(false);
  });
  it('공유 열쇠·NextAuth·맞는 라우트가 없는 주소는 보지 않는다', () => {
    expect(badRouteId('/api/shared/abc-not-uuid')).toBe(false);
    expect(badRouteId('/api/auth/session')).toBe(false);
    expect(badRouteId('/api/auth/callback/credentials')).toBe(false);
    expect(badRouteId('/api/no-such/route')).toBe(false);
    expect(badRouteId('/login')).toBe(false);
  });
});

describe('미들웨어', () => {
  it('점검 모드·인증보다 먼저 404로 답한다', () => {
    const s = readFileSync('src/middleware.ts', 'utf8').replace(/\r\n/g, '\n');
    const i = s.indexOf('if (badRouteId(pathname))');
    expect(i).toBeGreaterThan(-1);
    expect(i).toBeLessThan(s.indexOf('const isExempt ='));
    expect(s).toContain('NextResponse.json({ ok: false, error: { message: BAD_ROUTE_ID_MESSAGE } }, { status: 404 })');
    expect(BAD_ROUTE_ID_MESSAGE).toBe('찾을 수 없습니다.');
  });
});
