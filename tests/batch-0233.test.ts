import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { DISCARDED_LOAD, fetchConversation, loadStep, prevAfterDiscard } from '@/lib/conversation-load';

/**
 * 2026-11-20 — 저장된 대화를 열다 못 읽은 것을 조용히 넘기지 않는다.
 * ① 대화 화면(`ChatInterface`): 다른 대화로 바꿀 때 읽기에 실패하면(503·연결 실패) 아무것도 하지 않아,
 *    **앞 대화의 메시지가 새 대화 아래 그대로 남았다**(보낸 글은 새 대화로 간다). 첫 화면에서 열었으면 빈 새 대화 안내가 보여
 *    대화 내용이 사라진 줄 알았다. 빠르게 바꾸면 늦게 온 앞 대화의 응답이 지금 대화를 덮을 수도 있었다.
 * ② 대화 고르기(`ChatHome`): 사이드바에서 대화를 눌렀는데 못 읽으면 조용히 끝나 아무 일이 없었다.
 * 이제 읽기 전에 앞 메시지를 지우고, 못 읽으면 알리고(다시 불러오기), 늦은 응답은 버린다.
 * '어느 대화를 읽을지'는 `conversation-load.ts`가 정한다 — 아래에서 화면의 효과가 도는 순서대로 돌려 본다.
 */

/** 화면의 효과를 흉내 낸다 — 효과가 돌면 `loadStep`, 읽기를 건 실행은 다음 실행 전에 버림(cleanup)이 먼저 돈다 */
function screen() {
  let prev: string | null = null;
  let pendingCleanup: (() => void) | null = null;
  const did: string[] = [];
  return {
    did,
    /** 대화 id가 바뀌어(또는 다시 그려져) 효과가 돈다 */
    run(conversationId: string | null) {
      if (pendingCleanup) { pendingCleanup(); pendingCleanup = null; }
      const step = loadStep(prev, conversationId);
      did.push(step);
      if (step === 'same') return;
      prev = conversationId;
      if (step === 'load') pendingCleanup = () => { prev = prevAfterDiscard(prev, conversationId); };
    },
    /** 첫 질문을 보내 대화가 생김 — 화면이 미리 그 id를 적어 둔다 */
    created(id: string) { prev = id; },
    /** '다시 불러오기' */
    retry() { prev = null; },
  };
}

describe('어느 대화를 읽을지', () => {
  it('저장된 대화를 열면 읽고, 다른 대화로 바꾸면 또 읽는다', () => {
    const s = screen();
    s.run('A'); s.run('B');
    expect(s.did).toEqual(['load', 'load']);
  });

  it('읽는 도중 새 대화로 가도 비운다 — 버린 읽기 때문에 읽는 중 표시가 멈추지 않게', () => {
    const s = screen();
    s.run('A'); s.run(null);
    expect(s.did).toEqual(['load', 'blank']);
  });

  it('방금 만든 대화는 다시 읽지 않는다(흘러나오는 답을 지우지 않음)', () => {
    const s = screen();
    s.run(null); s.created('N'); s.run('N');
    // 처음 열린 새 대화는 이미 비어 있어 할 일이 없다('same'), 만든 대화도 그대로 둔다
    expect(s.did).toEqual(['same', 'same']);
  });

  it('저장된 대화를 보다가 새 대화를 만들어도 다시 읽지 않는다', () => {
    const s = screen();
    s.run('A'); s.run(null); s.created('N'); s.run('N');
    expect(s.did).toEqual(['load', 'blank', 'same']);
  });

  it('같은 대화로 효과가 두 번 돌면(개발 모드) 두 번째가 다시 읽는다 — 첫 읽기는 버려졌다', () => {
    const s = screen();
    s.run('A'); s.run('A');
    expect(s.did).toEqual(['load', 'load']);
  });

  it('다시 불러오기는 같은 대화를 다시 읽는다', () => {
    const s = screen();
    s.run('A'); s.retry(); s.run('A');
    expect(s.did).toEqual(['load', 'load']);
  });

  it('버림 표시는 어느 대화 id·새 대화와도 같지 않다', () => {
    expect(loadStep(DISCARDED_LOAD, null)).toBe('blank');
    expect(loadStep(DISCARDED_LOAD, 'A')).toBe('load');
    // 그 사이 다른 대화를 다뤘으면 버림이 그 기록을 덮지 않는다
    expect(prevAfterDiscard('B', 'A')).toBe('B');
    expect(prevAfterDiscard('A', 'A')).toBe(DISCARDED_LOAD);
  });
});

describe('fetchConversation', () => {
  const res = (status: number, body: unknown) => async () => ({ status, json: async () => body });

  it('읽히면 그 대화', async () => {
    expect(await fetchConversation('a b', async (url) => {
      expect(url).toBe('/api/conversations/a%20b');
      return { status: 200, json: async () => ({ ok: true, data: { messages: [1] } }) };
    })).toEqual({ ok: true, data: { messages: [1] } });
  });
  it('없는 대화(404)와 지금 못 읽은 것(503)을 가른다', async () => {
    expect(await fetchConversation('a', res(404, { ok: false }))).toEqual({ ok: false, notFound: true });
    expect(await fetchConversation('a', res(503, { ok: false }))).toEqual({ ok: false, notFound: false });
  });
  it('몸을 못 읽거나 연결이 끊겨도 던지지 않는다', async () => {
    expect(await fetchConversation('a', async () => ({ status: 200, json: async () => { throw new SyntaxError('html'); } }))).toEqual({ ok: false, notFound: false });
    expect(await fetchConversation('a', async () => { throw new TypeError('fetch failed'); })).toEqual({ ok: false, notFound: false });
  });
});

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

describe('대화 화면 (원본)', () => {
  const src = read('src/components/chat/ChatInterface.tsx');
  const effect = src.slice(src.indexOf('// conversationId가 바뀌면 메시지 로드'), src.indexOf('// 에이전트가 바뀌면 메시지 초기화'));

  it('효과가 위 규칙을 쓴다', () => {
    expect(effect).toContain('const step = loadStep(prevConvIdRef.current, conversationId);');
    expect(effect).toContain("if (step === 'same') return;");
    expect(effect).toContain('prevConvIdRef.current = prevAfterDiscard(prevConvIdRef.current, conversationId);');
    expect(src).toContain('prevConvIdRef.current = payload.conversation_id;');
  });

  it('다른 대화를 읽기 전에 앞 대화의 메시지를 지운다', () => {
    const before = effect.slice(effect.indexOf('let active = true;'), effect.indexOf('fetchConversation<'));
    expect(before).toContain('setMessages([]);');
    expect(before).toContain('setConvLoadError(null);');
    expect(before).toContain('setLoadingConv(true);');
  });

  it('못 읽으면 알리고, 늦게 온 앞 대화의 응답은 버린다', () => {
    expect(effect).toContain('if (!active) return;');
    expect(effect).toContain('setConvLoadError(loaded.notFound ? CONV_NOT_FOUND : CONV_LOAD_FAILED);');
    expect(effect).toContain('.finally(() => { if (active) setLoadingConv(false); });');
    expect(effect).not.toContain('.catch(() => {})');
  });

  it('새 대화로 갈 때 읽는 중 표시·오류를 함께 지운다', () => {
    const blank = effect.slice(effect.indexOf("if (step === 'blank' || !conversationId) {"), effect.indexOf('let active = true;'));
    expect(blank).toContain('setMessages([]);');
    expect(blank).toContain('setConvLoadError(null);');
    expect(blank).toContain('setLoadingConv(false);');
  });

  it('못 읽은 화면은 빈 새 대화 안내 대신 까닭과 다시 불러오기를 보인다', () => {
    const at = src.indexOf(') : convLoadError ? (');
    expect(at).toBeGreaterThan(src.indexOf('{loadingConv ? ('));
    expect(at).toBeLessThan(src.indexOf(') : messages.length === 0 ? ('));
    expect(src).toContain('onClick={() => { prevConvIdRef.current = null; setConvReload(n => n + 1); }}');
    expect(src).toContain('}, [conversationId, convReload]);');
    expect(src).toContain("const CONV_LOAD_FAILED = '대화를 지금 불러오지 못했습니다. 앞서 나눈 내용은 지워지지 않았습니다.';");
  });
});

describe('대화 고르기 (원본)', () => {
  const src = read('src/components/chat/ChatHome.tsx');
  const fn = src.slice(src.indexOf('const handleConversationSelect = useCallback'), src.indexOf('const handleNewConversation'));

  it('열지 못하면 알린다(조용히 끝내지 않음)', () => {
    expect(fn).toContain("setOpenError(res.status === 404 ? '대화를 찾을 수 없습니다.' : CONVERSATION_OPEN_FAILED);");
    expect(fn).toContain('} catch {\n      setOpenError(CONVERSATION_OPEN_FAILED);');
    expect(fn).not.toContain('// silent');
    expect(fn).toContain('setOpenError(null);');
  });
  it('알림은 화면에 그려진다', () => {
    expect(src).toContain('{openError && <p role="alert" className="bg-amber-50 px-4 py-3 text-sm text-amber-800">{openError}</p>}');
  });
  it('못 열었을 때 대화를 바꾸지 않는다', () => {
    const fail = fn.slice(fn.indexOf('if (!result?.ok) {'), fn.indexOf('const conv = result.data;'));
    expect(fail).toContain('return;');
    expect(fail).not.toContain('setConversationId');
  });
});
