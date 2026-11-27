// tests/batch-0339.test.ts
// 함께 고치는 사람의 편집 창(2026-11-27 운영 화면 확인에서 찾음) — 공유 탭을 숨기고(주인만 바꿈) 공유 대상 목록을 싣지 않는다.
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

describe('편집 창 비서 읽기(GET /api/agents/[id])', () => {
  const route = readFileSync('src/app/api/agents/[id]/route.ts', 'utf8');
  it('주인이 아닌 나만의 비서면 shared_with_me를 싣고 공유 대상 id를 뺀다', () => {
    expect(route).toContain("if (row.tier === 'personal' && row.owner_id !== actor.userId) {");
    expect(route).toContain('shared_with_me: true, shared_can_edit: true');
    expect(route).toContain('delete rest.shared_user_ids; delete rest.shared_editor_ids; delete rest.shared_department_ids;');
    expect(route).toContain("'이 비서를 고칠 권한이 없습니다.'");
  });
  it('편집 창은 shared_with_me면 공유 탭을 숨긴다', () => {
    expect(readFileSync('src/components/agents/AgentEditorModal.tsx', 'utf8')).toContain("...(agent?.tier === 'personal' && !agent.shared_with_me ? [['shares', '함께 쓰기']] : []),");
  });
});
