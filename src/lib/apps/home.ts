/** 대화 딥링크는 새 홈에서도 기존 대화로 보낸다. 새 대화나 모델 호출을 만들지 않는다. */
export function homeChatRedirect(params: { conv: string | null; agent: string | null }): string | null {
  const value = params.conv ? ['conv', params.conv] : params.agent ? ['agent', params.agent] : null;
  return value ? `/chat?${value[0]}=${encodeURIComponent(value[1])}` : null;
}
export const FEATURED_WORKFLOWS = ['document-summary', 'document-rewrite', 'document-translation', 'meeting-agenda', 'document-faq'] as const;
