'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { fetchOkJson } from '@/lib/ok-json';
import { latestGate } from '@/lib/latest-request';
import { ATTENTION_UNREAD, type AttentionItem } from '@/lib/my-attention-spec';

/**
 * 확인할 일(2026-11-28) — 보내기 전 확인을 기다리는 결과·멈춘 앱 예약·(관리자) 공식 비서 등록 신청.
 * 메일로만 알리던 일이라 메일이 오지 않으면 알 길이 없었다. 화면을 옮길 때마다 다시 읽고, 없으면 아무것도 그리지 않으며,
 * 못 읽으면 '없음'으로 보이지 않게 한 줄로 알린다
 */
export default function AttentionList({ collapsed }: { collapsed: boolean }) {
  const pathname = usePathname();
  const [items, setItems] = useState<AttentionItem[]>([]);
  const [unread, setUnread] = useState(false);
  const gate = useRef(latestGate());

  useEffect(() => {
    const ticket = gate.current.begin();
    void fetchOkJson<{ data?: AttentionItem[] }>('/api/my/attention').then((result) => {
      if (!gate.current.isLatest(ticket)) return;
      setUnread(!result);
      if (result) setItems(result.data ?? []);
    });
  }, [pathname]);

  const total = items.reduce((n, i) => n + i.count, 0);
  if (collapsed) {
    if (!total) return null;
    return (
      <Link href={items[0].href} title={items.map((i) => `${i.label} ${i.count}건`).join(' · ')} aria-label={`확인할 일 ${total}건`} className="mb-3 flex justify-center">
        <span className="rounded-full bg-amber-500 px-2 py-0.5 text-[11px] font-bold text-white">{total}</span>
      </Link>
    );
  }
  if (!total && !unread) return null;
  return (
    <section aria-label="확인할 일" className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
      <p className="mb-1 text-[11px] font-semibold text-amber-800">확인할 일</p>
      {unread && !total ? (
        <p role="status" className="text-[12px] text-amber-800">{ATTENTION_UNREAD}</p>
      ) : (
        <ul className="space-y-0.5">
          {items.map((i) => (
            <li key={i.key}>
              <Link href={i.href} className="flex items-center justify-between gap-2 rounded-lg px-1 py-1 text-[13px] text-slate-700 hover:bg-amber-100">
                <span className="min-w-0 truncate">{i.label}</span>
                <span className="flex-shrink-0 rounded-full bg-amber-500 px-1.5 text-[11px] font-bold text-white">{i.count}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
