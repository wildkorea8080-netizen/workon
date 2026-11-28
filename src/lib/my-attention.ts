// src/lib/my-attention.ts
// 확인할 일(2026-11-28) — 직원이 직접 해야 하는데 지금은 메일로만 알리던 일을 업무 틀 사이드바에 보인다.
// 운영 메일이 보내는 도메인 미인증으로 모두 실패하는 동안(그리고 메일을 막는 기관에서는 늘) 직원은 보내기 전 확인을 기다리는 결과나
// 멈춘 예약을 알 길이 없었다. 저장하지 않고 읽을 때마다 센다(새 표 없음). 읽기 실패는 던진다(라우트가 503 — '없음'으로 보이지 않게).
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { ActorScope } from '@/lib/agent-permissions';
import { OUTBOUND_APPROVAL_MS } from '@/lib/apps/outbound/spec';
import { PAUSED_BY_USER } from '@/lib/apps/schedule-spec';
import { attentionItems, type AttentionCounts, type AttentionItem } from '@/lib/my-attention-spec';

export type { AttentionItem };

export async function loadMyAttention(actor: ActorScope, nowMs = Date.now(), db = supabaseAdmin): Promise<AttentionItem[]> {
  if (!actor.organizationId) return [];
  const [approvals, schedules, official] = await Promise.all([
    // 보내기 전 확인을 기다리는 내 결과(기한 7일 안) — 앱마다 묶어 그 앱의 실행 화면으로
    db.from('app_outbound_deliveries').select('agent_id')
      .eq('user_id', actor.userId).eq('organization_id', actor.organizationId).eq('status', 'awaiting_approval')
      .gte('created_at', new Date(nowMs - OUTBOUND_APPROVAL_MS).toISOString())
      .limit(200),
    // 멈춘 내 예약 — 직원이 직접 멈춘 것은 빼고(실행기·관리자가 멈춘 것만). 한 사람 5개라 줄을 읽어 거른다
    db.from('app_schedules').select('id, paused_reason').eq('user_id', actor.userId).eq('status', 'paused').limit(50),
    // 관리자: 관리 범위의 공식 등록 신청
    actor.isAdmin && actor.managedDepartmentIds.length
      ? db.from('agents').select('id', { count: 'exact', head: true })
        .eq('organization_id', actor.organizationId).in('department_id', actor.managedDepartmentIds)
        .eq('approval_status', 'pending').is('deleted_at', null)
      : Promise.resolve({ count: 0, error: null }),
  ]);
  if (approvals.error) throw approvals.error;
  if (schedules.error) throw schedules.error;
  if (official.error) throw official.error;
  const byAgent = new Map<string, number>();
  for (const r of (approvals.data ?? []) as { agent_id: string }[]) byAgent.set(r.agent_id, (byAgent.get(r.agent_id) ?? 0) + 1);
  const counts: AttentionCounts = {
    approvalsByAgent: [...byAgent.entries()].map(([agentId, count]) => ({ agentId, count })),
    pausedSchedules: ((schedules.data ?? []) as { paused_reason: string | null }[]).filter((s) => s.paused_reason !== PAUSED_BY_USER).length,
    officialRequests: official.count ?? 0,
  };
  return attentionItems(counts);
}
