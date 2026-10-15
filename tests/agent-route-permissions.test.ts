import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';

/**
 * 비서를 바꾸는 라우트는 전부 agent-permissions를 거친다 (설계 3.5).
 *
 * route-auth.test.ts와 같은 방식이다. 한 핸들러에만 검사를 넣고 다른
 * 핸들러를 빠뜨리는 실수가 forbidden-words에서 실제로 있었다.
 */
const PERMISSION_CALL = /can(Edit|Delete|Use)Agent|canPromoteToDepartment|canRequestOfficial|canApproveOfficial/;

/** [파일, 확인할 핸들러] */
const MUTATING: [string, string[]][] = [
  ['src/app/api/agents/[id]/route.ts', ['GET', 'PATCH', 'DELETE']],
  ['src/app/api/agents/personal/[id]/route.ts', ['PUT', 'DELETE']],
  ['src/app/api/agents/personal/[id]/request-approval/route.ts', ['POST']],
  ['src/app/api/agents/[id]/promote/route.ts', ['POST']],
  ['src/app/api/agents/[id]/revert/route.ts', ['POST']],
  ['src/app/api/agents/[id]/history/route.ts', ['GET']],
  ['src/app/api/agents/[id]/templates/route.ts', ['GET', 'POST']],
  ['src/app/api/agents/[id]/templates/[templateId]/route.ts', ['DELETE']],
  ['src/app/api/admin/agents/[id]/approve/route.ts', ['POST']],
  ['src/app/api/admin/agents/[id]/reject/route.ts', ['POST']],
  ['src/app/api/upload/route.ts', ['POST']],
  ['src/app/api/documents/route.ts', ['DELETE']],
  ['src/app/api/documents/assign/route.ts', ['POST']],
];

function handlerBody(src: string, method: string): string | null {
  const marker = `export async function ${method}`;
  const start = src.indexOf(marker);
  if (start === -1) return null;
  const rest = src.slice(start + marker.length);
  const next = rest.search(/\nexport (async )?function /);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('비서 변경 라우트의 권한 판정', () => {
  for (const [file, methods] of MUTATING) {
    for (const method of methods) {
      it(`${method} ${file.replace('src/app/api', '')}`, () => {
        expect(existsSync(file), `${file} 없음`).toBe(true);
        const body = handlerBody(readFileSync(file, 'utf8'), method);
        expect(body, `${method} 핸들러 없음`).not.toBeNull();
        expect(PERMISSION_CALL.test(body!), 'agent-permissions 판정 호출 없음').toBe(true);
      });
    }
  }

  it('업로드는 고른 비서 전부를 검사한다', () => {
    // 예전에는 첫 번째 비서만 검사해 나머지 비서에 권한 없이 문서가 붙었다
    const src = readFileSync('src/app/api/upload/route.ts', 'utf8');
    expect(src).not.toContain('agentIds[0]');
    expect(src).toMatch(/for \(const \w+ of agentIds\)/);
  });

  it('문서 지우기는 비서를 지울 수 있는 사람만', () => {
    // 문서는 되돌리기 대상이 아니다. 되돌릴 수 없는 것은 좁게 연다(결정 4).
    const body = handlerBody(readFileSync('src/app/api/documents/route.ts', 'utf8'), 'DELETE')!;
    expect(body).toContain('canDeleteAgent');
  });
});
