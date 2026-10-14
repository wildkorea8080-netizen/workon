// tests/agent-patch.test.ts
import { describe, it, expect } from 'vitest';
import { splitAgentBody, changedSettingKeys, SNAPSHOT_KEYS } from '@/lib/agent-patch';

const opts = { currentType: 'chat' as const, knownConnectorIds: ['law'], knownModelIds: ['claude-sonnet-4-6', 'claude-haiku-4-5'] };

describe('요청 본문 나누기', () => {
  it('판 설정과 운영 값을 가른다', () => {
    const r = splitAgentBody(
      { name: ' 공문 비서 ', system_prompt: '지시', is_published: true, display_order: 3, visibility: 'department' },
      opts
    );
    expect(r.error).toBeUndefined();
    expect(r.settings).toEqual({ name: '공문 비서', system_prompt: '지시' });
    expect(r.operational).toEqual({ is_published: true, display_order: 3, visibility: 'department' });
  });

  it('카탈로그 칸도 성격대로 나눈다', () => {
    const r = splitAgentBody({ icon: '📨', usage_guide: '안내', starter_prompts: 'a\nb', agent_type: 'chat' }, opts);
    expect(r.settings).toEqual({ icon: '📨', usage_guide: '안내', starter_prompts: ['a', 'b'] });
    // 대화형으로 되돌리면 주소를 비운다(parseCatalogFields) — 운영 값으로 함께 간다
    expect(r.operational).toEqual({ agent_type: 'chat', link_url: null });
  });

  it('빈 이름은 거절한다', () => {
    expect(splitAgentBody({ name: '  ' }, opts).error).toBe('비서 이름은 비워 둘 수 없습니다.');
  });

  it('모델은 등록된 것만, 빈 값은 기본 모델', () => {
    expect(splitAgentBody({ model_id: 'claude-haiku-4-5' }, opts).settings.model_id).toBe('claude-haiku-4-5');
    expect(splitAgentBody({ model_id: '' }, opts).settings.model_id).toBeNull();
    expect(splitAgentBody({ model_id: 'gpt-5' }, opts).error).toBe('등록되지 않은 모델입니다.');
  });

  it('능력은 정규화해서 받는다', () => {
    const r = splitAgentBody({ capabilities: { image: {}, public_data: { connectors: ['law'] } } }, opts);
    expect(r.settings.capabilities).toEqual({ image: {}, public_data: { connectors: ['law'] } });
  });

  it('옛 enabled_connectors는 받지 않는다', () => {
    // 옛 화면이 남아 있으면 조용히 무시되지 않고 드러나야 한다
    expect(splitAgentBody({ enabled_connectors: ['law'] }, opts).error).toContain('capabilities');
  });

  it('template_ids는 본문으로 받지 않는다', () => {
    // 양식은 양식 라우트만 바꾼다. 본문으로 받으면 남의 파일 id를 끼워 넣을 수 있다.
    expect(splitAgentBody({ template_ids: ['x'] }, opts).error).toBeDefined();
  });

  it('잘못된 공개 범위는 거절한다', () => {
    expect(splitAgentBody({ visibility: 'all' }, opts).error).toBeDefined();
  });
});

describe('바뀐 칸 찾기', () => {
  it('같은 값을 다시 보내면 바뀐 것이 없다', () => {
    const current = { name: 'A', starter_prompts: ['x'], capabilities: { image: {} } };
    expect(changedSettingKeys(current, { name: 'A', starter_prompts: ['x'], capabilities: { image: {} } })).toEqual([]);
  });

  it('다른 값만 짚는다', () => {
    expect(changedSettingKeys({ name: 'A', description: null }, { name: 'B', description: null })).toEqual(['name']);
  });

  it('판 사본 칸은 11개다', () => {
    expect(SNAPSHOT_KEYS).toHaveLength(11);
  });
});
