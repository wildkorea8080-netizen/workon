// 확인할 일(2026-11-28)의 꼴과 줄 만들기 — 화면도 쓰므로 아무것도 import하지 않는다(잎 파일)

export type AttentionItem = { key: 'outbound_approvals' | 'paused_schedules' | 'official_requests'; count: number; label: string; href: string };

export type AttentionCounts = {
  approvalsByAgent: { agentId: string; count: number }[];
  pausedSchedules: number;
  officialRequests: number;
};

export const ATTENTION_UNREAD = '확인할 일을 지금 읽지 못했습니다.';

/** 0인 줄은 빼고 — 보내기 전 확인은 가장 많이 기다리는 앱의 실행 화면으로(그 화면 아래 '보내기 전 확인할 결과' 칸) */
export function attentionItems(c: AttentionCounts): AttentionItem[] {
  const out: AttentionItem[] = [];
  const approvals = c.approvalsByAgent.reduce((n, a) => n + a.count, 0);
  if (approvals > 0) {
    out.push({
      key: 'outbound_approvals', count: approvals, label: c.approvalsByAgent.length > 1 ? `보내기 전 확인할 결과(앱 ${c.approvalsByAgent.length}개)` : '보내기 전 확인할 결과',
      href: `/apps/run?agent=${encodeURIComponent([...c.approvalsByAgent].sort((a, b) => b.count - a.count)[0].agentId)}`,
    });
  }
  if (c.pausedSchedules > 0) out.push({ key: 'paused_schedules', count: c.pausedSchedules, label: '멈춘 앱 예약', href: '/apps/schedules' });
  if (c.officialRequests > 0) out.push({ key: 'official_requests', count: c.officialRequests, label: '공식 비서 등록 신청', href: '/admin/agents' });
  return out;
}
