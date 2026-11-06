/**
 * 슈퍼관리자 화면이 보관하는 API 키 종류(2026-11-06) — 지금은 Anthropic 하나.
 * 옛 Voyage(임베딩) 키는 S4-b에서 Voyage 경로를 지운 뒤에도 키 화면·확인 단추에 남아, 확인을 누르면 보관한 키를
 * 쓰지도 않는 바깥 업체(api.voyageai.com)로 보냈다. 저장·확인·표시에서 모두 뺐다(이미 저장된 행은 지우지 않고 화면에서만 안 보임).
 * 아무것도 import하지 않는 잎 파일 — 화면과 라우트가 함께 쓴다
 */
export const API_KEY_PROVIDERS = ['anthropic'] as const;
export type ApiKeyProvider = (typeof API_KEY_PROVIDERS)[number];

export function isApiKeyProvider(v: unknown): v is ApiKeyProvider {
  return typeof v === 'string' && (API_KEY_PROVIDERS as readonly string[]).includes(v);
}

export const UNSUPPORTED_PROVIDER_MESSAGE = '지원하지 않는 키 종류입니다(Anthropic 키만 보관합니다).';
