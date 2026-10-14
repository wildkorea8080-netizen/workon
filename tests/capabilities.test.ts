// tests/capabilities.test.ts
import { describe, it, expect } from 'vitest';
import { CAPABILITY_IDS } from '@/lib/capabilities/settings';
import { CAPABILITIES, activeCapabilities, toolsFor, effectiveCapabilities } from '@/lib/capabilities';
import { createDocSearch, docSearchAddendum } from '@/lib/capabilities/doc-search';
import type { TurnContext } from '@/lib/capabilities/types';
import type { RetrievedChunk } from '@/lib/db';

const ctx = (over: Partial<TurnContext> = {}): TurnContext => ({
  organizationId: 'org', departmentId: 'dept', userId: 'u', agentId: 'a', agentVersion: 1,
  capabilities: {}, message: '여비 규정', ...over,
});

const chunk: RetrievedChunk = { documentId: 'd1', documentTitle: '여비규정', chunkIndex: 0, text: '국내 출장 일비 2만원', similarity: 0.45 };

describe('능력 목록', () => {
  it('id가 설정 목록과 같다', () => {
    // 설정 정규화(settings.ts)와 실행(index.ts)이 다른 능력을 알면 안 된다
    expect(CAPABILITIES.map((c) => c.id).sort()).toEqual([...CAPABILITY_IDS].sort());
  });

  it('켜진 능력만 고른다', () => {
    expect(activeCapabilities({ image: {} }).map((c) => c.id)).toEqual(['image']);
    expect(activeCapabilities({})).toEqual([]);
  });

  it('도구 이름이 겹치지 않는다', () => {
    const all = CAPABILITIES.flatMap((c) =>
      (c.tools?.(ctx({ capabilities: { public_data: { connectors: ['law', 'kosis', 'g2b', 'dart'] } } })) ?? []).map((t) => t.name)
    );
    expect(new Set(all).size).toBe(all.length);
  });

  it('격리에 걸리는 값을 AI 입력으로 받지 않는다', () => {
    // 기관·보관함·대상 문서는 서버가 ctx에서 정한다(설계 4.2)
    const FORBIDDEN = ['tenant', 'organization_id', 'organizationId', 'department_id', 'agent_id', 'user_id'];
    const { tools } = toolsFor(CAPABILITIES, ctx({ capabilities: { public_data: { connectors: ['law', 'kosis', 'g2b', 'dart'] } } }));
    for (const tool of tools) {
      const props = Object.keys((tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
      expect(props.filter((p) => FORBIDDEN.includes(p)), tool.name).toEqual([]);
    }
  });
});

describe('대화할 때의 능력', () => {
  const scope = { publicDataConnectors: new Set(['law']) };
  const known = ['law', 'kosis'];

  it('공식 비서는 기관 범위로 자르지 않는다', () => {
    expect(
      effectiveCapabilities({ public_data: { connectors: ['kosis'] } }, { tier: 'official', scope, knownConnectorIds: known })
    ).toEqual({ public_data: { connectors: ['kosis'] } });
  });

  it('부서 비서는 기관이 끈 연결을 뺀다', () => {
    expect(
      effectiveCapabilities({ image: {}, public_data: { connectors: ['law', 'kosis'] } }, { tier: 'department', scope, knownConnectorIds: known })
    ).toEqual({ image: {}, public_data: { connectors: ['law'] } });
  });

  it('저장된 값이 깨져 있으면 아무 능력도 켜지 않는다', () => {
    expect(effectiveCapabilities({ unknown_cap: {} }, { tier: 'official', scope, knownConnectorIds: known })).toEqual({});
    expect(effectiveCapabilities('x', { tier: 'official', scope, knownConnectorIds: known })).toEqual({});
  });

  it('키가 빠진 커넥터는 공식 비서에서도 뺀다', () => {
    expect(
      effectiveCapabilities({ public_data: { connectors: ['law', 'g2b'] } }, { tier: 'official', scope, knownConnectorIds: known })
    ).toEqual({ public_data: { connectors: ['law'] } });
  });
});

describe('참고 문서 찾기', () => {
  it('찾으면 자료와 인용 규칙을 함께 붙인다', () => {
    const text = docSearchAddendum([chunk], true)!;
    expect(text).toContain('참고 자료:');
    expect(text).toContain('[참고 자료: 여비규정]');
    expect(text).toContain('[자료 인용 규칙]');
    // 단위를 임의로 붙이지 말라는 지침이 핵심이다
    expect(text).toContain('자료에 없는 단위');
  });

  it('문서는 있는데 못 찾으면 근거 없음을 밝히게 한다', () => {
    expect(docSearchAddendum([], true)).toContain('[문서 검색 결과 없음]');
  });

  it('문서가 없으면 아무것도 붙이지 않는다', () => {
    expect(docSearchAddendum([], false)).toBeUndefined();
  });

  it('검색이 실패해도 대화는 이어진다', async () => {
    const cap = createDocSearch({
      retrieve: async () => { throw new Error('임베딩 실패'); },
      hasDocuments: async () => true,
    });
    const result = await cap.prepare!(ctx());
    expect(result.chunks).toEqual([]);
    expect(result.systemAddendum).toContain('[문서 검색 결과 없음]');
  });

  it('찾은 조각을 출처로 돌려준다', async () => {
    const cap = createDocSearch({ retrieve: async () => [chunk], hasDocuments: async () => true });
    expect((await cap.prepare!(ctx())).chunks).toEqual([chunk]);
  });
});
