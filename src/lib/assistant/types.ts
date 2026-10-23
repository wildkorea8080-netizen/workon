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
 * 더했다(첨부 도구를 쓴 턴의 확인되지 않은 숫자, 없으면 null) — ChatInterface가 읽는다
 */
export type TurnEvent =
  | { event: 'meta'; data: { conversation_id: string; chunks: RetrievedChunk[] } }
  | { event: 'delta'; data: { text: string } }
  | { event: 'tool_start'; data: { name: string; input: Record<string, unknown> } }
  | { event: 'tool_end'; data: { name: string; ok: boolean; sources: ToolSource[]; files: GeneratedFileRef[] } }
  | { event: 'tool_limit'; data: { rounds: number } }
  | { event: 'error'; data: { message: string } }
  | { event: 'done'; data: { usage: LlmUsage; title: string | null; number_check: { unverified: string[] } | null } };

export type SendEvent = (event: TurnEvent) => void;

export interface PreparedTurn {
  ctx: TurnContext;
  modelId: string;
  /** 비서의 모델이 기관 허용 목록 밖이라 바꿨는가 */
  modelSubstituted: boolean;
  systemPrompt: string;
  messages: LlmMessage[];
  tools: LlmTool[];
  capabilities: Capability[];
  conversationId: string;
  isNewConversation: boolean;
  chunks: RetrievedChunk[];
  /** '문서 없이 일반 답변 받기'로 답한 턴 — 답변 행 `source_references.documents_skipped` */
  documentsSkipped: boolean;
  /** 문서 찾기에서 유사도 하한으로 뺀 조각 수(NODA `dropped`). NODA를 부르지 않았으면 null. 사용 기록 `details.doc_dropped` */
  docDropped: number | null;
  /** 메시지 행에 저장할 사용자 내용(사진 표시 + 질문) */
  storedUserContent: string;
}

export type PrepareOutcome =
  | { ok: true; turn: PreparedTurn }
  | { ok: false; status: number; message: string; details?: Record<string, unknown> };
