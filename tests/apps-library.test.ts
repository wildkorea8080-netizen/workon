import { homeChatRedirect, FEATURED_WORKFLOWS } from '@/lib/apps/home';
import { taskAgentChoices, workLaunchLinks } from '@/lib/apps/work-launch';
import { describe, expect, it, vi } from 'vitest';
import type { Agent } from '@/lib/db';
import type { WorkflowSummaryDto } from '@/components/work/types';
import { appEntries, filterApps } from '@/lib/apps/catalog';
import { chatLaunchTarget, loadChatLaunchAgent } from '@/lib/apps/chat-launch';

const agent = (patch: Partial<Agent> = {}): Agent => ({
  id: 'visible-agent', department_id: 'dept', name: '규정 확인', config: {}, is_active: true, tier: 'official', version: 1, created_at: '', updated_at: '',
  capabilities: { doc_search: {} }, ...patch,
});
const workflow = (patch: Partial<WorkflowSummaryDto> = {}): WorkflowSummaryDto => ({
  key: 'collection', name: '자료 취합', group: 'A', purpose: '부서별 제출자료를 합칩니다.', outputs: [{ key: 'sheet', label: '통합표', format: 'xlsx', required: true }],
  inputs: [], scopeNote: '', available: true, reason: null, defaultTemplateRef: null, currentizes: false, ...patch,
});

describe('업무 앱 목록', () => {
  it('비서와 업무를 다른 실행 경로로 열며 중복 비서는 하나만 표시한다', () => {
    const entries = appEntries([agent(), agent()], [workflow()], true);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: 'chat', href: '/chat?agent=visible-agent' });
    expect(entries[1]).toMatchObject({ kind: 'workflow', href: '/tasks/new?workflow=collection' });
    expect(entries[1].details).toEqual(['통합표 · XLSX']);
  });

  it('기관 스위치가 꺼지면 업무 실행만 막고 AI 비서는 유지한다', () => {
    const entries = appEntries([agent()], [workflow()], false);
    expect(entries[0].href).not.toBeNull();
    expect(entries[1].href).toBeNull();
    expect(entries[1].unavailableReason).toContain('꺼져');
  });

  it('미구현·사용 중지·위험한 외부 주소를 실행 링크로 만들지 않는다', () => {
    const entries = appEntries([
      agent({ id: 'inactive', is_active: false }),
      agent({ id: 'bad-link', agent_type: 'link', link_url: 'javascript:alert(1)' }),
      agent({ id: 'deleted', deleted_at: '2026-10-28' }),
    ], [workflow({ available: false, reason: '양식 확인 전' })], true);
    expect(entries).toHaveLength(3);
    expect(entries.every((entry) => entry.href === null)).toBe(true);
    expect(entries[2].unavailableReason).toBe('양식 확인 전');
  });

  it('외부 연결을 대화형 비서로 바꾸지 않고 검색·범위·방식 조건을 함께 적용한다', () => {
    const entries = appEntries([
      agent({ id: 'personal', tier: 'personal', name: '내 보고서 비서', capabilities: { document: {} } }),
      agent({ id: 'link', agent_type: 'link', link_url: 'https://example.org' }),
    ], [workflow()], true);
    expect(entries[1]).toMatchObject({ kind: 'link', href: 'https://example.org/' });
    expect(filterApps(entries, { query: '보고서 문서', kind: 'chat', scope: 'personal' }).map((e) => e.id)).toEqual(['agent:personal']);
    expect(filterApps(entries, { query: 'XLSX', kind: 'workflow', scope: 'all' }).map((e) => e.id)).toEqual(['workflow:collection']);
  });

  it('옛 능력 설정이 문자열·배열 등으로 손상돼도 목록을 열 수 있다', () => {
    for (const capabilities of ['doc_search', ['doc_search'], null, 42]) {
      const entries = appEntries([agent({ capabilities: capabilities as unknown as Agent['capabilities'] })], [], true);
      expect(entries[0].details).toEqual([]);
      expect(entries[0].href).toBe('/chat?agent=visible-agent');
    }
  });
});

describe('비서 대화 딥링크', () => {
  it('기존 대화 주소가 비서 선택보다 우선한다', () => {
    expect(chatLaunchTarget(new URLSearchParams('conv=old&agent=new'))).toEqual({ kind: 'conversation', id: 'old' });
    expect(chatLaunchTarget(new URLSearchParams('agent=new'))).toEqual({ kind: 'agent', id: 'new' });
    expect(chatLaunchTarget(new URLSearchParams())).toBeNull();
  });

  it('편집자 전용 단건 API 대신 사용 가능한 목록만 GET하며 대화·메시지를 생성하지 않는다', async () => {
    const request = vi.fn(async (url: string) => new Response(JSON.stringify({ ok: true, data: url.includes('personal') ? [agent({ id: 'mine', tier: 'personal' })] : [agent()] }), { status: 200 }));
    expect((await loadChatLaunchAgent('mine', request as typeof fetch))?.id).toBe('mine');
    expect(request.mock.calls.map(([url]) => url)).toEqual(['/api/agents', '/api/agents?personal=true']);
  });

  it('목록에 없는 비서와 비활성·삭제·링크형 비서는 대화로 열지 않는다', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: [agent({ id: 'inactive', is_active: false }), agent({ id: 'deleted', deleted_at: 'today' }), agent({ id: 'link', agent_type: 'link' })] })));
    for (const id of ['other-organization', 'inactive', 'deleted', 'link']) expect(await loadChatLaunchAgent(id, request as typeof fetch)).toBeNull();
  });

  it('거부된 목록 응답에 데이터가 있어도 사용하지 않는다', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ ok: false, data: [agent()] }), { status: 403 }));
    await expect(loadChatLaunchAgent('visible-agent', request as typeof fetch)).rejects.toThrow('비서 목록');
  });

  it('개인 목록 장애가 있어도 정상 응답의 허용된 기관 비서는 연다', async () => {
    const request = vi.fn(async (url: string) => {
      if (url.includes('personal')) throw new Error('network down');
      return new Response(JSON.stringify({ ok: true, data: [agent()] }));
    });
    expect((await loadChatLaunchAgent('visible-agent', request as typeof fetch))?.id).toBe('visible-agent');
    await expect(loadChatLaunchAgent('unknown', request as typeof fetch)).rejects.toThrow('비서 목록');
  });
});

describe('비서에서 업무 시작', () => {
  it('가용한 업무만 비서 선택을 유지한 링크로 연결한다', () => {
    const links = workLaunchLinks(agent({ id: 'agent/value' }), [workflow({ key: 'reply' }), workflow({ key: 'report', available: false }), workflow({ key: 'regulations' })], true);
    expect(links.map((l) => l.href)).toEqual(['/tasks/new?workflow=regulations&agent=agent%2Fvalue', '/tasks/new?workflow=reply&agent=agent%2Fvalue']);
  });
  it('기관 업무가 꺼져 있거나 링크·중지·삭제 비서면 시작 링크가 없다', () => {
    expect(workLaunchLinks(agent(), [workflow({ key: 'reply' })], false)).toEqual([]);
    for (const a of [agent({ agent_type: 'link' }), agent({ is_active: false }), agent({ deleted_at: '2026-10-29' })]) {
      expect(workLaunchLinks(a, [workflow({ key: 'reply' })], true)).toEqual([]);
    }
  });
  it('업무 선택 목록에서 쓸 수 없는 비서를 빼고 중복을 제거한다', () => {
    expect(taskAgentChoices([agent(), agent(), agent({ id: 'link', agent_type: 'link' }), agent({ id: 'off', is_active: false })]).map((a) => a.id)).toEqual(['visible-agent']);
  });
});

describe('앱 중심 홈의 대화 호환', () => {
  it('기존 대화가 비서보다 우선하고 주소 값을 인코딩한다', () => { expect(homeChatRedirect({ conv: 'old&value', agent: 'agent' })).toBe('/chat?conv=old%26value'); expect(homeChatRedirect({ conv: null, agent: 'agent/value' })).toBe('/chat?agent=agent%2Fvalue'); });
  it('일반 홈 이동은 대화를 새로 만들지 않는다', () => { expect(homeChatRedirect({ conv: null, agent: null })).toBeNull(); });
  it('추천 앱은 새 문서 업무 다섯 종이다', () => { expect(new Set(FEATURED_WORKFLOWS).size).toBe(5); expect(FEATURED_WORKFLOWS).toContain('document-faq'); });
});
