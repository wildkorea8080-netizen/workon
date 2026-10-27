'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter, useSearchParams } from 'next/navigation';
import ChatHome from '@/components/chat/ChatHome';
import WorkShell from '@/components/work/WorkShell';
import WorkHome from '@/components/work/WorkHome';
import { api } from '@/lib/work/client';

/**
 * `/` — 기관 스위치(work_org_settings.home_enabled)가 켜진 기관은 업무 홈, 아니면 지금까지의 AI 대화 홈 그대로.
 * 업무 홈이 켜진 기관에서 옛 대화 주소(`/?conv=ID`)로 오면 `/chat?conv=ID`로 보낸다(개편 03 문서 경로 호환).
 * 로그인 전 소개·부서 없음 안내는 ChatHome이 그대로 맡는다.
 */
function HomeSwitch() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const [mode, setMode] = useState<'loading' | 'work' | 'chat'>('loading');

  useEffect(() => {
    if (status === 'loading') return;
    if (!session?.user?.departmentId) {
      setMode('chat');
      return;
    }
    let alive = true;
    api<{ settings: { homeEnabled: boolean } }>('/api/workflows').then((r) => {
      if (!alive) return;
      const enabled = r.ok && r.data.settings.homeEnabled;
      const conv = params.get('conv');
      if (enabled && conv) {
        router.replace(`/chat?conv=${encodeURIComponent(conv)}`);
        return;
      }
      // 업무 기능을 읽지 못하면(아직 마이그레이션 전·장애) 지금까지의 대화 홈으로 연다 — 직원이 막히지 않게
      setMode(enabled ? 'work' : 'chat');
    });
    return () => {
      alive = false;
    };
  }, [status, session, params, router]);

  if (mode === 'chat') return <ChatHome />;
  if (mode === 'work')
    return (
      <WorkShell>
        <WorkHome />
      </WorkShell>
    );
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F5F7FA]" role="status">
      <span className="text-[15px] text-slate-500">불러오는 중…</span>
    </div>
  );
}

export default function HomePage() {
  return (
    <Suspense fallback={null}>
      <HomeSwitch />
    </Suspense>
  );
}
