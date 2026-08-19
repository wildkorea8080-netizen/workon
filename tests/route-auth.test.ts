import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';

/**
 * API 라우트 권한 검사.
 *
 * 이 프로젝트에서 실제로 난 사고가 정확히 이 자리다 —
 * `POST /api/forbidden-words`에 `isAdminSession()`이 빠져 있었다. 핸들러마다
 * 따로 검사하는 구조라 하나만 빠뜨려도 드러나지 않는다. 그때 POST는 고쳤지만
 * `forbidden-words/[id]`의 PATCH·DELETE는 같은 상태로 남아 있었고, 이 테스트를
 * 쓰면서 발견했다(직원이 금지어를 끄거나 지울 수 있었다).
 *
 * 소스를 읽어 확인한다. 라우트를 실제로 띄우려면 세션·DB가 필요한데, 그렇게
 * 만든 테스트는 무거워서 잘 안 돌린다. 여기서 잡으려는 것은 "검사를 아예
 * 안 넣은 것"이고 그건 소스만 봐도 안다.
 */

const HANDLERS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** 인증·권한 검사로 인정하는 호출들 */
const AUTH_CALL = /getServerAuthSession|getSuperAdminFromRequest|requireAdminOrg|requireAdmin/;
const ADMIN_CALL = /isAdminSession|role !== 'ADMIN'|getSuperAdminFromRequest|requireAdminOrg|requireAdmin/;

/**
 * 인증 없이 열려도 되는 라우트.
 *
 * 각각 이유가 있어야 한다. 새로 추가할 때는 왜 열어야 하는지 함께 적을 것.
 */
const PUBLIC_ROUTES = new Map<string, string>([
  ['/branding', '기관 전용 로그인 화면이 로그인 전에 기관명·로고를 그린다'],
  ['/branding/logo', '위와 같은 이유. org는 UUID로만 받고 경로를 재확인한다'],
  ['/signup', '가입 자체가 비인증 행위'],
  ['/signup/invite-info', '초대 토큰으로 기관을 확인한다'],
  ['/register', '가입 자체가 비인증 행위'],
  ['/register/validate-token', '초대 토큰 검증'],
  ['/shared/[token]', '공개 공유 링크. 토큰이 곧 자격'],
  ['/super/auth/login', '로그인 엔드포인트 자체. 여기서 인증을 요구하면 로그인이 불가능하다'],
  ['/super/auth/logout', '쿠키를 지우는 것뿐이라 인증 여부와 무관하다'],
  ['/super/auth/setup', '최초 슈퍼관리자 생성. SUPER_ADMIN_SETUP_KEY로 보호'],
  ['/system/maintenance', '점검 모드 상태 조회'],
]);

/**
 * 인증은 필요하지만 관리자가 아니어도 되는 라우트.
 *
 * 직원이 자기 것을 보거나 쓰는 경로다.
 */
const EMPLOYEE_ROUTES = new Set([
  '/agents',
  '/agents/[id]',
  '/agents/favorite',
  '/agents/personal',
  '/agents/personal/[id]',
  '/agents/personal/[id]/request-approval',
  '/chat',
  '/connectors',
  '/conversations',
  '/conversations/[id]',
  '/conversations/[id]/share',
  '/documents',
  '/employee/stats',
  '/enhance-prompt',
  '/my/stats',
  '/notices',
  '/notices/[id]/read',
  '/qna',
  '/report',
  '/templates',
  '/super/impersonate/end',
  '/upload',
]);

interface Handler {
  route: string;
  method: string;
  body: string;
}

function collectHandlers(): Handler[] {
  const files = execSync('find src/app/api -name "route.ts"', { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean);

  const out: Handler[] = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const route = file.replace('src/app/api', '').replace('/route.ts', '') || '/';

    for (const method of HANDLERS) {
      const marker = `export async function ${method}`;
      const start = src.indexOf(marker);
      if (start === -1) continue;

      const rest = src.slice(start + marker.length);
      const next = rest.search(/\nexport (async )?function /);
      out.push({ route, method, body: next === -1 ? rest : rest.slice(0, next) });
    }
  }
  return out;
}

const handlers = collectHandlers();

describe('API 라우트 권한', () => {
  it('핸들러를 실제로 수집한다', () => {
    // 수집이 실패하면 아래 검사가 전부 공허하게 통과한다
    expect(handlers.length).toBeGreaterThan(100);
  });

  it('모든 핸들러가 인증을 확인하거나 공개 목록에 있다', () => {
    const violations = handlers
      .filter((h) => !AUTH_CALL.test(h.body) && !PUBLIC_ROUTES.has(h.route))
      .map((h) => `${h.method} ${h.route}`);

    expect(violations, '인증 검사가 없고 공개 목록에도 없음').toEqual([]);
  });

  it('공개 라우트는 이유가 적혀 있다', () => {
    for (const [route, reason] of PUBLIC_ROUTES) {
      expect(reason.length, `${route}의 공개 이유`).toBeGreaterThan(5);
    }
  });

  it('관리자 전용 경로의 모든 핸들러가 관리자를 확인한다', () => {
    // /admin, /super 아래는 전부 관리자 전용이다. 그 밖에도 관리 기능이
    // 있는 경로를 함께 본다 — 예전에 forbidden-words에서 사고가 났다.
    const ADMIN_PATH =
      /^\/(admin|super)|^\/(users|departments|forbidden-words|security-logs|stats|rag-test)/;

    const violations = handlers
      .filter((h) => ADMIN_PATH.test(h.route))
      .filter((h) => !EMPLOYEE_ROUTES.has(h.route) && !PUBLIC_ROUTES.has(h.route))
      .filter((h) => !ADMIN_CALL.test(h.body))
      .map((h) => `${h.method} ${h.route}`);

    expect(violations, '관리자 경로인데 관리자 검사 없음').toEqual([]);
  });

  it('금지어 수정·삭제는 관리자만 할 수 있다', () => {
    // 실제로 빠져 있던 자리라 따로 고정한다. 금지어는 관리자가 정하는 보안
    // 통제이고, 직원이 끄거나 지울 수 있으면 통제가 무의미해진다.
    const targets = handlers.filter((h) => h.route === '/forbidden-words/[id]');
    expect(targets.length, 'forbidden-words/[id] 핸들러').toBeGreaterThan(0);

    for (const h of targets) {
      expect(ADMIN_CALL.test(h.body), `${h.method} /forbidden-words/[id]`).toBe(true);
    }
  });

  it('문서 삭제는 관리자만 할 수 있다', () => {
    // 문서는 부서가 함께 쓰는 자산이다. 한 사람의 실수로 근거 자료가 사라지면
    // 되돌릴 방법이 없다.
    const del = handlers.find((h) => h.route === '/documents' && h.method === 'DELETE');
    expect(del, 'DELETE /documents').toBeDefined();
    expect(ADMIN_CALL.test(del!.body)).toBe(true);
  });
});
