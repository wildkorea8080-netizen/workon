import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

/**
 * 대화 공유 중단.
 *
 * 공유를 시작할 수만 있고 **중단할 수 없었다.** 한 번 만든 링크는 영구히
 * 열려 있었고, 토큰만 알면 로그인 없이 대화 전문이 보인다. 공공기관 대화에는
 * 민원인 정보와 검토 중인 방침이 섞이므로 되돌릴 수단이 반드시 있어야 한다.
 *
 * 소스를 읽어 확인한다. 실제로 돌리려면 세션과 DB가 필요한데, 여기서 막으려는
 * 것은 "중단 경로가 아예 없어지는 것"이고 그건 소스만 봐도 안다.
 */

const ROUTE = 'src/app/api/conversations/[id]/share/route.ts';
const VIEW = 'src/app/api/shared/[token]/route.ts';

const route = readFileSync(ROUTE, 'utf8');
const view = readFileSync(VIEW, 'utf8');

describe('공유 중단 경로', () => {
  it('DELETE 핸들러가 있다', () => {
    expect(route).toContain('export async function DELETE');
  });

  it('중단하면 토큰까지 버린다', () => {
    // is_shared만 내리면 조회는 막히지만 토큰이 남아, 다시 공유할 때 같은
    // 주소가 되살아난다. 예전에 링크를 받아 둔 사람이 그대로 다시 본다.
    const start = route.indexOf('export async function DELETE');
    const block = route.slice(start);
    expect(block).toContain('is_shared: false');
    expect(block).toContain('share_token: null');
  });

  it('소유자만 중단할 수 있다', () => {
    const start = route.indexOf('export async function DELETE');
    const block = route.slice(start);
    expect(block).toContain('getServerAuthSession');
    // 남의 대화를 닫아 버릴 수 없어야 한다
    expect(block).toContain("eq('user_id', session.user.id)");
  });
});

describe('공개 조회', () => {
  it('is_shared를 함께 본다', () => {
    // 토큰만 보면 중단해도 계속 열린다. 두 조건이 함께 걸려야 한다.
    expect(view).toContain("eq('share_token'");
    expect(view).toContain("eq('is_shared', true)");
  });
});

describe('주소 생성', () => {
  it('한 곳에서만 만든다', () => {
    // POST와 GET이 다른 주소를 주면 사용자가 받은 링크와 화면에 보이는 링크가
    // 어긋난다.
    expect(route).toContain('function shareUrl(');
    expect(route.match(/\/shared\/\$\{/g)?.length ?? 0).toBe(1);
  });

  it('환경변수를 직접 읽지 않는다', () => {
    // 프로젝트 규칙: config.ts 경유. 여기서 process.env를 직접 읽고 있었다.
    expect(route).not.toContain('process.env');
    expect(route).toContain("from '@/lib/config'");
  });
});

describe('화면', () => {
  const sidebar = readFileSync('src/components/layout/Sidebar.tsx', 'utf8');

  it('중단 버튼이 있다', () => {
    expect(sidebar).toContain('handleUnshare');
    expect(sidebar).toContain("method: 'DELETE'");
  });

  it('중단 전에 되묻는다', () => {
    // 다시 공유하면 다른 주소가 나가므로 이미 배포한 링크를 되살릴 수 없다.
    const start = sidebar.indexOf('const handleUnshare');
    const block = sidebar.slice(start, start + 600);
    expect(block).toContain('confirm(');
  });

  it('공유 중인 대화를 목록에서 알아볼 수 있다', () => {
    // 마우스를 올려야 아이콘이 보이는 구조라 표시가 없으면 공유 사실을 잊는다.
    expect(sidebar).toContain('c.is_shared');
  });

  it('목록 API가 is_shared를 내려준다', () => {
    const list = readFileSync('src/app/api/conversations/route.ts', 'utf8');
    expect(list).toContain('is_shared');
  });
});
