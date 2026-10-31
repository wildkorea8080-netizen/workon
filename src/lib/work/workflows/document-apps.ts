/** 문서 앱은 같은 필드 생성기를 사용하되 입력 한도·수치 검사 정책을 명시한다. */
const POLICIES: Record<string, { label: string; maxSources: number; maxChars: number; targetLabels: string[]; mainLabel: string }> = {
  'document-summary': { label: '문서 요약', maxSources: Infinity, maxChars: 40000, targetLabels: ['개요', '주요 내용'], mainLabel: '주요 내용' },
  'document-rewrite': { label: '문장 교정·변환', maxSources: 1, maxChars: 12000, targetLabels: ['개요', '주요 내용'], mainLabel: '주요 내용' },
  'document-translation': { label: '문서 번역', maxSources: 1, maxChars: 8000, targetLabels: ['개요', '주요 내용'], mainLabel: '주요 내용' },
  'document-faq': { label: '문서 기반 FAQ 초안', maxSources: 3, maxChars: 12000, targetLabels: ['개요', '주요 내용'], mainLabel: '주요 내용' },
  'meeting-agenda': { label: '회의 안건 초안', maxSources: 3, maxChars: 12000, targetLabels: ['안건', '논의 내용'], mainLabel: '안건' },
};
export const getDocumentAppPolicy = (key: string) => Object.prototype.hasOwnProperty.call(POLICIES, key) ? POLICIES[key] : undefined;

export function isDocumentAppTarget(key: string, label: string): boolean {
  const policy = getDocumentAppPolicy(key);
  return !policy || policy.targetLabels.includes(label);
}
