'use client';

// src/lib/use-in-flight.ts
// 처리 중인 조작이 끝날 때까지 같은 조작을 다시 보내지 않게 하는 갈고리(2026-11-23).
//
// 업무 작업실 '검토 완료'·확인 사항 '고쳤음/확인함'·'AI 수정 적용', 변경 기록 '이 판 내용으로 복구', 관리자 비서 카테고리
// '추가'가 처리 중에도 단추가 열려 있었다. 두 번 누르면 첫 요청은 성공하고 둘째가 판이 바뀜(409)·이미 완료·같은 이름으로
// 거절돼, 성공 바로 뒤에 실패 글이 떴다(일부는 판 기록이 하나 더 남을 수 있었다). Enter와 단추가 같은 조작을 부르는 곳도 있어
// 화면 상태(state)만으로는 다시 그리기 전의 두 번째 누름을 못 막는다 — ref로 막고, 단추를 막을 상태도 함께 준다.

import { useCallback, useRef, useState } from 'react';

export function useInFlight() {
  const ref = useRef<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  /** key 조작을 실행 — 다른(같은) 조작이 처리 중이면 아무것도 하지 않는다 */
  const run = useCallback(async (key: string, fn: () => Promise<unknown> | unknown): Promise<void> => {
    if (ref.current !== null) return;
    ref.current = key;
    setRunning(key);
    try {
      await fn();
    } finally {
      ref.current = null;
      setRunning(null);
    }
  }, []);
  return { running, run };
}
