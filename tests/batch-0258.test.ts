import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MEMBER_FILTER_UNREAD } from '@/lib/ok-json';

// 0258 — 관리자 화면의 고르기 목록을 못 읽은 것을 숨기지 않기.
// ① 감사 기록(AuditLogsManager)의 '직원' 거르기: 직원 목록을 못 읽으면 실패를 삼켜(.catch(() => {})) '전체'만 남았다 —
//    특정 직원의 사용 내역을 낼 수 없는데 까닭이 없었다(관리 범위에 직원이 없는 것처럼 보임).
// ② 관리자 비서 만들기 폼(AgentsManager)의 '외부 도구': 연결 목록을 못 읽으면 칸이 통째로 사라졌고,
//    응답 몸을 못 읽으면 던져 화면 전체가 '데이터를 불러오지 못했습니다'가 됐다.

const norm = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const audit = norm('src/components/admin/AuditLogsManager.tsx');
const agents = norm('src/components/admin/AgentsManager.tsx');

describe('감사 기록 직원 거르기', () => {
  it('직원 목록을 못 읽으면 고를 수 없는 안내 줄을 넣는다', () => {
    expect(audit).not.toContain('.catch(() => {});');
    expect(audit).toContain('setMembersUnread(true)');
    expect(audit).toContain('{membersUnread && <option value="__unread" disabled>{MEMBER_FILTER_UNREAD}</option>}');
    expect(MEMBER_FILTER_UNREAD).toContain('불러오지 못함');
  });
});

describe('관리자 비서 만들기의 외부 도구', () => {
  it('연결 목록은 던지지 않고 읽고, 못 읽으면 칸 자리에 알린다', () => {
    const i = agents.indexOf('const loadConnectors = useCallback(');
    const body = agents.slice(i, agents.indexOf('}, []);', i));
    expect(body).toContain("fetchOkJson<{ data?: ConnectorInfo[] }>('/api/connectors')");
    expect(body).toContain('connectors: !result');
    expect(agents).toContain('connectorsUnread={unread.connectors}');
    expect(agents).toContain('{connectorsUnread && <p role="status" className="text-[11px] text-amber-600">{CREATE_CONNECTOR_LIST_UNREAD}</p>}');
  });
});
