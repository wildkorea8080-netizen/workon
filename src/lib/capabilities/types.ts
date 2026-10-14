// src/lib/capabilities/types.ts
import type { LlmTool, LlmUsage } from '@/lib/llm/types';
import type { ToolSource } from '@/lib/connectors';
import type { RetrievedChunk } from '@/lib/db';
import type { CapabilityId, CapabilitySettings } from './settings';

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
}

export interface PrepareResult {
  /** 시스템 프롬프트 뒤에 붙일 글 */
  systemAddendum?: string;
  /** 화면 출처 표시(SourceCitation)와 messages.source_references.chunks로 간다 */
  chunks?: RetrievedChunk[];
}

export interface ToolOutcome {
  ok: boolean;
  /** AI에게 돌려줄 글. 실패면 사람이 읽을 수 있는 이유 */
  text: string;
  sources?: { links?: ToolSource[] };
  /** 능력 안에서 AI를 불렀을 때. 실행기가 과금 규약대로 기록한다 */
  usage?: LlmUsage[];
}

export interface Capability {
  id: CapabilityId;
  label: string;
  description: string;
  /** 사진을 받을 수 있게 하는 능력 */
  acceptsImages?: boolean;
  /** 쓸 준비가 됐는가(키 등). false면 켜져 있어도 빠진다 */
  isAvailable(): boolean;
  prepare?(ctx: TurnContext): Promise<PrepareResult>;
  tools?(ctx: TurnContext): LlmTool[];
  /** 던져도 된다 — 실행기가 받아 실패 결과로 바꾼다 */
  execute?(tool: string, input: Record<string, unknown>, ctx: TurnContext): Promise<ToolOutcome>;
}
