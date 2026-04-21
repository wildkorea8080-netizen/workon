# WORKON 구현 계획서 (PLAN.md)

**작성일**: 2026년 4월 17일  
**기반**: RESEARCH.md + AI 업무도우미 제작가이드 v2.0  
**대상**: 관리자 포털 UI 완성 + 미구현 기능 통합

---

## 1. 전체 접근 방식

### 1.1 현재 상태
- ✅ 백엔드: 약 85% 완성 (API, DB, 비즈니스 로직)
- ❌ 프론트엔드: 약 20% (페이지 구조만 있고 UI 없음)
- 🔴 CRITICAL 이슈: 3개 (응답 포맷, 테이블명, 인증 패턴)

### 1.2 구현 순서 (우선순위)

```
PHASE 1: CRITICAL 이슈 해결 (1일, 즉시)
├─ API 응답 포맷 통일 (success → ok)
├─ OPENAI_API_KEY 제거 또는 선택화
└─ 인증 패턴 통일 (getServerSession 제거)

PHASE 2: 관리자 포털 UI 완성 (5일)
├─ 레이아웃 + 사이드바 메뉴
├─ 대시보드 (차트 + 요약 카드)
├─ 비서 관리 (CRUD UI)
├─ 문서 관리 (업로드 + 목록)
├─ 사용자 관리 (초대 + 권한)
├─ 사용량 통계 (차트)
└─ 보안 설정 (금칙어 + IP 제한)

PHASE 3: 메인 채팅 UI 개선 (3일)
├─ 비서 선택 카드 UI 개선
├─ 메시지 버블 + 마크다운 렌더링
├─ 참고 출처 인용 UI
└─ 왼쪽 사이드바 (대화 히스토리)

PHASE 4: 데이터 조회 최적화 (2일)
├─ 대화 히스토리 조회 API
├─ 문서 검색 API
└─ 통계 데이터 집계 쿼리

PHASE 5: 테스트 + 배포 (2일)
├─ 통합 테스트 시나리오 실행
├─ 버그 수정
└─ Vercel 배포 설정
```

---

## 2. 수정/생성할 파일 목록

### PHASE 1: CRITICAL 이슈 (3개 파일)
```
✏️ src/lib/config.ts                    (OPENAI_API_KEY 선택화)
✏️ src/app/api/agents/route.ts          (success → ok)
✏️ src/app/api/report/route.ts          (success → ok)
✏️ src/app/api/forbidden-words/route.ts (success → ok)
✏️ src/app/api/stats/route.ts           (success → ok, 테이블명 수정)
```

### PHASE 2-3: 관리자 포털 + 메인 UI (22개 파일)
```
[레이아웃 및 기본]
✏️ src/app/layout.tsx                   (SessionProvider 추가)
✨ src/app/admin/layout.tsx             (사이드바 레이아웃)

[관리자 페이지]
✨ src/app/admin/page.tsx               (대시보드)
✨ src/app/admin/agents/page.tsx        (비서 관리)
✨ src/app/admin/documents/page.tsx     (문서 관리)
✨ src/app/admin/users/page.tsx         (사용자 관리)
✨ src/app/admin/stats/page.tsx         (통계)
✨ src/app/admin/settings/page.tsx      (보안 설정)

[행정자 컴포넌트]
✨ src/components/admin/AdminHeader.tsx
✨ src/components/admin/AdminSidebar.tsx
✨ src/components/admin/AgentForm.tsx   (모달)
✨ src/components/admin/DocumentUpload.tsx
✨ src/components/admin/UserInviteModal.tsx
✨ src/components/admin/StatsDashboard.tsx

[메인 UI 컴포넌트]
✨ src/components/chat/AgentCard.tsx
✨ src/components/chat/AgentSelector.tsx
✨ src/components/chat/MessageBubble.tsx
✨ src/components/chat/SourceCitation.tsx
✨ src/components/chat/ChatInterface.tsx
✏️ src/app/page.tsx                     (메인 레이아웃)
✏️ src/app/chat/page.tsx                (채팅 페이지)

[API 라우트]
✨ src/app/api/conversations/route.ts   (대화 목록)
✨ src/app/api/conversations/[id]/route.ts (대화 상세)
```

### PHASE 4: 최적화 (5개 파일 수정)
```
✏️ src/lib/rag.ts                      (대화 히스토리 포함 컨텍스트)
✏️ src/app/api/stats/route.ts          (쿼리 최적화)
✏️ src/lib/supabase.ts                 (헬퍼 함수 추가)
```

---

## 3. 코드 스니펫 및 함수 시그니처

### 3.1 PHASE 1: CRITICAL 이슈 수정

#### config.ts (OPENAI_API_KEY 선택화)
```typescript
// 수정 전
export const OPENAI_API_KEY = getEnv('OPENAI_API_KEY');

// 수정 후
export const OPENAI_API_KEY = getEnv('OPENAI_API_KEY', false);  // required = false
```

#### API 응답 포맷 통일
```typescript
// 패턴: stats/route.ts 수정 예시
export async function GET(request: NextRequest) {
  try {
    // ... 로직 ...
    
    // 수정 전
    return NextResponse.json({ success: true, data: {...} });
    
    // 수정 후
    return NextResponse.json({ ok: true, data: {...} });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: { message: '...' } },
      { status: 500 }
    );
  }
}
```

#### 인증 패턴 통일 (agents/route.ts)
```typescript
// 수정 전
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/nextAuthOptions';
const session = await getServerSession(authOptions);

// 수정 후
import { getServerAuthSession } from '@/lib/auth';
const session = await getServerAuthSession();
```

#### stats.ts 테이블명 수정
```typescript
// 수정 전
{ count: chatSessions } = await supabase
  .from('chat_sessions')  // ❌ 없는 테이블
  .select('*', { count: 'exact' });

// 수정 후
{ count: conversations } = await supabase
  .from('conversations')  // ✅ 올바른 테이블
  .select('*', { count: 'exact' });
```

---

### 3.2 PHASE 2: 관리자 포털 UI

#### AdminLayout (새 파일)
```typescript
// src/app/admin/layout.tsx
'use client';

import { AdminSidebar } from '@/components/admin/AdminSidebar';
import { AdminHeader } from '@/components/admin/AdminHeader';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen bg-gray-50">
      {/* 좌측 사이드바 (240px) */}
      <AdminSidebar />
      
      {/* 우측 영역 */}
      <div className="flex-1 flex flex-col">
        <AdminHeader />
        <main className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
```

#### AdminSidebar 컴포넌트
```typescript
// src/components/admin/AdminSidebar.tsx
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  BarChart3,
  Users,
  Zap,
  FileText,
  Settings,
  LogOut,
} from 'lucide-react';

const menuItems = [
  { href: '/admin', label: '대시보드', icon: BarChart3 },
  { href: '/admin/agents', label: '비서 관리', icon: Zap },
  { href: '/admin/documents', label: '문서 관리', icon: FileText },
  { href: '/admin/users', label: '사용자 관리', icon: Users },
  { href: '/admin/stats', label: '사용량 통계', icon: BarChart3 },
  { href: '/admin/settings', label: '보안 설정', icon: Settings },
];

export function AdminSidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-60 bg-blue-900 text-white flex flex-col">
      {/* 헤더 */}
      <div className="p-6 border-b border-blue-800">
        <h1 className="text-xl font-bold">관리자 포털</h1>
        <p className="text-xs text-blue-300 mt-2">WORKON v0.1</p>
      </div>

      {/* 메뉴 */}
      <nav className="flex-1 p-4">
        {menuItems.map((item) => {
          const Icon = item.icon;
          const isActive = pathname === item.href || pathname.startsWith(item.href + '/');
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 px-4 py-3 rounded-lg mb-2 transition ${
                isActive
                  ? 'bg-blue-700 text-white'
                  : 'text-blue-100 hover:bg-blue-800'
              }`}
            >
              <Icon className="w-5 h-5" />
              <span className="text-sm">{item.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* 하단 (로그아웃) */}
      <div className="p-4 border-t border-blue-800">
        <button className="flex items-center gap-3 px-4 py-3 w-full text-blue-100 hover:bg-blue-800 rounded-lg">
          <LogOut className="w-5 h-5" />
          <span>로그아웃</span>
        </button>
      </div>
    </aside>
  );
}
```

#### Admin 대시보드
```typescript
// src/app/admin/page.tsx
'use client';

import { useEffect, useState } from 'react';
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

interface DashboardStats {
  totalUsers: number;
  totalAgents: number;
  totalDocuments: number;
  monthlyTokens: number;
  usageByDay: Array<{ date: string; tokens: number }>;
  agentUsage: Array<{ name: string; count: number }>;
}

export default function AdminPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchStats();
  }, []);

  async function fetchStats() {
    try {
      const res = await fetch('/api/stats');
      const { ok, data } = await res.json();
      if (ok) setStats(data);
    } catch (error) {
      console.error('Failed to fetch stats:', error);
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <div className="p-6">로딩 중...</div>;
  if (!stats) return <div className="p-6">데이터 로드 실패</div>;

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-8">관리자 대시보드</h1>

      {/* 요약 카드 */}
      <div className="grid grid-cols-4 gap-6 mb-8">
        <Card label="총 사용자" value={stats.totalUsers} icon="👥" />
        <Card label="AI 비서" value={stats.totalAgents} icon="🤖" />
        <Card label="등록 문서" value={stats.totalDocuments} icon="📄" />
        <Card label="이번달 토큰" value={stats.monthlyTokens.toLocaleString()} icon="🔌" />
      </div>

      {/* 차트 */}
      <div className="grid grid-cols-2 gap-8">
        {/* 일별 사용량 */}
        <div className="bg-white p-6 rounded-lg shadow">
          <h2 className="text-lg font-semibold mb-4">최근 7일 사용량</h2>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={stats.usageByDay}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" />
              <YAxis />
              <Tooltip />
              <Line type="monotone" dataKey="tokens" stroke="#3b82f6" />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* 비서별 사용 */}
        <div className="bg-white p-6 rounded-lg shadow">
          <h2 className="text-lg font-semibold mb-4">비서별 사용 횟수</h2>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={stats.agentUsage}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="name" />
              <YAxis />
              <Tooltip />
              <Bar dataKey="count" fill="#3b82f6" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

function Card({ label, value, icon }: { label: string; value: string | number; icon: string }) {
  return (
    <div className="bg-white p-6 rounded-lg shadow border-l-4 border-blue-500">
      <div className="text-3xl mb-2">{icon}</div>
      <p className="text-gray-600 text-sm">{label}</p>
      <p className="text-2xl font-bold">{value}</p>
    </div>
  );
}
```

#### 비서 관리 페이지
```typescript
// src/app/admin/agents/page.tsx
'use client';

import { useEffect, useState } from 'react';
import { Agent } from '@/lib/db';
import AgentForm from '@/components/admin/AgentForm';

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);

  useEffect(() => {
    fetchAgents();
  }, []);

  async function fetchAgents() {
    try {
      const res = await fetch('/api/agents');
      const { ok, data } = await res.json();
      if (ok) setAgents(data);
    } catch (error) {
      console.error('Failed to fetch agents:', error);
    } finally {
      setLoading(false);
    }
  }

  async function deleteAgent(id: string) {
    if (!confirm('이 비서를 삭제하시겠습니까?')) return;
    
    try {
      const res = await fetch(`/api/agents/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setAgents(agents.filter(a => a.id !== id));
      }
    } catch (error) {
      console.error('Failed to delete agent:', error);
    }
  }

  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-bold">비서 관리</h1>
        <button
          onClick={() => {
            setEditingAgent(null);
            setShowForm(true);
          }}
          className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700"
        >
          + 새 비서 만들기
        </button>
      </div>

      {showForm && (
        <AgentForm
          agent={editingAgent}
          onSave={() => {
            setShowForm(false);
            fetchAgents();
          }}
          onCancel={() => setShowForm(false)}
        />
      )}

      {/* 비서 목록 테이블 */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-100 border-b">
            <tr>
              <th className="px-6 py-3 text-left text-sm font-semibold">이름</th>
              <th className="px-6 py-3 text-left text-sm font-semibold">설명</th>
              <th className="px-6 py-3 text-left text-sm font-semibold">문서 수</th>
              <th className="px-6 py-3 text-left text-sm font-semibold">활성</th>
              <th className="px-6 py-3 text-left text-sm font-semibold">작업</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((agent) => (
              <tr key={agent.id} className="border-b hover:bg-gray-50">
                <td className="px-6 py-4">{agent.name}</td>
                <td className="px-6 py-4 text-sm text-gray-600">{agent.description}</td>
                <td className="px-6 py-4">-</td>
                <td className="px-6 py-4">
                  <span className={`px-3 py-1 rounded text-sm ${agent.is_active ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'}`}>
                    {agent.is_active ? '활성' : '비활성'}
                  </span>
                </td>
                <td className="px-6 py-4">
                  <button
                    onClick={() => {
                      setEditingAgent(agent);
                      setShowForm(true);
                    }}
                    className="text-blue-600 hover:underline mr-4"
                  >
                    수정
                  </button>
                  <button
                    onClick={() => deleteAgent(agent.id)}
                    className="text-red-600 hover:underline"
                  >
                    삭제
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

---

### 3.3 PHASE 3: 메인 채팅 UI

#### ChatInterface (핵심 컴포넌트)
```typescript
// src/components/chat/ChatInterface.tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import { Agent } from '@/lib/db';
import MessageBubble from './MessageBubble';
import SourceCitation from './SourceCitation';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  sources?: Array<{ documentTitle: string; similarity: number }>;
}

export default function ChatInterface({ agent }: { agent: Agent }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  async function handleSend() {
    if (!input.trim()) return;

    const userMessage = input;
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: userMessage }]);
    setLoading(true);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_id: agent.id,
          message: userMessage,
        }),
      });

      if (!response.ok) {
        throw new Error('Chat failed');
      }

      const { ok, data } = await response.json();
      if (ok) {
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: data.response,
          sources: data.chunks?.map(c => ({
            documentTitle: c.documentTitle,
            similarity: c.similarity,
          })),
        }]);
      }
    } catch (error) {
      console.error('Failed to send message:', error);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col h-full bg-white">
      {/* 메시지 영역 */}
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {messages.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-500">
            <div className="text-center">
              <div className="text-6xl mb-4">🤖</div>
              <p className="text-lg font-semibold">{agent.name}</p>
              <p className="text-sm mt-2">{agent.description}</p>
              <p className="text-xs mt-4 text-gray-400">메시지를 입력해보세요</p>
            </div>
          </div>
        ) : (
          <>
            {messages.map((msg, idx) => (
              <div key={idx}>
                <MessageBubble role={msg.role} content={msg.content} />
                {msg.role === 'assistant' && msg.sources && msg.sources.length > 0 && (
                  <SourceCitation sources={msg.sources} />
                )}
              </div>
            ))}
            {loading && (
              <div className="flex items-center gap-2 text-gray-500">
                <span className="animate-pulse">●</span>
                <span>생각 중...</span>
              </div>
            )}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* 입력 영역 */}
      <div className="border-t p-4">
        <div className="flex gap-4">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder="메시지를 입력하세요... (Enter로 전송, Shift+Enter로 줄바꿈)"
            className="flex-1 border rounded-lg p-3 resize-none focus:outline-none focus:border-blue-500"
            rows={3}
          />
          <button
            onClick={handleSend}
            disabled={loading || !input.trim()}
            className="bg-blue-600 text-white px-4 py-3 rounded-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
          >
            전송
          </button>
        </div>
      </div>
    </div>
  );
}
```

#### MessageBubble 컴포넌트
```typescript
// src/components/chat/MessageBubble.tsx
'use client';

import { ReactNode } from 'react';

interface Props {
  role: 'user' | 'assistant';
  content: string;
}

export default function MessageBubble({ role, content }: Props) {
  const isUser = role === 'user';

  // 간단한 마크다운: **bold**, - list, \`code\`
  const renderContent = (text: string): ReactNode => {
    return text.split('\n').map((line, idx) => {
      // 불릿 리스트
      if (line.startsWith('- ') || line.startsWith('* ')) {
        return (
          <li key={idx} className="ml-4">
            {parseInlineMarkdown(line.substring(2))}
          </li>
        );
      }
      // 번호 리스트
      if (/^\d+\.\s/.test(line)) {
        return (
          <li key={idx} className="ml-4 list-decimal">
            {parseInlineMarkdown(line.replace(/^\d+\.\s/, ''))}
          </li>
        );
      }
      return <p key={idx}>{parseInlineMarkdown(line)}</p>;
    });
  };

  const parseInlineMarkdown = (text: string): ReactNode => {
    const parts: ReactNode[] = [];
    let lastIdx = 0;

    // **bold** 패턴
    const boldRegex = /\*\*(.*?)\*\*/g;
    let match;

    while ((match = boldRegex.exec(text)) !== null) {
      if (match.index > lastIdx) {
        parts.push(text.substring(lastIdx, match.index));
      }
      parts.push(<strong key={parts.length}>{match[1]}</strong>);
      lastIdx = boldRegex.lastIndex;
    }

    if (lastIdx < text.length) {
      parts.push(text.substring(lastIdx));
    }

    return parts;
  };

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-2xl px-4 py-3 rounded-lg ${
          isUser
            ? 'bg-blue-600 text-white'
            : 'bg-gray-100 text-gray-900 border border-gray-200'
        }`}
      >
        <div className="text-sm leading-relaxed">
          {renderContent(content)}
        </div>
      </div>
    </div>
  );
}
```

#### SourceCitation 컴포넌트
```typescript
// src/components/chat/SourceCitation.tsx
'use client';

import { useState } from 'react';

interface Props {
  sources: Array<{ documentTitle: string; similarity: number }>;
}

export default function SourceCitation({ sources }: Props) {
  const [expanded, setExpanded] = useState(false);

  if (!sources || sources.length === 0) return null;

  return (
    <div className="text-sm text-gray-600 mt-2 pl-4 border-l-2 border-gray-300">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 hover:text-gray-900"
      >
        <span>{expanded ? '▼' : '▶'}</span>
        <span>📎 참고 문서 ({sources.length})</span>
      </button>
      
      {expanded && (
        <ul className="mt-2 ml-4 space-y-1">
          {sources.map((src, idx) => (
            <li key={idx}>
              • {src.documentTitle}
              <span className="text-xs text-gray-500 ml-2">
                (유사도: {(src.similarity * 100).toFixed(1)}%)
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

---

### 3.4 PHASE 4: API 라우트 추가

#### 대화 목록 조회
```typescript
// src/app/api/conversations/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabase } from '@/lib/supabase';

export async function GET(request: NextRequest) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, error: { message: '인증이 필요합니다.' } }, { status: 401 });
  }

  try {
    const { data: conversations } = await supabase
      .from('conversations')
      .select('id, agent_id, title, created_at')
      .eq('user_id', session.user.id)
      .order('created_at', { ascending: false })
      .limit(10);

    return NextResponse.json({ ok: true, data: conversations });
  } catch (error) {
    return NextResponse.json({ ok: false, error: { message: '조회 실패' } }, { status: 500 });
  }
}
```

---

## 4. 고려사항 및 트레이드오프

### 4.1 성능
- **클라이언트 캐싱**: useEffect에서 fetch하는 데이터를 React Context로 캐싱
- **무한 스크롤**: 메시지 목록이 커지면 페이지네이션 고려
- **이미지 최적화**: 에이전트 아이콘은 이모지 사용 (이미지 로드 최소화)

### 4.2 UX
- **자동 스크롤**: 새 메시지 도착 시 자동으로 하단으로 스크롤
- **로딩 상태**: 명확한 로딩 표시 ("생각 중...")
- **에러 처리**: 모든 실패 상황에 사용자 친화적 메시지

### 4.3 보안
- 모든 API 요청에 인증 검증
- 부서 기반 데이터 격리 유지
- 금지어/개인정보 필터 클라이언트 단계에서도 경고

### 4.4 마이그레이션
- 기존 데이터: Supabase 마이그레이션 실행하면 자동 적용
- 롤백: 필요 시 이전 버전의 마이그레이션 파일 사용

---

## 5. 단계별 TODO 체크리스트

### 📋 PHASE 1: CRITICAL 이슈 해결

- [ ] `config.ts`: OPENAI_API_KEY를 선택 항목으로 변경
- [ ] `agents/route.ts`: `success` → `ok` 변경, getServerSession 제거
- [ ] `report/route.ts`: `success` → `ok` 변경, 테이블명 확인
- [ ] `forbidden-words/route.ts`: `success` → `ok` 변경
- [ ] `stats/route.ts`: `success` → `ok` 변경, `chat_sessions` → `conversations`
- [ ] 모든 변경 후 `npm run build` 실행 및 에러 확인

### 📋 PHASE 2: 관리자 포털 UI

- [ ] `app/admin/layout.tsx` 생성 (사이드바 + 헤더)
- [ ] `components/admin/AdminSidebar.tsx` 생성
- [ ] `components/admin/AdminHeader.tsx` 생성
- [ ] `app/admin/page.tsx` 생성 (대시보드 + 차트)
- [ ] `app/admin/agents/page.tsx` 생성
- [ ] `components/admin/AgentForm.tsx` 생성 (모달)
- [ ] `app/admin/documents/page.tsx` 생성
- [ ] `components/admin/DocumentUpload.tsx` 생성 (드래그앤드롭)
- [ ] `app/admin/users/page.tsx` 생성
- [ ] `components/admin/UserInviteModal.tsx` 생성
- [ ] `app/admin/stats/page.tsx` 생성
- [ ] `app/admin/settings/page.tsx` 생성

### 📋 PHASE 3: 메인 채팅 UI

- [ ] `components/chat/AgentCard.tsx` 생성
- [ ] `components/chat/AgentSelector.tsx` 생성
- [ ] `components/chat/MessageBubble.tsx` 생성 (마크다운 렌더링)
- [ ] `components/chat/SourceCitation.tsx` 생성
- [ ] `components/chat/ChatInterface.tsx` 생성
- [ ] `app/page.tsx` 업데이트 (메인 레이아웃)
- [ ] `app/chat/page.tsx` 생성

### 📋 PHASE 4: API 최적화

- [ ] `api/conversations/route.ts` 생성 (대화 목록)
- [ ] `api/conversations/[id]/route.ts` 생성 (대화 상세)
- [ ] `lib/rag.ts` 업데이트 (대화 히스토리 포함)
- [ ] `api/stats/route.ts` 최적화 (쿼리 개선)

### 📋 PHASE 5: 테스트 + 배포

- [ ] 모든 페이지 로드 테스트 (에러 확인)
- [ ] 관리자 기능 E2E 테스트 (비서 생성 → 문서 업로드 → 채팅)
- [ ] 모바일 반응형 테스트
- [ ] `npm run build` 최종 확인
- [ ] Vercel `vercel.json` 검증
- [ ] `.env.production` 설정 (Vercel 대시보드)
- [ ] 배포 실행: `vercel --prod`

---

## 6. 실제 구현 코드 example (추가)

### app/page.tsx (메인 레이아웃)
```typescript
// src/app/page.tsx
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import AgentSelector from '@/components/chat/AgentSelector';
import ChatInterface from '@/components/chat/ChatInterface';
import { Agent } from '@/lib/db';

export default function HomePage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);

  useEffect(() => {
    if (status === 'unauthenticated') {
      router.push('/login');
    }
  }, [status]);

  useEffect(() => {
    if (session?.user?.id) {
      fetchAgents();
    }
  }, [session?.user?.id]);

  async function fetchAgents() {
    try {
      const res = await fetch('/api/agents');
      const { ok, data } = await res.json();
      if (ok) setAgents(data);
    } catch (error) {
      console.error('Failed to fetch agents:', error);
    }
  }

  if (status === 'loading') {
    return <div className="min-h-screen flex items-center justify-center">로딩 중...</div>;
  }

  return (
    <div className="flex h-screen bg-gray-50">
      {/* 좌측 사이드바 */}
      <aside className="w-60 bg-blue-900 text-white flex flex-col border-r">
        <div className="p-6 border-b border-blue-800">
          <h1 className="text-xl font-bold">WORKON</h1>
          <p className="text-xs text-blue-300 mt-2">AI 업무도우미</p>
        </div>

        <nav className="flex-1 p-4">
          <p className="text-xs text-blue-300 uppercase tracking-wide mb-4">AI 비서</p>
          {agents.length > 0 ? (
            <div className="space-y-2">
              {agents.map(agent => (
                <button
                  key={agent.id}
                  onClick={() => setSelectedAgent(agent)}
                  className={`w-full text-left px-4 py-2 rounded-lg transition ${
                    selectedAgent?.id === agent.id
                      ? 'bg-blue-700'
                      : 'hover:bg-blue-800 text-blue-100'
                  }`}
                >
                  <div className="font-semibold">{agent.name}</div>
                  <div className="text-xs text-blue-300 line-clamp-1">{agent.description}</div>
                </button>
              ))}
            </div>
          ) : (
            <p className="text-sm text-blue-300">사용 가능한 비서가 없습니다.</p>
          )}
        </nav>

        {/* 관리자 링크 */}
        {session?.user?.role === 'ADMIN' && (
          <div className="p-4 border-t border-blue-800">
            <a
              href="/admin"
              className="text-sm text-blue-300 hover:text-white flex items-center gap-2"
            >
              ⚙️ 관리자 포털
            </a>
          </div>
        )}

        {/* 사용자 정보 */}
        <div className="p-4 border-t border-blue-800 text-xs">
          <p className="text-blue-300">{session?.user?.email}</p>
        </div>
      </aside>

      {/* 우측 메인 영역 */}
      <main className="flex-1 flex flex-col">
        {selectedAgent ? (
          <ChatInterface agent={selectedAgent} />
        ) : (
          <div className="flex items-center justify-center h-full">
            <AgentSelector agents={agents} onSelect={setSelectedAgent} />
          </div>
        )}
      </main>
    </div>
  );
}
```

---

## 요약

| Phase | 작업 | 파일 수 | 예상 시간 | 우선순위 |
|-------|------|--------|----------|---------|
| 1 | CRITICAL 이슈 | 5개 수정 | 1일 | 🔴 즉시 |
| 2 | 관리자 포털 UI | 14개 생성 | 5일 | 🟠 높음 |
| 3 | 메인 채팅 UI | 8개 생성 | 3일 | 🟠 높음 |
| 4 | API 최적화 | 3개 신규/수정 | 2일 | 🟡 중간 |
| 5 | 테스트 + 배포 | - | 2일 | 🟠 높음 |
| **합계** | | **30개 파일** | **13일** | |

**권장 실행 순서**: PHASE 1 → 2 → 3 → 4 → 5
