// src/lib/assistant/persist.ts
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { estimateCostUsd, estimateCostKrw } from '@/lib/models';
import type { LlmUsage } from '@/lib/llm/types';
import type { ToolSource } from '@/lib/connectors';
import type { GeneratedFileRef } from '@/lib/capabilities/types';
import type { RetrievedChunk } from '@/lib/db';

export interface MessageRowInput {
  conversationId: string;
  userId: string;
  userContent: string;
  assistantText: string;
  chunks: RetrievedChunk[];
  links: ToolSource[];
  files: GeneratedFileRef[];
  /** 이번 질문에 붙인 첨부. 저장소 경로는 싣지 않는다 — 화면이 이 행을 그대로 읽는다 */
  attachments: { id: string; file_name: string }[];
  agentVersion: number;
}

export function dedupeLinks(links: ToolSource[]): ToolSource[] {
  return links.filter((link, index, all) => all.findIndex((other) => other.url === link.url) === index);
}

/**
 * 메시지 두 행. **키 집합이 같아야 한다.**
 *
 * PostgREST는 배치 삽입 시 모든 행의 칸을 합집합으로 맞추고 빠진 행에는
 * 명시적 NULL을 넣는다. 기본값이 우회되어 NOT NULL 칸이면 두 행이 함께
 * 실패한다. 실제로 사용자 행에 source_references가 빠져 대화가 한 건도
 * 저장되지 않았다.
 */
export function buildMessageRows(input: MessageRowInput): Record<string, unknown>[] {
  return [
    {
      conversation_id: input.conversationId,
      user_id: input.userId,
      role: 'user',
      content: input.userContent,
      // 칸은 하나(source_references)라 첨부가 있든 없든 두 행의 키 집합은 같다
      source_references: input.attachments.length
        ? { attachments: input.attachments.map((a) => ({ id: a.id, file_name: a.file_name })) }
        : {},
      agent_version: input.agentVersion,
    },
    {
      conversation_id: input.conversationId,
      user_id: null,
      role: 'assistant',
      content: input.assistantText,
      source_references: {
        chunks: input.chunks.map((c) => ({
          documentId: c.documentId,
          documentTitle: c.documentTitle,
          chunkIndex: c.chunkIndex,
          similarity: c.similarity,
        })),
        links: dedupeLinks(input.links),
        files: input.files,
      },
      agent_version: input.agentVersion,
    },
  ];
}

export async function saveMessages(rows: Record<string, unknown>[]): Promise<string | null> {
  const { error } = await supabaseAdmin.from('messages').insert(rows);
  if (error) {
    console.error('[assistant] 메시지 저장 오류:', error);
    return error.message;
  }
  return null;
}

/** 모델이 다르면 단가가 다르다. 모델별로 한 행씩 남긴다. */
export function mergeUsageByModel(usages: LlmUsage[]): LlmUsage[] {
  const byModel = new Map<string, LlmUsage>();
  for (const u of usages) {
    const prev = byModel.get(u.model);
    byModel.set(
      u.model,
      prev
        ? { model: u.model, input_tokens: prev.input_tokens + u.input_tokens, output_tokens: prev.output_tokens + u.output_tokens }
        : { ...u }
    );
  }
  return [...byModel.values()];
}

/** 과금 규약(CLAUDE.md): model·토큰·기록 시점 단가로 확정한 원가 */
export function buildUsageDetails(usage: LlmUsage, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    ...extra,
    model: usage.model,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cost_usd: estimateCostUsd(usage, usage.model),
    cost_krw: estimateCostKrw(usage, usage.model),
  };
}

export async function writeUsageLog(row: {
  departmentId: string;
  userId: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  details: Record<string, unknown>;
}): Promise<void> {
  // organization_id는 트리거(0012/0022)가 department_id로부터 채운다
  const { error } = await supabaseAdmin.from('usage_logs').insert({
    department_id: row.departmentId,
    user_id: row.userId,
    action: row.action,
    resource_type: row.resourceType,
    resource_id: row.resourceId,
    details: row.details,
  });
  if (error) console.error('[assistant] 사용 로그 기록 실패', row.action, error.message);
}
