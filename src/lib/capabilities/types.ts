// src/lib/capabilities/types.ts
import type { LlmTool, LlmUsage } from '@/lib/llm/types';
import type { ToolSource } from '@/lib/connectors';
import type { RetrievedChunk } from '@/lib/db';
import type { AttachmentSummary } from '@/lib/attachments/types';
import type { CapabilityId, CapabilitySettings } from './settings';

/**
 * 이 대화에 붙은 첨부 하나. 저장소 경로는 싣지 않는다 — 도구가 본문이 필요하면
 * 서버가 user_id 조건으로 기록을 다시 찾는다.
 */
export interface TurnAttachment {
  /** 'a1'… 이 대화에 올린 순서(첨부 기록의 created_at). 기록이 남아 있는 한 턴이 바뀌어도 같은 파일은 같은 ref */
  ref: string;
  id: string;
  fileName: string;
  summary: AttachmentSummary;
  /** 이번 요청으로 이 대화에 새로 묶인 것. 이미 묶여 있던 것을 다시 보내도 새것으로 치지 않는다 */
  isNew: boolean;
}

/**
 * 이번 턴의 정보. **서버가 채운다.** AI는 도구 입력값만 정한다.
 * 격리에 걸리는 값(기관·보관함·대상 문서)은 도구 입력 스키마에 넣지 않고
 * 여기서만 꺼낸다(설계 4.2) — tests/capabilities.test.ts가 확인한다.
 */
export interface TurnContext {
  organizationId: string;
  departmentId: string;
  userId: string;
  agentId: string;
  agentVersion: number;
  /** 기관 범위를 적용한 뒤의 설정 */
  capabilities: CapabilitySettings;
  /** 이번 질문. prepare가 검색어로 쓴다 */
  message: string;
  /** 이번 대화. 만든 파일을 대화에 묶는다(설계 3.4). prepareTurn이 도구 루프 전에 정한다 */
  conversationId: string;
  /** 이 대화의 첨부. 파일을 받는 능력이 꺼져 있으면 빈 배열(조회하지 않는다) */
  attachments: TurnAttachment[];
  /** 능력별 preflight가 넘긴 값(`PreflightResult.carry`). prepare가 이어 쓴다 */
  preflight: Partial<Record<CapabilityId, unknown>>;
  /** 직원이 '문서 없이 일반 답변 받기'를 골랐다(요청 본문 `skip_documents === true`). 그 한 번만이다 */
  skipDocuments: boolean;
}

/** 대화를 만들기 **전에** 능력이 할 일(판정 R4) — 거절될 요청으로 빈 대화가 쌓이지 않게 */
export interface PreflightInput {
  organizationId: string;
  agentId: string;
  message: string;
  skipDocuments: boolean;
}

/**
 * 거절이면 실행기가 JSON으로 답한다(`code`는 응답의 `error.code` — 화면이 버튼을 고른다).
 * `carry`는 `TurnContext.preflight[능력 id]`로 prepare에 간다
 */
export type PreflightResult = { ok: true; carry?: unknown } | { ok: false; status: number; message: string; code: string };

export interface PrepareResult {
  /** 시스템 프롬프트 뒤에 붙일 글 */
  systemAddendum?: string;
  /** 화면 출처 표시(SourceCitation)와 messages.source_references.chunks로 간다 */
  chunks?: RetrievedChunk[];
  /** 문서 찾기에서 유사도 하한으로 뺀 조각 수(NODA `dropped`). 사용 기록 `details.doc_dropped`로 간다 */
  dropped?: number;
  /** 이번 턴은 참고 문서 없이 답한다 — 답변 행 `source_references.documents_skipped` */
  documentsSkipped?: boolean;
}

/** 도구가 만든 파일. 화면(tool_end)과 메시지 저장(source_references.files)으로 간다 */
export interface GeneratedFileRef {
  id: string;
  file_name: string;
  size_bytes: number;
}

export interface ToolOutcome {
  ok: boolean;
  /** AI에게 돌려줄 글. 실패면 사람이 읽을 수 있는 이유 */
  text: string;
  sources?: { links?: ToolSource[] };
  /** 능력 안에서 AI를 불렀을 때. 실행기가 과금 규약대로 기록한다 */
  usage?: LlmUsage[];
  /** 도구가 만든 파일 — 화면 내려받기 카드와 메시지 저장으로 간다 */
  files?: GeneratedFileRef[];
  /**
   * 이번 결과로 AI에게 **보여 준** 숫자(표 칸·계산 결과·합계). 실행기가 턴 동안 모아
   * 답변의 숫자와 대조한다(숫자 확인, 설계 5.4). 보여 주지 않은 행의 숫자는 넣지 않는다
   */
  shownValues?: number[];
}

export interface Capability {
  id: CapabilityId;
  label: string;
  description: string;
  /** 사진을 받을 수 있게 하는 능력 */
  acceptsImages?: boolean;
  /** 채팅 첨부 파일을 받을 수 있게 하는 능력. 켜져 있어야 attachment_ids를 받고 첨부를 불러온다 */
  acceptsFiles?: boolean;
  /** 쓸 준비가 됐는가(키 등). false면 켜져 있어도 빠진다 */
  isAvailable(): boolean;
  /** 대화를 만들기 전에 부른다. 거절하면 대화·첨부 묶기 없이 끝난다 */
  preflight?(input: PreflightInput): Promise<PreflightResult>;
  prepare?(ctx: TurnContext): Promise<PrepareResult>;
  tools?(ctx: TurnContext): LlmTool[];
  /** 던져도 된다 — 실행기가 받아 실패 결과로 바꾼다 */
  execute?(tool: string, input: Record<string, unknown>, ctx: TurnContext): Promise<ToolOutcome>;
}
