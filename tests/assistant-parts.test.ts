// tests/assistant-parts.test.ts
import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, buildUserContent, storedUserContent, DEFAULT_SYSTEM_PROMPT } from '@/lib/assistant/prompt';
import { trimHistory } from '@/lib/assistant/history';
import { buildMessageRows, dedupeLinks, mergeUsageByModel, buildUsageDetails } from '@/lib/assistant/persist';

describe('시스템 프롬프트', () => {
  it('비서 지시문 뒤에 능력의 글을 붙인다', () => {
    expect(buildSystemPrompt('공문을 씁니다.', ['참고 자료:\n...', undefined])).toBe('공문을 씁니다.\n\n참고 자료:\n...');
  });

  it('지시문이 없으면 기본 문장', () => {
    expect(buildSystemPrompt(null, [])).toBe(DEFAULT_SYSTEM_PROMPT);
  });
});

describe('사용자 내용', () => {
  const img = { media_type: 'image/png', data: 'AAAA' };

  it('사진을 글보다 앞에 둔다', () => {
    // Anthropic 권장. 모델이 무엇을 보고 답할지 먼저 잡는다.
    const content = buildUserContent('이 표 설명해줘', [img as never]);
    expect(Array.isArray(content)).toBe(true);
    expect((content as { type: string }[]).map((b) => b.type)).toEqual(['image', 'text']);
  });

  it('사진이 없으면 글만', () => {
    expect(buildUserContent('안녕', [])).toBe('안녕');
  });

  it('저장할 때는 사진 바이트 대신 표시만 남긴다', () => {
    const stored = storedUserContent('이 표 설명해줘', 2);
    expect(stored).toContain('2장');
    expect(stored).toContain('이 표 설명해줘');
    expect(stored).not.toContain('AAAA');
  });
});

describe('이력 다듬기', () => {
  it('시간순으로 되돌리고 user로 시작하게 한다', () => {
    // 조회는 최신순으로 한다
    const rows = [
      { role: 'assistant', content: '답2' },
      { role: 'user', content: '질문2' },
      { role: 'assistant', content: '답1' },
      { role: 'system', content: '무시' },
      { role: 'user', content: '  ' },
    ];
    // 시간순: 답1 → 질문2 → 답2. 맨 앞의 답1은 user가 아니라 잘린다.
    expect(trimHistory(rows)).toEqual([
      { role: 'user', content: '질문2' },
      { role: 'assistant', content: '답2' },
    ]);
  });
});

describe('메시지 저장 행', () => {
  const rows = buildMessageRows({
    conversationId: 'c', userId: 'u', userContent: '질문', assistantText: '답',
    chunks: [{ documentId: 'd', documentTitle: 't', chunkIndex: 0, text: '본문', similarity: 0.4 }],
    links: [{ title: '법', url: 'https://a' }],
    agentVersion: 7,
  });

  it('두 행의 키 집합이 같다', () => {
    // PostgREST 배치 삽입은 빠진 칸에 명시적 NULL을 넣는다. 실제로 이것 때문에
    // 대화가 한 건도 저장되지 않았다.
    const keys = rows.map((r) => Object.keys(r).sort().join(','));
    expect(keys[0]).toBe(keys[1]);
  });

  it('답한 판 번호를 남긴다', () => {
    expect(rows.every((r) => r.agent_version === 7)).toBe(true);
  });

  it('출처에는 조각 본문을 싣지 않는다', () => {
    const refs = rows[1].source_references as { chunks: Record<string, unknown>[] };
    expect(refs.chunks[0]).not.toHaveProperty('text');
  });
});

describe('출처와 사용량', () => {
  it('같은 주소의 출처는 하나만', () => {
    expect(dedupeLinks([{ title: 'a', url: 'u' }, { title: 'b', url: 'u' }])).toEqual([{ title: 'a', url: 'u' }]);
  });

  it('모델별로 합친다', () => {
    expect(
      mergeUsageByModel([
        { model: 'm1', input_tokens: 1, output_tokens: 2 },
        { model: 'm2', input_tokens: 5, output_tokens: 5 },
        { model: 'm1', input_tokens: 3, output_tokens: 4 },
      ])
    ).toEqual([
      { model: 'm1', input_tokens: 4, output_tokens: 6 },
      { model: 'm2', input_tokens: 5, output_tokens: 5 },
    ]);
  });

  it('과금 규약 칸을 모두 채운다', () => {
    const d = buildUsageDetails({ model: 'claude-haiku-4-5', input_tokens: 1000, output_tokens: 1000 }, { agent_id: 'a' });
    for (const key of ['model', 'input_tokens', 'output_tokens', 'cost_usd', 'cost_krw', 'agent_id']) {
      expect(d).toHaveProperty(key);
    }
    expect(d.model).toBe('claude-haiku-4-5');
  });
});
