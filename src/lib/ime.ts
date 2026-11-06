/**
 * 한글 입력(IME) 조합 중인 키 입력인가(2026-11-06).
 *
 * 한글은 글자를 조합하는 중에도 keydown이 온다. 조합 중에 Enter를 처리하면 브라우저에 따라
 * ① 마지막 글자가 조합 끝에 한 번 더 들어와 보낸 뒤 입력창에 남거나(맥 Chrome 등) ② 같은 질문이 두 번 가거나
 * ③ 덜 조합된 글로 찾기·이름 바꾸기가 된다. 조합 중 Enter는 조합을 끝내는 키로만 두고, 끝난 뒤의 Enter로 보낸다.
 *
 * - `isComposing`: 표준(조합 중이면 참)
 * - `keyCode === 229`: 조합을 끝내는 Enter를 `isComposing` 없이 주는 브라우저(Safari 등)
 *
 * Enter로 무언가를 보내는 키 처리는 모두 이것을 먼저 본다 — `tests/ime-enter.test.ts`가 빠진 곳을 찾는다.
 * 아무것도 import하지 않는 잎 파일
 */
export function isImeComposing(e: { nativeEvent?: { isComposing?: boolean }; keyCode?: number }): boolean {
  return Boolean(e.nativeEvent?.isComposing) || e.keyCode === 229;
}
