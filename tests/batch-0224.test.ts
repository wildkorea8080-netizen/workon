import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

/**
 * 2026-11-20 — 슈퍼관리자 기관 상세 화면이 못 읽은 것을 '없음'·0·앞 기간 숫자로 보이지 않는다.
 * ① 기관 자체: 서버는 못 읽으면 503·없으면 404로 답하는데(2026-11-19) 화면은 둘 다 '기관을 찾을 수 없습니다'였고,
 *    연결이 끊기면 불러오는 표시가 멈추지 않았다.
 * ② 사용량 탭: 기간을 바꾼 뒤 읽기에 실패하면 **앞 기간의 숫자가 새 기간 아래 그대로** 보였고, 처음부터 실패하면 0·$0.
 * ③ 계약 탭: 못 읽으면 '계약 이력이 없습니다'.
 * 판정은 `fetchOkJson`·`emptyListText`(`tests/batch-0222.test.ts`가 동작을 본다).
 */

const src = readFileSync('src/app/super/organizations/[id]/page.tsx', 'utf8').replace(/\r\n/g, '\n');

describe('기관 상세 (원본)', () => {
  it('기관을 못 읽은 것과 없는 것을 가른다 — 404만 없음', () => {
    expect(src).toContain('const res = await fetch(`/api/super/organizations/${id}`).catch(() => null);');
    expect(src).toContain('setOrgUnread(!data?.ok && res?.status !== 404);');
    expect(src).toContain("{orgUnread ? '기관 정보를 지금 불러오지 못했습니다. 화면을 새로 고쳐 주세요.' : '기관을 찾을 수 없습니다.'}");
    // 다시 읽기에 실패해도 앞서 읽은 기관을 비우지 않는다
    expect(src).toContain('if (data?.ok) setOrg(data.data);');
    expect(src).not.toContain('setOrg(null)');
  });

  it('사용량 탭 — 기간을 바꾸면 앞 숫자를 지우고, 못 읽으면 0이 아니라 읽지 못함', () => {
    const tab = src.slice(src.indexOf('function UsageTab('), src.indexOf('function ApiKeysTab('));
    const effect = tab.slice(tab.indexOf('useEffect(() => {'), tab.indexOf('}, [orgId, period]);'));
    expect(effect).toContain('setData(null);');
    expect(effect.indexOf('setData(null);')).toBeLessThan(effect.indexOf('fetchOkJson'));
    expect(effect).toContain('if (!active) return;');
    expect(effect).toContain('setUnread(!d);');
    expect(tab).toContain("const shown = (text: string) => (loading ? '—' : unread ? '읽지 못함' : text);");
    expect(tab).toContain("value: shown(fmt(s.totalTokens ?? 0))");
    expect(tab).toContain('value: shown(`$${s.costUsd ?? 0}`)');
    expect(tab).toContain('사용량을 지금 불러오지 못했습니다.');
    expect(tab).not.toContain('.then(d => { if (d.ok) setData(d.data); })');
  });

  it('계약 탭 — 못 읽으면 계약 이력이 없습니다 대신 알린다', () => {
    expect(src).toContain('const d = await fetchOkJson<{ data: { contracts?: any[] } }>(`/api/super/organizations/${orgId}`);');
    expect(src).toContain('if (d) setContracts(d.data.contracts ?? []);');
    expect(src).toContain("{emptyListText(unread, '계약 이력이 없습니다.', '계약 이력을')}");
  });
});
