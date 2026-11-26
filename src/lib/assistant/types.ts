// src/lib/assistant/types.ts
import type { LlmMessage, LlmTool, LlmUsage } from '@/lib/llm/types';
import type { Capability, TurnContext, GeneratedFileRef } from '@/lib/capabilities/types';
import type { ToolSource } from '@/lib/connectors';
import type { RetrievedChunk } from '@/lib/db';

/** Claude에 함께 보낼 직전 대화 메시지 최대 개수 (사용자+어시스턴트 합산) */
export const HISTORY_MESSAGE_LIMIT = 20;
/** 도구 호출 왕복 상한. 모델이 도구만 반복해서 부르는 상황을 끊는다 */
export const MAX_TOOL_ROUNDS = 4;
export const MAX_OUTPUT_TOKENS = 4096;

/**
 * SSE 이벤트. 이름과 기존 페이로드는 S1 이전과 같다. S2-a에서 tool_end에 files를, S3-b에서 done에 number_check를
 * 더했다(첨부 도구를 쓴 턴·S4-b부터 문서 근거 턴의 확인되지 않은 숫자, 없으면 null) — ChatInterface가 읽는다
 */
export type TurnEvent =
  | { event: 'app_step'; data: { index: number; total: number; step: import('@/lib/apps/pipeline').AppStepRecord } }
  /** 긴 첨부 나눠 읽기 — 조각 index를 추리는 중 */
  | { event: 'app_material'; data: { index: number; total: number; phase?: 'reduce' } }
  | { event: 'meta'; data: { conversation_id: string; chunks: RetrievedChunk[] } }
  | { event: 'delta'; data: { text: string } }
  | { event: 'tool_start'; data: { name: string; input: Record<string, unknown> } }
  | { event: 'tool_end'; data: { name: string; ok: boolean; sources: ToolSource[]; files: GeneratedFileRef[] } }
  | { event: 'tool_limit'; data: { rounds: number } }
  | { event: 'error'; data: { message: string } }
  | { event: 'done'; data: { usage: LlmUsage; title: string | null; number_check: { unverified: string[]; rechecked?: { value: string; source: string }[] } | null; message_id?: string } };

export type SendEvent = (event: TurnEvent) => void;

export interface PreparedTurn {
  /** (0122) 앱 실행의 사용량 예약 — 단계마다 한도를 다시 볼 때 자기 예약은 빼고, 실행을 마치면 푼다 */
  usageReservationId?: string;
  appSteps?: import('@/lib/apps/definition').AppStep[];
  /** 앱 이름 — 기관 연동 시스템 조회(0102)가 받는 쪽에 어느 앱이 부르는지 알린다 */
  appName?: string;
  appStepInputs?: Record<string, string>;
  /** 문서 찾기 단계가 찾을 다른 비서 중 실행 전에 권한을 확인한 것(2026-11-09) — 실행기는 이 목록 밖의 비서를 찾지 않는다 */
  appLookupAgents?: string[];
  /** 실행을 마친 결과를 보낼 곳 id(0076) — 시험 판 실행에는 두지 않는다. 넣을 때 그 기관의 회수되지 않은 곳인지 다시 본다 */
  appDeliverEndpointId?: string;
  /** 보낼 곳의 동작 키(0081) */
  appDeliverAction?: string;
  /** 같은 결과를 더 보낼 곳(2026-11-26, 앱 정의 `deliverMore`) — 곳마다 동작 */
  appDeliverMore?: Array<{ endpointId: string; action?: string }>;
  /** 긴 첨부를 나눠 읽을 조각(`appAttachmentMaterial`) — 실행기가 조각마다 추린 뒤 사용자 메시지에 덧붙인다 */
  appMaterialPieces?: { pieces: string[]; chars: number };
  /** 이번 실행의 원자료 파일 이름(올린 파일 다음 문서함에서 고른 문서, 원자료 자리와 같은 순서) — 파일마다 반복 단계가 쓴다(2026-11-07) */
  appFileNames?: string[];
  /** 문서함에서 고른 문서(2026-11-05) — 답변 행 `source_references.app_documents`(id·이름만). 이어 실행 대상에서 뺀다 */
  appDocuments?: { id: string; title: string }[];
  appResumeRecords?: import('@/lib/apps/pipeline').AppStepRecord[];
  appResumeFrom?: string;
  /** 시험 판으로 실행한 턴(0053) — 그 시험 판의 저장 시각. 답변 행·사용 기록에 남긴다 */
  appDraftSavedAt?: string;
  ctx: TurnContext;
  modelId: string;
  /** 비서의 모델이 기관 허용 목록 밖이라 바꿨는가 */
  modelSubstituted: boolean;
  systemPrompt: string;
  messages: LlmMessage[];
  tools: LlmTool[];
  /** 업체 서버에서 도는 도구(웹 검색 — 기관이 켰고 비서가 켠 턴만, 2026-11-26) */
  serverTools?: import('@/lib/llm/types').LlmServerTools;
  capabilities: Capability[];
  conversationId: string;
  isNewConversation: boolean;
  chunks: RetrievedChunk[];
  /** '문서 없이 일반 답변 받기'로 답한 턴 — 답변 행 `source_references.documents_skipped` */
  documentsSkipped: boolean;
  /** '문서 좁히기'로 고른 태그로 찾은 턴 — 답변 행 `source_references.doc_tags`(2026-11-23) */
  docTags?: string[];
  /** 적용 기준일로 찾은 턴 — 답변 행 `source_references.basis_date`(2026-11-26) */
  basisDate?: string;
  /** 문서 찾기에서 유사도 하한으로 뺀 조각 수(NODA `dropped`). NODA를 부르지 않았으면 null. 사용 기록 `details.doc_dropped` */
  docDropped: number | null;
  /** NODA 답변 검증에 보낼 근거(`PrepareResult.verifySources`). 비었으면 검증하지 않는다 */
  verifySources: { doc_id: string; chunk_id: string }[];
  /** 검증할 보관함(`PrepareResult.verifyTenant`) — null이면 비서 보관함 */
  verifyTenant: string | null;
  /** 메시지 행에 저장할 사용자 내용(사진 표시 + 질문) */
  storedUserContent: string;
}

export type PrepareOutcome =
  | { ok: true; turn: PreparedTurn }
  | { ok: false; status: number; message: string; details?: Record<string, unknown> };
