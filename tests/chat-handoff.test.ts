import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import {
  CHAT_HANDOFF_KEY,
  CHAT_HANDOFF_MAX_AGE_MS,
  CHAT_HANDOFF_MAX_CHARS,
  stashQuestion,
  takeQuestion,
} from '@/lib/chat-handoff';

/** 업무 홈에서 바로 묻기(2026-11-06) — 질문은 주소가 아니라 이 탭의 저장소로 넘기고, 대화 화면이 한 번 꺼낸다 */
const read = (p: string) => readFileSync(p, 'utf8');

function memoryStore() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

const throwing = {
  getItem: () => { throw new Error('blocked'); },
  setItem: () => { throw new Error('blocked'); },
  removeItem: () => { throw new Error('blocked'); },
};

describe('질문 넘기기', () => {
  it('넘긴 질문은 한 번만 꺼낸다(앞뒤 공백 떼고)', () => {
    const store = memoryStore();
    expect(stashQuestion('  국외 출장 여비 기준은?  ', 1000, store)).toBe(true);
    expect(JSON.parse(store.map.get(CHAT_HANDOFF_KEY)!)).toEqual({ question: '국외 출장 여비 기준은?', at: 1000 });
    expect(takeQuestion(2000, store)).toBe('국외 출장 여비 기준은?');
    expect(store.map.has(CHAT_HANDOFF_KEY)).toBe(false);
    expect(takeQuestion(2000, store)).toBeNull();
  });

  it('2분이 지났거나 시각이 앞서면 버린다(꺼내면서 지움)', () => {
    const store = memoryStore();
    stashQuestion('질문', 0, store);
    expect(takeQuestion(CHAT_HANDOFF_MAX_AGE_MS + 1, store)).toBeNull();
    expect(store.map.size).toBe(0);
    stashQuestion('질문', 5000, store);
    expect(takeQuestion(4000, store)).toBeNull();
    stashQuestion('질문', 0, store);
    expect(takeQuestion(CHAT_HANDOFF_MAX_AGE_MS, store)).toBe('질문');
  });

  it('빈 질문·너무 긴 질문은 넘기지 않는다', () => {
    const store = memoryStore();
    expect(stashQuestion('   ', 0, store)).toBe(false);
    expect(stashQuestion('가'.repeat(CHAT_HANDOFF_MAX_CHARS + 1), 0, store)).toBe(false);
    expect(stashQuestion('가'.repeat(CHAT_HANDOFF_MAX_CHARS), 0, store)).toBe(true);
  });

  it('꼴이 틀린 값은 null(그래도 지움)', () => {
    const store = memoryStore();
    for (const raw of ['not json', '{"question":3,"at":0}', '{"question":"q"}', '{"question":"  ","at":0}', 'null']) {
      store.map.set(CHAT_HANDOFF_KEY, raw);
      expect(takeQuestion(0, store)).toBeNull();
      expect(store.map.size).toBe(0);
    }
  });

  it('저장소를 못 쓰면 넘기지 못함을 알리고 던지지 않는다', () => {
    expect(stashQuestion('질문', 0, throwing)).toBe(false);
    expect(takeQuestion(0, throwing)).toBeNull();
    expect(stashQuestion('질문', 0, null)).toBe(false);
    expect(takeQuestion(0, null)).toBeNull();
  });

  it('잎 파일·sessionStorage(탭 하나)', () => {
    const src = read('src/lib/chat-handoff.ts');
    expect(src).not.toMatch(/^import /m);
    expect(src).toContain('window.sessionStorage');
    expect(src).not.toContain('localStorage');
  });
});

describe('업무 홈 바로 묻기 연결', () => {
  it('홈 입력창은 저장소로 넘기고 /chat으로 — 질문을 주소에 싣지 않는다', () => {
    const ask = read('src/components/work/HomeAsk.tsx');
    expect(ask).toContain('if (!stashQuestion(question))');
    expect(ask).toContain("router.push('/chat');");
    expect(ask).not.toMatch(/router\.push\([^)]*[?&]/);
    expect(ask).not.toContain('encodeURIComponent');
    // 한글 입력 중 Enter는 보내지 않는다
    expect(ask).toContain('!isImeComposing(e)');
  });

  it('두 업무 홈 모두 바로 묻기를 둔다', () => {
    expect(read('src/components/apps/AppLibrary.tsx')).toContain('{home && <HomeAsk />}');
    expect(read('src/components/work/WorkHome.tsx')).toContain('<HomeAsk />');
  });

  it('대화 화면은 한 번 꺼내 답할 비서로 보내고, 비서가 없으면 입력창에 남긴다', () => {
    const home = read('src/components/chat/ChatHome.tsx');
    expect(home).toContain('if (pendingQuestionRef.current === null) pendingQuestionRef.current = takeQuestion();');
    expect(home).toMatch(/if \(!defaultReady\) return;[\s\S]*pendingQuestionRef\.current = null;/);
    expect(home).toMatch(/if \(!defaultAgent\) \{\s*setQuickInput\(question\);/);
    expect(home).toMatch(/setSelectedAgent\(defaultAgent\);[\s\S]*setInitialMessage\(question\);[\s\S]*setViewMode\('chat'\);/);
    expect(home).toContain('setDefaultReady(true);');
  });
});
