import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * AI 대화 화면을 업무 화면과 같은 꼴로(2026-11-06) — `/chat`이 옛 남색 화면(어두운 대화 목록·정부 파란색)으로 떠
 * 업무 홈에서 'AI 대화'를 누르면 다른 서비스처럼 보였다. 이제 업무 틀(WorkShell) 안에서 같은 청록 색을 쓴다
 */
const read = (p: string) => readFileSync(p, 'utf8');

describe('AI 대화 화면 디자인', () => {
  it('/chat은 업무 틀 안에서 그린다(업무 홈을 끈 기관의 `/`는 틀 없이)', () => {
    expect(read('src/app/chat/page.tsx')).toContain('<ChatHome workspace />');
    const home = read('src/components/chat/ChatHome.tsx');
    expect(home).toContain("import WorkShell from '@/components/work/WorkShell'");
    expect(home).toMatch(/if \(workspace\) \{[\s\S]*<WorkShell>/);
    expect(read('src/app/page.tsx')).toContain("if (mode === 'chat') return <ChatHome />;");
  });

  it('업무 틀 안에 main을 겹치지 않는다(WorkShell이 이미 main)', () => {
    expect(read('src/components/chat/ChatHome.tsx')).not.toMatch(/<main[\s>]/);
  });

  it('대화 화면 부품에 옛 남색·brand 색이 남지 않는다', () => {
    const files = [...readdirSync('src/components/chat').filter((f) => f.endsWith('.tsx')).map((f) => join('src/components/chat', f)), 'src/components/layout/Sidebar.tsx'];
    const offenders = files.filter((f) => /#003087|#002070|#1C2B4A|(?<=[-:])brand-\d/.test(read(f).replace(/from-\[#1C2B4A\]/g, '')));
    expect(offenders).toEqual([]);
  });

  it('대화 목록은 밝은 바탕 — 선택한 대화는 업무 메뉴와 같은 청록', () => {
    const sidebar = read('src/components/layout/Sidebar.tsx');
    expect(sidebar).toContain('border-r border-[#E9EBF2] bg-white');
    expect(sidebar).toContain("selected ? 'bg-[#e7f5f5]'");
    expect(sidebar).not.toMatch(/text-white\/|bg-white\/\d/);
  });
});

describe('사이드바 하나 — 업무 메뉴 아래 최근 대화(2026-11-06)', () => {
  it('업무 틀 사이드바가 최근 대화를 Suspense 안에서 그린다(useSearchParams)', () => {
    const shell = read('src/components/work/WorkShell.tsx');
    expect(shell).toContain('<Suspense fallback={null}><RecentConversations /></Suspense>');
    const recent = read('src/components/work/RecentConversations.tsx');
    expect(recent).toMatch(/<Sidebar\s+embedded/);
    expect(recent).toContain("pathname.startsWith('/chat') ? params.get('conv') : null");
  });

  it('업무 틀의 대화 화면에는 대화 목록 둘째 칸이 없다(업무 홈을 끈 기관의 `/`에는 남음)', () => {
    const home = read('src/components/chat/ChatHome.tsx');
    expect(home).toContain('{!workspace && <Sidebar');
    expect(home).toContain("window.history.replaceState(null, '', conversationHref(id))");
    expect(home).toMatch(/if \(conversationIdRef\.current === id\) return;/);
  });

  it('알림 — 새 대화·목록 바뀜은 창 이벤트, 대화 주소는 conv 매개변수', async () => {
    const events = await import('@/lib/chat-events');
    expect(events.conversationHref('a b')).toBe('/chat?conv=a%20b');
    const seen: string[] = [];
    const target = new EventTarget();
    vi.stubGlobal('window', target);
    target.addEventListener(events.CHAT_NEW_EVENT, () => seen.push('new'));
    target.addEventListener(events.CHAT_LIST_CHANGED_EVENT, () => seen.push('changed'));
    events.announceNewChat();
    events.announceConversationsChanged();
    vi.unstubAllGlobals();
    expect(seen).toEqual(['new', 'changed']);
  });
});


describe('사이드바 접기(2026-11-06)', () => {
  it('접으면 아이콘만 — 이름은 aria-label·title로, 최근 대화는 숨김', () => {
    const shell = read('src/components/work/WorkShell.tsx');
    expect(shell).toContain("aria-label={collapsed ? '사이드바 펼치기' : '사이드바 접기'}");
    expect(shell).toContain('aria-expanded={!collapsed}');
    expect(shell).toContain('aria-label={collapsed ? n.label : undefined}');
    expect(shell).toContain('{!collapsed && n.label}');
    expect(shell).toContain('{!collapsed && <Suspense fallback={null}><RecentConversations /></Suspense>}');
    // 서버 렌더링과 어긋나지 않게 처음엔 펼친 채로, 마운트 뒤 기억한 값을 읽는다
    expect(shell).toContain('useState(false)');
    expect(shell).toContain('useEffect(() => setCollapsed(readSidebarCollapsed()), [])');
  });

  it('접었는지는 이 브라우저에만 — 저장소를 못 쓰면 펼친 채로', async () => {
    const pref = await import('@/lib/sidebar-pref');
    const map = new Map<string, string>();
    const store = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) };
    expect(pref.readSidebarCollapsed(store)).toBe(false);
    pref.writeSidebarCollapsed(true, store);
    expect(map.get(pref.SIDEBAR_COLLAPSED_KEY)).toBe('1');
    expect(pref.readSidebarCollapsed(store)).toBe(true);
    pref.writeSidebarCollapsed(false, store);
    expect(map.has(pref.SIDEBAR_COLLAPSED_KEY)).toBe(false);
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
    expect(pref.readSidebarCollapsed(broken)).toBe(false);
    expect(() => pref.writeSidebarCollapsed(true, broken)).not.toThrow();
    expect(pref.readSidebarCollapsed(null)).toBe(false);
    expect(read('src/lib/sidebar-pref.ts')).not.toMatch(/^import /m);
  });
});
