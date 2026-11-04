'use client';
import Link from 'next/link';
import { savesAsDraft, type AppDraft } from '@/lib/apps/draft';

/** ISO 시각 → 'YYYY-MM-DD HH:mm'(한국 시간) */
export function kstTime(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t + 9 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ') : iso;
}

/**
 * 빌더의 시험 판(0053) 칸 — 부서·공식 앱만. 저장하면 시험 판으로 가고, 시험 실행해 본 뒤 배포해야 부서 사람들에게 반영된다.
 * 나만의 앱은 그리지 않는다(바로 저장)
 */
export default function AppDraftPanel({ tier, version, draft, agentId, busy, onPublish, onDiscard }: {
  tier: string; version: number; draft: AppDraft | null; agentId: string; busy: boolean; onPublish: () => void; onDiscard: () => void;
}) {
  if (!savesAsDraft(tier)) return null;
  if (!draft) {
    return <p className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs leading-5 text-slate-600">부서 사람들이 쓰는 앱이라 저장하면 <strong>시험 판</strong>으로 저장됩니다. 시험 판으로 실행해 본 뒤 배포해야 부서 사람들에게 반영됩니다(지금 판: 판 {version}).</p>;
  }
  const stale = draft.base_version !== version;
  return <section aria-label="시험 판" className="space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm">
    <p className="leading-6 text-amber-900">배포하지 않은 시험 판이 있습니다 — {kstTime(draft.saved_at)} 저장, 판 {draft.base_version} 기준. 부서 사람들은 아직 지금 판(판 {version})을 씁니다.</p>
    {stale && <p role="alert" className="text-xs text-red-700">시험 판을 만든 뒤 앱이 새로 배포됐습니다. 배포할 수 없으니 앱을 새로 열어 지금 판을 보고 다시 저장해 주세요.</p>}
    <div className="flex flex-wrap items-center gap-3">
      <Link href={`/apps/run?agent=${encodeURIComponent(agentId)}&draft=1`} className="font-semibold text-[#087581] underline">시험 판으로 실행</Link>
      <button type="button" disabled={busy || stale} onClick={onPublish} className="rounded-lg bg-[#087f8c] px-3 py-1.5 font-semibold text-white disabled:opacity-40">배포</button>
      <button type="button" disabled={busy} onClick={onDiscard} className="text-xs text-red-600 disabled:opacity-40">시험 판 버리기</button>
    </div>
    <p className="text-xs leading-5 text-slate-600">시험 판 실행은 이 앱을 고칠 수 있는 사람만 할 수 있고, 사용량은 평소처럼 기록됩니다. 배포하면 판 번호가 올라가고 변경 기록에 남습니다.</p>
  </section>;
}
