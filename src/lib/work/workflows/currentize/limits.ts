// src/lib/work/workflows/currentize/limits.ts
/**
 * 현행화(작년 문서 → 올해 문서) 상한 — 아무것도 import하지 않는다(화면도 읽는다).
 */
/** 작년 파일 하나의 크기 상한 */
export const MAX_PRIOR_BYTES = 50 * 1024 * 1024;
/** 작년 문서에서 뽑는 조각(문단·칸) 수 상한 */
export const MAX_SEGMENTS = 5000;
/** 모델 한 번에 보내는 조각 수 */
export const MODEL_BATCH_SEGMENTS = 50;
/** 한 번의 현행화에 쓸 수 있는 모델 비용 기본 상한(원) */
export const DEFAULT_COST_CAP_KRW = 2000;
