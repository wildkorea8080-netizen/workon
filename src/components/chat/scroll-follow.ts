/**
 * 답변이 흘러나오는 동안 화면을 맨 아래로 따라 내릴지 정한다.
 *
 * 사용자가 맨 아래 근처에 있을 때만 따라간다. 위로 올려 읽는 중에 글자 조각마다 끌어내리면
 * 참고 자료·출처 때문에 위로 밀린 답을 읽을 수 없다.
 */
export const FOLLOW_THRESHOLD_PX = 80;

export function isNearBottom(el: { scrollHeight: number; scrollTop: number; clientHeight: number }): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_THRESHOLD_PX;
}
