import { describe, expect, it } from 'vitest';
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
