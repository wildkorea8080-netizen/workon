import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 0266 — 화면 셋의 남은 '던지는 응답 읽기'.
// ① 관리자 비서 화면의 카테고리 목록(loadCategories): `await res.json()`이 던지거나 응답이 ok가 아니면 아무것도 하지 않아
//    '카테고리가 없습니다. 모든 비서가 한 목록에 나옵니다'와 '카테고리는 기관 전체를 관리하는 관리자만 바꿀 수 있습니다'가 함께 보였다
//    (읽지 못한 것을 '없음'·'권한 없음'으로). 만들기·이름 바꾸기·삭제 뒤의 다시 읽기는 기다리지 않아 던지면 처리되지 않은 오류였다.
// ② 직원 가입 화면: 응답을 못 읽거나 연결이 끊기면 '처리 중'이 멈추고 가입됐는지 알 수 없었다.

const norm = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const agents = norm('src/components/admin/AgentsManager.tsx');
const signup = norm('src/app/signup/page.tsx');

describe('관리자 비서 화면의 카테고리 목록', () => {
  it('던지지 않고 읽고, 못 읽은 것을 기억한다', () => {
    const i = agents.indexOf('const loadCategories = useCallback(');
    const body = agents.slice(i, agents.indexOf('}, []);', i));
    expect(body).not.toContain('await res.json()');
    expect(body).toContain("fetchOkJson<{ data?: CategoryInfo[]; canEdit?: boolean }>('/api/admin/agent-categories')");
    expect(body).toContain('categories: !result');
  });
  it("못 읽었으면 '없음'·'권한 없음' 대신 그렇다고", () => {
    expect(agents).toContain('{!canEditCategories && !unread.categories && (');
    expect(agents).toContain("emptyListText(unread.categories, '카테고리가 없습니다. 모든 비서가 한 목록에 나옵니다.', '카테고리 목록을')");
  });
});

describe('직원 가입 화면', () => {
  it('응답을 못 읽거나 연결이 끊겨도 처리 중을 풀고 알린다', () => {
    const i = signup.indexOf('async function handleSubmit');
    const body = signup.slice(i, signup.indexOf('\n  }\n', i));
    expect(body).not.toContain('await response.json();');
    expect(body).toContain("const r = await requestJson('/api/signup', {");
    expect(body).toContain('setLoading(false);');
    expect(body).toContain("serverErrorText(r.body, '회원가입을 마치지 못했습니다");
  });
});
