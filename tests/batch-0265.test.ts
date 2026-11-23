import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 0265 — 0264(계정 관리)에 이어 슈퍼관리자 화면의 조작 셋이 응답을 못 읽거나 연결이 끊기면 멈추던 것.
// try 없이 `await res.json()`이라 던지면 그 뒤의 진행 표시 풀기에 닿지 않았다:
//  - API 키 관리 '저장' → '저장 중'이 멈춤(검증은 지났는데 저장했는지 알 수 없음)
//  - 계약 등록 창 → '저장 중'이 멈춤(계약이 만들어졌는지 알 수 없음 — 다시 누르면 계약이 둘)
//  - 기관 상세 '초대 링크 만들기' → '만드는 중'이 멈춤
// 이제 던지지 않는 requestJson으로 하고 실패는 serverErrorText로 알린다.

const norm = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const keys = norm('src/app/super/api-keys/page.tsx');
const contracts = norm('src/app/super/contracts/page.tsx');
const org = norm('src/app/super/organizations/[id]/page.tsx');

function handler(src: string, start: string): string {
  const i = src.indexOf(start);
  expect(i).toBeGreaterThan(-1);
  return src.slice(i, src.indexOf('\n  };', i));
}

describe('슈퍼관리자 조작은 멈추지 않는다', () => {
  it('API 키 저장', () => {
    expect(keys).not.toContain('await res.json();');
    expect(keys).toContain("const r = await requestJson('/api/super/api-keys/system', {");
    expect(keys).toContain("onToast(`❌ ${serverErrorText(r.body, '키를 저장하지 못했습니다. 목록을 새로 고쳐 저장됐는지 확인하세요.')}`)");
  });

  it('계약 등록', () => {
    expect(contracts).not.toContain('await res.json();');
    expect(contracts).toContain("const r = await requestJson('/api/super/contracts', {");
    expect(contracts).toContain("setError(serverErrorText(r.body, '계약을 등록하지 못했습니다. 계약 목록을 새로 고쳐 만들어졌는지 확인한 뒤 다시 시도하세요.'))");
  });

  it('관리자 초대 링크 만들기', () => {
    const h = handler(org, 'const handleNewInvite = async');
    expect(h).not.toContain('await res.json();');
    expect(h).toContain('const r = await requestJson(');
    expect(h).toContain('setInviting(false);');
    expect(h).toContain("onToast(serverErrorText(r.body, '초대 링크를 만들지 못했습니다.'))");
  });
});
