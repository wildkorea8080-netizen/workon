/**
 * 업무 홈에서 바로 묻기(2026-11-06) — 홈 입력창에 적은 질문을 AI 대화 화면(`/chat`)으로 넘긴다.
 * 웍스AI·알리웍스처럼 홈에서 비서를 고르지 않고 물으면 대화가 시작된다.
 *
 * **주소에 싣지 않는다**(`/chat?q=…` 아님). 질문에는 개인·업무 정보가 들어 있기 쉬운데 주소는 방문 기록·서버 접속 기록·
 * 공유 링크에 남는다. 이 탭의 sessionStorage에 잠깐 두고, 대화 화면이 열리자마자 한 번 꺼내 지운다.
 * 2분이 지난 질문은 버린다(홈에서 넘기다 멈춘 질문이 한참 뒤 엉뚱하게 보내지지 않게).
 *
 * 아무것도 import하지 않는 잎 파일
 */
export const CHAT_HANDOFF_KEY = 'workon:chat-handoff';
export const CHAT_HANDOFF_MAX_AGE_MS = 2 * 60 * 1000;
/** 넘길 수 있는 질문 길이 — 이보다 길면 대화 화면에서 첨부로 붙이게 안내 */
export const CHAT_HANDOFF_MAX_CHARS = 4000;

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function storage(): Store | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** 질문을 넘길 자리에 둔다. 못 두면(저장소를 못 씀·빈 질문·너무 김) false — 화면은 질문을 그대로 둔다 */
export function stashQuestion(text: string, now = Date.now(), store: Store | null = storage()): boolean {
  const question = text.trim();
  if (!question || question.length > CHAT_HANDOFF_MAX_CHARS || !store) return false;
  try {
    store.setItem(CHAT_HANDOFF_KEY, JSON.stringify({ question, at: now }));
    return true;
  } catch {
    return false;
  }
}

/** 넘겨받은 질문을 한 번만 꺼낸다(읽으면 지움). 없거나·낡았거나·꼴이 틀리면 null */
export function takeQuestion(now = Date.now(), store: Store | null = storage()): string | null {
  if (!store) return null;
  let raw: string | null = null;
  try {
    raw = store.getItem(CHAT_HANDOFF_KEY);
    store.removeItem(CHAT_HANDOFF_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { question?: unknown; at?: unknown };
    if (typeof parsed.question !== 'string' || typeof parsed.at !== 'number') return null;
    const age = now - parsed.at;
    if (age < 0 || age > CHAT_HANDOFF_MAX_AGE_MS) return null;
    const question = parsed.question.trim();
    return question && question.length <= CHAT_HANDOFF_MAX_CHARS ? question : null;
  } catch {
    return null;
  }
}
