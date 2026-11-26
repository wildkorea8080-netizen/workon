'use client';

import { useEffect, useRef, useState } from 'react';
import { requestJson } from '@/lib/ok-json';
import { latestGate } from '@/lib/latest-request';

/** 금액 글 — 원 단위 반올림, 1원 아래는 '1원 미만' 없이 1원(어림은 언제나 1원 이상) */
export function appCostNote(maxKrw: number): string {
  return `많으면 약 ${Math.max(1, Math.round(maxKrw)).toLocaleString('ko-KR')}원(첨부·문서 내용 빼고 어림 — 첨부가 길면 더 듭니다)`;
}
/** 입력이 멈춘 뒤 다시 어림할 때까지 */
export const APP_COST_DEBOUNCE_MS = 700;

/**
 * 실행 전 '많으면 쓸 금액'(2026-11-26) — 실행할 때 사용량 예약(0122)이 잡는 것과 같은 규칙으로 서버가 어림한다(`POST /api/apps/estimate`).
 * 입력이 바뀌면 잠시 기다렸다가 다시 묻고, 늦게 온 앞 응답은 버린다. 못 읽으면(입력이 아직 틀린 것 포함) 아무 금액도 보이지 않는다 —
 * 예상 AI 호출 수 줄은 그대로 있고, 틀린 금액을 보이는 쪽보다 낫다
 */
export default function AppCostEstimate({ agentId, values, files }: { agentId: string; values: Record<string, string>; files: number }) {
  const [note, setNote] = useState<string | null>(null);
  const gate = useRef(latestGate());
  const key = JSON.stringify([agentId, values, files]);
  useEffect(() => {
    const ticket = gate.current.begin();
    setNote(null);
    const timer = setTimeout(async () => {
      const r = await requestJson('/api/apps/estimate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_id: agentId, app_inputs: values, files }) });
      if (!gate.current.isLatest(ticket)) return;
      const maxKrw = (r.body as { data?: { maxKrw?: unknown } } | null)?.data?.maxKrw;
      setNote(r.ok && typeof maxKrw === 'number' ? appCostNote(maxKrw) : null);
    }, APP_COST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!note) return null;
  return <p role="note" aria-label="예상 사용 금액" className="mt-1 text-xs font-medium text-slate-600">{note}</p>;
}
