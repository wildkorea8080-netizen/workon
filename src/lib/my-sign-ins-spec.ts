/**
 * 내 로그인 기록 — 화면·서버 공용(2026-11-16). 아무것도 import하지 않는다(화면이 읽는다).
 * 직원이 자기 계정에 남이 들어왔는지 스스로 알아챌 수 있게 최근 로그인(성공·실패·잠김·거절)을 보인다.
 */

export type MySignIn = {
  at: string;
  action: 'login' | 'login_failed' | 'login_locked' | 'login_rejected' | string;
  ip: string | null;
  device: string;
};

export const MY_SIGN_INS_DAYS = 90;
export const MY_SIGN_INS_LIMIT = 30;

export const SIGN_IN_ACTION_LABEL: Record<string, string> = {
  login: '로그인',
  login_failed: '비밀번호 틀림',
  login_locked: '잠김(실패 반복)',
  login_rejected: '거절(비활성·소속 없음)',
};

/** 브라우저 정보를 사람이 읽을 짧은 꼴로 — '윈도우 · 크롬'. 모르면 '알 수 없는 기기' */
export function deviceLabel(ua: string | null | undefined): string {
  if (!ua) return '알 수 없는 기기';
  const os = /Windows/i.test(ua) ? '윈도우'
    : /iPhone|iPad/i.test(ua) ? 'iOS'
    : /Android/i.test(ua) ? '안드로이드'
    : /Mac OS X|Macintosh/i.test(ua) ? '맥'
    : /Linux/i.test(ua) ? '리눅스' : null;
  const browser = /Whale\//i.test(ua) ? '웨일'
    : /Edg\//i.test(ua) ? '엣지'
    : /SamsungBrowser\//i.test(ua) ? '삼성 인터넷'
    : /Firefox\//i.test(ua) ? '파이어폭스'
    : /Chrome\//i.test(ua) ? '크롬'
    : /Safari\//i.test(ua) ? '사파리' : null;
  const parts = [os, browser].filter(Boolean);
  return parts.length ? parts.join(' · ') : '알 수 없는 기기';
}

/** 최근 30일 실패(틀림·잠김) 수 — 화면이 경고를 띄울지 정한다 */
export function recentFailures(list: MySignIn[], nowMs = Date.now()): number {
  const since = nowMs - 30 * 86_400_000;
  return list.filter((s) => (s.action === 'login_failed' || s.action === 'login_locked') && Date.parse(s.at) >= since).length;
}
