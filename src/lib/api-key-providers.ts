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

/**
 * 키 화면이 사실대로 말하는 문구(2026-11-06, 사용자 결정) — 여기 저장한 키(시스템·기관별)는 **모델 호출에 쓰지 않는다.**
 * 모든 대화·업무의 호출은 서버 환경 변수 `ANTHROPIC_API_KEY` 하나로 간다(`src/lib/llm/anthropic.ts`).
 * 예전 화면은 'OFF: 기관 자체 키 사용'·'자체 키를 설정하지 않은 기관에서 공용으로 사용'이라 적어, 기관 키를 넣으면
 * 그 기관 사용이 그 키로 청구되는 것처럼 보였다. 기관별 키로 호출하는 기능은 아직 없다
 */
export const STORED_KEYS_NOT_USED_NOTICE =
  '여기 저장한 키는 보관만 합니다. 지금 모든 대화·업무의 모델 호출은 서버 환경 변수(ANTHROPIC_API_KEY)의 키 하나로 가고, 비용은 운영사(WORKON)가 부담합니다. 기관별 키로 호출하는 기능은 아직 없습니다.';
