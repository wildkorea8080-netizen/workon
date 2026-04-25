import Link from 'next/link';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

export default async function MaintenancePage() {
  let message = '시스템 점검 중입니다. 잠시 후 다시 시도해주세요.';
  try {
    const { data } = await supabaseAdmin
      .from('system_settings').select('value').eq('key', 'maintenance_message').maybeSingle();
    if (data?.value) message = data.value;
  } catch { /* ignore */ }

  return (
    <main className="min-h-screen bg-[#0F172A] flex items-center justify-center px-4">
      <div className="text-center max-w-md">
        <div className="text-6xl mb-6">🔧</div>
        <h1 className="text-2xl font-bold text-white mb-3">시스템 점검 중입니다</h1>
        <p className="text-slate-400 text-sm leading-relaxed mb-8">{message}</p>
        <p className="text-slate-600 text-xs">
          불편을 드려 죄송합니다. 빠른 시일 내에 복구하겠습니다.
        </p>
        <Link href="/super/login"
          className="mt-8 inline-block text-xs text-slate-700 hover:text-slate-500 transition-colors">
          관리자 접속
        </Link>
      </div>
    </main>
  );
}
