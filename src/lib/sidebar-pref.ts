/**
 * 업무 틀 사이드바 접기(2026-11-06) — 알리웍스·웍스AI처럼 왼쪽 사이드바를 아이콘만 남기고 접는다.
 * 접었는지는 이 브라우저에만 기억한다(사람마다의 편의 — 서버에 두지 않음). 저장소를 못 쓰면(사생활 창·막힌 저장소) 펼친 채로 둔다.
 * 아무것도 import하지 않는 잎 파일
 */
export const SIDEBAR_COLLAPSED_KEY = 'workon:sidebar-collapsed';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function storage(): Store | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readSidebarCollapsed(store: Store | null = storage()): boolean {
  try {
    return store?.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeSidebarCollapsed(collapsed: boolean, store: Store | null = storage()): void {
  try {
    if (collapsed) store?.setItem(SIDEBAR_COLLAPSED_KEY, '1');
    else store?.removeItem(SIDEBAR_COLLAPSED_KEY);
  } catch {
    // 저장하지 못해도 이번 화면에서는 접힌다
  }
}
