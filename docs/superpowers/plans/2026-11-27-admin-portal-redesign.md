# 관리자 포털 디자인 맞추기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 관리자 포털(`/admin/**`)의 틀과 강조색을 직원 화면(업무 틀 `WorkShell`)과 같은 밝은 사이드바·기관 테마 색(`ws-*`)으로 바꾼다.

**Architecture:** 서버 레이아웃(`src/app/admin/layout.tsx`)은 기관명·로고·테마 색을 읽어 `themeStyle`을 바깥 틀에 걸고, 사이드바는 새 클라이언트 부품 `AdminSidebar`(접기·작은 화면 탭)가 그린다. 안쪽 화면의 박힌 남색·파랑·`brand-*`는 정해 둔 표대로 `ws-*` 클래스로 바꾸고, 시험이 재발을 막는다.

**Tech Stack:** Next.js 14 App Router, Tailwind(`ws-*` = `rgb(var(--ws-…))`), Vitest(소스 검사).

**Spec:** `docs/superpowers/specs/2026-11-27-admin-portal-redesign-design.md`

## Global Constraints
- 슈퍼관리자 포털·로그인 화면·각 관리자 화면의 배치는 바꾸지 않는다.
- 상태 색(red·emerald·green·amber·orange·purple)은 그대로.
- 기관 테마 색은 `organizations.theme_color`(0067) — 못 읽거나 없으면 기본(`globals.css :root`, `themeStyle`이 null).
- 사이드바 접기 기억은 직원 화면과 같은 `readSidebarCollapsed`/`writeSidebarCollapsed`.
- 대리 접근 띠(`ImpersonateBanner`)와 그 아래 52px 밀기는 그대로.

## Review Focus
- 로고가 없는 기관 → 첫 글자 칸(`brandInitial`)과 기관명. 시험: 사이드바 소스에 `brandInitial`.
- 테마 색 칸을 못 읽음 → 기본 색으로 그리고 화면은 그대로. 시험: 레이아웃 소스가 `themeStyle(`을 쓰고 오류에도 렌더(읽기 실패를 던지지 않음).
- 좁은 화면(768px 미만) → 사이드바 대신 위쪽 가로 탭. 시험: `md:hidden` 탭과 `hidden md:flex` 사이드바.
- 대리 접근 중 → 띠 아래로 밀림(`mt-[52px]`)·'대리 접근 중' 표시 유지.
- 접은 사이드바 → 메뉴에 `aria-label`·`title`(아이콘만 보여도 이름을 읽음).

---

### Task 1: 관리자 틀 — 밝은 사이드바·테마 색·접기·작은 화면 탭

**Files:**
- Create: `src/components/admin/AdminSidebar.tsx`
- Modify: `src/components/admin/AdminNav.tsx`(메뉴 목록을 `ADMIN_NAV`로 내보내고 그리기는 `AdminSidebar`로), `src/app/admin/layout.tsx`
- Test: `tests/batch-0342.test.ts`

**Interfaces:**
- Produces: `AdminSidebar({ brandName: string; brandLogo: string | null; email: string; isImpersonating: boolean })`(client). `ADMIN_NAV: { href: string; label: string; icon: ReactNode; exact?: boolean }[]`(AdminNav.tsx에서 export).

- [ ] Step 1: 시험 — 레이아웃 소스에 `bg-[#1C2B4A]` 없음, `themeStyle(`·`<AdminSidebar` 있음, `select('name, logo_url, theme_color')`; 사이드바 소스에 `hidden md:flex`, `md:hidden`, `bg-ws-accent-soft text-ws-accent-text`, `readSidebarCollapsed`, `brandInitial`, `aria-current`; 접었을 때 `aria-label={collapsed ? item.label`.
- [ ] Step 2: 돌려 실패 확인 — `npx vitest run tests/batch-0342.test.ts`.
- [ ] Step 3: 구현 — 사이드바 모양·클래스는 `WorkShell`의 사이드바(흰 바탕·`border-[#E9EBF2]`·`w-64`/접으면 `w-[72px]`·고른 메뉴 `bg-ws-accent-soft text-ws-accent-text font-semibold`)를 그대로 따른다. 아래쪽: 사용자 이메일·'관리자'/'대리 접근 중'(amber), '업무 화면으로'(`/`). 레이아웃 바깥 틀 `bg-[#F7F8FC] text-[#22283D]`·Pretendard·`style={themeStyle(themeColor) ?? undefined}`; 테마 색은 기관을 읽는 select에 `theme_color`를 더해 받고 오류면 null.
- [ ] Step 4: 시험 통과 확인.

### Task 2: 안쪽 화면 강조색을 테마 색으로

**Files:**
- Modify: `src/app/admin/**`, `src/components/admin/**`(24파일 안팎)
- Test: `tests/batch-0342.test.ts`(같은 파일에 describe 하나 더)

바꾸기 표(앞쪽 접두 `hover:`·`focus:`·`group-hover:`·`from-`·`to-`·투명도 `/N`은 그대로 둠):

| 옛 | 새 |
|---|---|
| `bg-[#003087]`·`bg-brand-600`·`bg-blue-600`·`bg-blue-700` | `bg-ws-accent` |
| `bg-[#002070]`·`bg-brand-700`·`bg-blue-800`(hover) | `bg-ws-accent-hover` |
| `text-[#003087]`·`text-brand-700`·`text-blue-600/700/800/900` | `text-ws-accent-text` |
| `text-blue-400` | `text-ws-accent/60` |
| `border-[#003087]`·`border-brand-600`·`border-blue-400` | `border-ws-accent` |
| `border-blue-100/200/300` | `border-ws-accent/20`·`/30`·`/40` |
| `ring-[#003087]`·`ring-blue-500` | `ring-ws-accent` |
| `ring-brand-400` | `ring-ws-accent/40` |
| `bg-blue-50`·`bg-brand-50`·`from-blue-50` | `bg-ws-accent-soft`·`from-ws-accent-soft` |
| `bg-blue-100`·`bg-brand-100`·`to-blue-100`·`bg-blue-200` | `bg-ws-accent/15`·`to-ws-accent/15`·`bg-ws-accent/25` |
| `accent-[#003087]` | `accent-ws-accent` |

- [ ] Step 1: 시험 — `src/app/admin`·`src/components/admin`의 `.ts/.tsx` 어디에도 `#003087`·`#002070`·`#1C2B4A`(대소문자 무시)·`brand-[0-9]`·`blue-[0-9]` 없음.
- [ ] Step 2: 돌려 실패 확인.
- [ ] Step 3: 표대로 바꾸는 일회용 스크립트(스크래치패드)를 돌리고 남은 것을 손으로.
- [ ] Step 4: 시험 통과 + `tsc` + 전체 Vitest(옛 클래스를 문자열로 맞대던 시험은 새 클래스로).
- [ ] Step 5: 앱 안 브라우저(운영 배포 전에는 로컬 화면이 없어 운영 반영 뒤)로 넓은 화면·700px·접은 사이드바를 본다.
- [ ] Step 6: `CLAUDE.md` 표에 한 줄, 커밋은 사용자 "운영반영" 때.
