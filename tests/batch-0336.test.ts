// tests/batch-0336.test.ts
// 나만의 비서·앱 지우기 단추(2026-11-27, 마이그레이션 없음) — 지우는 API는 있었지만 직원 화면에 단추가 없었다(운영 화면 확인에서 찾음).
import { readFileSync } from 'fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null }) }));
import AgentCard from '@/components/chat/AgentCard';
import type { Agent } from '@/lib/db';

const agent = (over: Partial<Agent> = {}) => ({ id: 'a1', name: '내 앱', description: '', tier: 'personal', department_id: 'd1', icon: '🧩', ...over }) as unknown as Agent;
const render = (a: Agent, onDeleted?: () => void) => renderToStaticMarkup(createElement(AgentCard, { agent: a, isFavorite: false, onFavoriteToggle: () => {}, onSelect: () => {}, myDepartmentId: 'd1', onEdit: () => {}, ...(onDeleted ? { onDeleted } : {}) }));

describe('지우기 단추', () => {
  it('내 나만의 비서에만 — 공유받은 비서·부서 비서·다시 읽기를 안 주면 없음', () => {
    expect(render(agent(), () => {})).toContain('지우기');
    expect(render(agent({ shared_with_me: true } as Partial<Agent>), () => {})).not.toContain('지우기');
    expect(render(agent({ tier: 'department' } as Partial<Agent>), () => {})).not.toContain('지우기');
    expect(render(agent())).not.toContain('지우기');
  });
  it('연결 — 확인 뒤 DELETE, 목록이 다시 읽고 고른 비서면 풂', () => {
    const card = readFileSync('src/components/chat/AgentCard.tsx', 'utf8');
    expect(card).toContain("requestJson(`/api/agents/${agent.id}`, { method: 'DELETE' })");
    expect(card).toContain('if (!confirm(');
    // 지우는 동안 단추를 막고 '지우는 중…'(몇 초 걸림), 좁은 카드에서 단추 글자가 접히지 않게(2026-11-27 운영 화면 확인)
    expect(card).toContain("{deleting ? '지우는 중…' : '지우기'}");
    expect(card).toContain('disabled={deleting}');
    expect(card).toContain('flex-1 whitespace-nowrap py-1.5 px-1 text-xs font-semibold text-emerald-700');
    expect(readFileSync('src/components/chat/AgentSelector.tsx', 'utf8')).toContain('onDeleted={() => { if (selectedAgent?.id === agent.id) onAgentSelect(null); fetchAgents(activeTab); }}');
  });
});
