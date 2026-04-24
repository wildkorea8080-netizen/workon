import { getSuperAdminSession } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { redirect } from 'next/navigation';
import Link from 'next/link';

export default async function SuperDashboardPage() {
  const session = await getSuperAdminSession();
  if (!session) redirect('/super/login');

  // 전체 현황 집계
  const [orgResult, userResult, convResult] = await Promise.all([
    supabaseAdmin.from('organizations').select('id, name, status', { count: 'exact' }),
    supabaseAdmin.from('users').select('id', { count: 'exact' }),
    supabaseAdmin.from('conversations')
      .select('id', { count: 'exact' })
      .gte('created_at', new Date(Date.now() - 30 * 86400000).toISOString()),
  ]);

  const totalOrgs  = orgResult.count ?? 0;
  const totalUsers = userResult.count ?? 0;
  const monthConvs = convResult.count ?? 0;

  const activeOrgs = (orgResult.data ?? []).filter(o => o.status === 'active').length;

  const STATS = [
    { label: '전체 기관',     value: totalOrgs,  sub: `활성 ${activeOrgs}개`,  icon: '🏢', color: 'bg-violet-500/10 border-violet-500/20 text-violet-400' },
    { label: '전체 사용자',   value: totalUsers, sub: '등록된 직원 수',         icon: '👤', color: 'bg-blue-500/10 border-blue-500/20 text-blue-400' },
    { label: '이달 대화',     value: monthConvs, sub: '최근 30일',              icon: '💬', color: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' },
    { label: '활성 계약',     value: activeOrgs, sub: '정식 서비스 중',         icon: '📄', color: 'bg-amber-500/10 border-amber-500/20 text-amber-400' },
  ];

  const QUICK_LINKS = [
    { href: '/super/organizations', label: '기관 등록',   icon: '🏢', desc: '신규 공공기관 계약 등록' },
    { href: '/super/contracts',     label: '계약 관리',   icon: '💰', desc: '계약 현황 및 갱신 관리' },
    { href: '/super/api-keys',      label: 'API 키 관리', icon: '🔑', desc: '기관별 API 키 발급·교체' },
    { href: '/super/usage',         label: '사용량 확인', icon: '📈', desc: '실시간 토큰 사용 모니터링' },
  ];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white">대시보드</h1>
        <p className="text-slate-400 text-sm mt-1">안녕하세요, {session.name}님. WORKON 전체 현황입니다.</p>
      </div>

      {/* 통계 카드 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {STATS.map(s => (
          <div key={s.label} className={`p-5 rounded-2xl border ${s.color}`}>
            <div className="text-2xl mb-3">{s.icon}</div>
            <p className="text-2xl font-bold text-white">{s.value.toLocaleString()}</p>
            <p className="text-xs text-slate-400 mt-0.5">{s.label}</p>
            <p className="text-xs text-slate-500 mt-0.5">{s.sub}</p>
          </div>
        ))}
      </div>

      {/* 빠른 메뉴 */}
      <div>
        <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-3">빠른 메뉴</h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {QUICK_LINKS.map(q => (
            <Link
              key={q.href}
              href={q.href}
              className="p-5 bg-[#1E293B] border border-slate-700/50 rounded-2xl hover:border-[#7C3AED]/50 hover:bg-[#7C3AED]/5 transition-all group"
            >
              <div className="text-2xl mb-3">{q.icon}</div>
              <p className="text-sm font-semibold text-white group-hover:text-[#A78BFA]">{q.label}</p>
              <p className="text-xs text-slate-500 mt-0.5">{q.desc}</p>
            </Link>
          ))}
        </div>
      </div>

      {/* 기관 목록 미리보기 */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">최근 기관</h2>
          <Link href="/super/organizations" className="text-xs text-[#A78BFA] hover:text-[#7C3AED]">전체 보기 →</Link>
        </div>
        <div className="bg-[#1E293B] border border-slate-700/50 rounded-2xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-700/50">
              <tr>
                {['기관명', '유형', '상태', '플랜'].map(h => (
                  <th key={h} className="px-5 py-3 text-left text-xs font-semibold text-slate-500">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/30">
              {(orgResult.data ?? []).slice(0, 5).map(org => (
                <tr key={org.id} className="hover:bg-slate-700/20 transition-colors">
                  <td className="px-5 py-3 font-medium text-white">{org.name}</td>
                  <td className="px-5 py-3 text-slate-400">공공기관</td>
                  <td className="px-5 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                      org.status === 'active' ? 'bg-emerald-900/40 text-emerald-400' :
                      org.status === 'trial'  ? 'bg-amber-900/40 text-amber-400' :
                      'bg-slate-700 text-slate-400'
                    }`}>
                      {org.status === 'active' ? '활성' : org.status === 'trial' ? '체험' : org.status}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-slate-400">—</td>
                </tr>
              ))}
              {(orgResult.data ?? []).length === 0 && (
                <tr>
                  <td colSpan={4} className="px-5 py-8 text-center text-slate-500 text-sm">
                    등록된 기관이 없습니다.{' '}
                    <Link href="/super/organizations" className="text-[#A78BFA] hover:underline">기관 등록하기 →</Link>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
