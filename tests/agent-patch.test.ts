// tests/agent-patch.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { splitAgentBody, changedSettingKeys, SNAPSHOT_KEYS, parseBaseVersion } from '@/lib/agent-patch';

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

  it('모르는 칸은 저장하지 않는다', () => {
    // 0028이 지운 옛 커넥터 칸 등. 화면에 남은 값이 칸으로 새어 들어가지 않는다.
    const r = splitAgentBody({ unknown_column: ['law'] }, opts);
    expect(r.error).toBeUndefined();
    expect(r.settings).toEqual({});
    expect(r.operational).toEqual({});
  });

  it('template_ids는 본문으로 받지 않는다', () => {
    // 양식은 양식 라우트만 바꾼다. 본문으로 받으면 남의 파일 id를 끼워 넣을 수 있다.
    expect(splitAgentBody({ template_ids: ['x'] }, opts).error).toBeDefined();
  });

  it('잘못된 공개 범위는 거절한다', () => {
    expect(splitAgentBody({ visibility: 'all' }, opts).error).toBeDefined();
  });
});

describe('판 번호 읽기 (폼·주소 값)', () => {
  it('숫자 문자열만 받는다', () => {
    expect(parseBaseVersion('3')).toBe(3);
    expect(parseBaseVersion('0')).toBe(0);
  });

  it('빈 값·누락은 판 번호가 아니다', () => {
    // Number('')와 Number(null)은 0이라, 예전에는 판 0으로 저장을 시도했다
    expect(parseBaseVersion('')).toBeNull();
    expect(parseBaseVersion(null)).toBeNull();
    expect(parseBaseVersion(undefined)).toBeNull();
  });

  it('숫자처럼 보이는 다른 꼴도 받지 않는다', () => {
    for (const raw of [' 3', '3.0', '-1', '1e2', '0x10', 'abc']) {
      expect(parseBaseVersion(raw), raw).toBeNull();
    }
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

  it('jsonb의 키 순서가 달라도 같은 능력은 바뀐 것이 아니다', () => {
    // jsonb는 키를 자기 순서로 돌려준다. 순서 차이를 바뀜으로 보면 빈 판이 쌓인다.
    expect(
      changedSettingKeys({ capabilities: { image: {}, doc_search: {} } }, { capabilities: { doc_search: {}, image: {} } })
    ).toEqual([]);
  });

  it('커넥터 순서가 달라지면 바뀐 것이다', () => {
    // 배열 순서는 실제 변경이다. 키 정렬이 배열까지 건드리면 이 테스트가 깨진다.
    expect(
      changedSettingKeys(
        { capabilities: { public_data: { connectors: ['law', 'kosis'] } } },
        { capabilities: { public_data: { connectors: ['kosis', 'law'] } } }
      )
    ).toEqual(['capabilities']);
  });

  it('판 사본 칸은 11개다', () => {
    expect(SNAPSHOT_KEYS).toHaveLength(11);
  });

  it('SNAPSHOT_KEYS가 0026의 agent_snapshot과 같다', () => {
    // 한쪽에만 칸을 더하면 바뀐 칸 찾기·되돌리기가 그 칸을 조용히 빠뜨린다.
    const sql = readFileSync('supabase/migrations/0026_agent_tiers.sql', 'utf8');
    const start = sql.indexOf('CREATE OR REPLACE FUNCTION agent_snapshot');
    const body = sql.slice(start, sql.indexOf('$$;', start));
    const keys = [...body.matchAll(/'(\w+)',/g)].map((m) => m[1]);
    expect(keys).toHaveLength(11);
    expect(new Set(keys)).toEqual(new Set(SNAPSHOT_KEYS));
  });
});
