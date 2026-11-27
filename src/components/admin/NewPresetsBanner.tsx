'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { requestJson } from '@/lib/ok-json';

type Item = { name: string; state: string; kind: 'form' | 'chat' };

/**
 * 관리자 대시보드의 '아직 깔지 않은 기본 비서·앱' 띠(2026-11-27). 기본 세트에 새 비서·앱이 더해져도 이미 있는 기관에는
 * 저절로 깔리지 않아(관리자 '기본 비서·앱 세트'에서 깜) 있는 줄 모르기 쉬웠다. 없으면 아무것도 그리지 않고, 못 읽으면 조용히 빠진다
 * (대시보드의 곁가지 안내라 — 비서 관리 화면의 패널이 같은 목록을 따로 알린다)
 */
export default function NewPresetsBanner() {
  const [missing, setMissing] = useState<Item[] | null>(null);
  const [canInstall, setCanInstall] = useState(false);
  useEffect(() => {
    void (async () => {
      const r = await requestJson('/api/admin/preset-agents');
      if (!r.ok) return;
      const data = (r.body as { data: { items: Item[]; canInstall: boolean } }).data;
      setMissing(data.items.filter((i) => i.state === 'missing'));
      setCanInstall(data.canInstall);
    })();
  }, []);
  if (!missing || missing.length === 0) return null;
  const apps = missing.filter((m) => m.kind === 'form').length;
  const chats = missing.length - apps;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ws-accent/30 bg-ws-accent-soft px-4 py-3 text-sm">
      <p className="text-slate-700">
        <b className="text-ws-accent-text">아직 깔지 않은 기본 {[chats ? `비서 ${chats}개` : '', apps ? `업무 앱 ${apps}개` : ''].filter(Boolean).join('·')}</b>가 있습니다
        <span className="ml-1 text-slate-500">— {missing.slice(0, 3).map((m) => m.name).join(', ')}{missing.length > 3 ? ` 외 ${missing.length - 3}개` : ''}</span>
      </p>
      {canInstall
        ? <Link href="/admin/agents" className="whitespace-nowrap rounded-lg bg-ws-accent px-3 py-1.5 text-xs font-semibold text-white hover:bg-ws-accent-hover">살펴보고 깔기</Link>
        : <span className="whitespace-nowrap text-xs text-slate-500">기관 전체 관리자가 깔 수 있습니다</span>}
    </div>
  );
}
