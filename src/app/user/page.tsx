import Shell from '@/components/Shell';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { Department } from '@/lib/db';

interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  agent: {
    name: string;
  } | null;
}

interface UserStats {
  totalConversations: number;
  recentConversations: Conversation[];
  department: Department | null;
}

async function getUserStats(userId: string, departmentId?: string): Promise<UserStats> {
  // 최근 대화 목록 조회
  const { data: conversations } = await supabaseAdmin
    .from('conversations')
    .select(`
      id,
      title,
      created_at,
      updated_at,
      agent:agents(name)
    `)
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(5);

  // 부서 정보 조회
  let department = null;
  if (departmentId) {
    const { data: dept } = await supabaseAdmin
      .from('departments')
      .select('*')
      .eq('id', departmentId)
      .single();
    department = dept;
  }

  return {
    totalConversations: conversations?.length || 0,
    recentConversations: conversations || [],
    department,
  };
}

export default async function UserPage() {
  const session = await getServerAuthSession();

  if (!session?.user) {
    return (
      <Shell>
        <div className="text-center py-12">
          <h1 className="text-2xl font-semibold text-gray-900">접근 권한이 없습니다</h1>
          <p className="text-gray-600 mt-2">로그인이 필요합니다.</p>
        </div>
      </Shell>
    );
  }

  const userStats = await getUserStats(session.user.id!, session.user.departmentId ?? undefined);

  return (
    <Shell>
      <div className="space-y-6">
        {/* 페이지 헤더 */}
        <div>
          <h1 className="text-3xl font-semibold text-gray-900">사용자 대시보드</h1>
          <p className="text-gray-600 mt-1">개인 정보 및 활동 내역을 확인하세요.</p>
        </div>

        {/* 프로필 카드 */}
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <h2 className="text-xl font-semibold text-gray-900 mb-4">프로필 정보</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700">이름</label>
              <p className="mt-1 text-sm text-gray-900">{session.user.name || '이름 없음'}</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">이메일</label>
              <p className="mt-1 text-sm text-gray-900">{session.user.email}</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">부서</label>
              <p className="mt-1 text-sm text-gray-900">
                {userStats.department?.name || '부서 정보 없음'}
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">역할</label>
              <p className="mt-1 text-sm text-gray-900">{session.user.role}</p>
            </div>
          </div>
        </div>

        {/* 통계 카드 */}
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <h2 className="text-xl font-semibold text-gray-900 mb-4">활동 통계</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="text-center">
              <div className="text-2xl font-bold text-blue-600">{userStats.totalConversations}</div>
              <div className="text-sm text-gray-600">총 대화 수</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-green-600">
                {userStats.recentConversations.filter(c => {
                  const updatedAt = new Date(c.updated_at);
                  const weekAgo = new Date();
                  weekAgo.setDate(weekAgo.getDate() - 7);
                  return updatedAt > weekAgo;
                }).length}
              </div>
              <div className="text-sm text-gray-600">최근 7일 대화</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-purple-600">
                {userStats.recentConversations.length > 0 ?
                  Math.round((new Date().getTime() - new Date(userStats.recentConversations[0].updated_at).getTime()) / (1000 * 60 * 60 * 24)) :
                  0
                }
              </div>
              <div className="text-sm text-gray-600">마지막 활동 (일)</div>
            </div>
          </div>
        </div>

        {/* 최근 대화 목록 */}
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <h2 className="text-xl font-semibold text-gray-900 mb-4">최근 대화</h2>
          {userStats.recentConversations.length > 0 ? (
            <div className="space-y-3">
              {userStats.recentConversations.map((conversation) => (
                <div key={conversation.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <div className="flex-1">
                    <h3 className="text-sm font-medium text-gray-900">
                      {conversation.title || '제목 없음'}
                    </h3>
                    <p className="text-xs text-gray-600">
                      {conversation.agent?.name ? `${conversation.agent.name} 에이전트` : '에이전트 정보 없음'} •
                      {' '}{new Date(conversation.updated_at).toLocaleDateString('ko-KR')}
                    </p>
                  </div>
                  <div className="text-xs text-gray-500">
                    {new Date(conversation.updated_at).toLocaleTimeString('ko-KR', {
                      hour: '2-digit',
                      minute: '2-digit'
                    })}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-gray-600 text-center py-8">아직 대화가 없습니다.</p>
          )}
        </div>

        {/* 디버그 정보 (개발용) */}
        {process.env.NODE_ENV === 'development' && (
          <details className="bg-gray-50 rounded-lg p-4">
            <summary className="cursor-pointer text-sm font-medium text-gray-700">
              세션 정보 (개발용)
            </summary>
            <pre className="mt-3 p-4 text-xs text-gray-700 bg-white rounded border overflow-auto">
              {JSON.stringify(session?.user, null, 2)}
            </pre>
          </details>
        )}
      </div>
    </Shell>
  );
}
