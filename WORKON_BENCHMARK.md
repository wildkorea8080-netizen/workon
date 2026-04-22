# WORKON 웍스AI 벤치마킹 구현 계획서

**작성일**: 2026-04-22  
**기준**: wrks.ai 핵심 기능 분석 + WORKON 현재 코드베이스 직접 확인  
**현황 요약**: 완료 1 / 부분구현 2 / 미구현 7 (10개 항목 기준)

---

## 현재 구현 상태 스냅샷

| # | 기능 | 상태 | 비고 |
|---|---|---|---|
| 1 | 초대 기반 회원가입 (invitations 테이블) | ❌ 미구현 | 임시 비밀번호 직접 생성 방식만 존재 |
| 2 | 비서 카테고리 탭 (category 컬럼) | ❌ 미구현 | agents 테이블에 category 없음 |
| 3 | 나만의 비서 (is_personal 컬럼) | ❌ 미구현 | agents 테이블에 is_personal 없음 |
| 4 | 즐겨찾기 (favorite_agent_ids) | ❌ 미구현 | users/agents 테이블 모두 없음 |
| 5 | 요술봉 API (/api/enhance-prompt) | ❌ 미구현 | 라우트 없음 |
| 6 | 공식 비서 신청 (approval_status) | ❌ 미구현 | agents 테이블에 없음 |
| 7 | 내 사용현황 (/my/stats) | ⚠️ 부분구현 | API는 있음, /my/stats 페이지 없음 |
| 8 | 대화 공유 (share_token) | ❌ 미구현 | conversations 테이블에 없음 |
| 9 | 대화 제목 수정 UI | ⚠️ 부분구현 | PUT API 있음, 사이드바 UI 없음 |
| 10 | 공공기관 특화 비서 seed | ✅ 구현됨 | seed_data.sql — 3기관 3비서 포함 |

---

## 구현 순서 (의존성 기준)

### 🔴 1순위 — DB 기반 작업 (먼저 해야 나머지가 가능)

- [x] **BM-01**: DB 마이그레이션 — invitations, category, is_personal, favorites, share_token, approval_status 컬럼 일괄 추가 ✅ 2026-04-22 완료

**추가할 내용:**
```sql
-- agents 테이블 컬럼 추가
ALTER TABLE agents ADD COLUMN category text default '일반';
ALTER TABLE agents ADD COLUMN is_personal boolean not null default false;
ALTER TABLE agents ADD COLUMN created_by_user_id uuid references users(id);
ALTER TABLE agents ADD COLUMN approval_status text not null default 'approved';
-- approval_status: 'pending' | 'approved' | 'rejected'

-- users 테이블 컬럼 추가
ALTER TABLE users ADD COLUMN favorite_agent_ids uuid[] not null default '{}';
ALTER TABLE users ADD COLUMN password_hash text;

-- conversations 테이블 컬럼 추가
ALTER TABLE conversations ADD COLUMN share_token text unique;
ALTER TABLE conversations ADD COLUMN is_shared boolean not null default false;

-- invitations 테이블 신규 생성
CREATE TABLE invitations (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references departments(id) on delete cascade,
  email text not null,
  role text not null default 'USER',
  token text not null unique,
  invited_by uuid references users(id),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);
```

**영향 파일**: `supabase/migrations/0005_benchmark_features.sql` (신규 생성)  
**예상 소요**: 1시간

---

### 🔴 2순위 — 핵심 API

- [ ] **BM-02**: 요술봉 API (`POST /api/enhance-prompt`)

**기능**: 사용자가 입력한 프롬프트를 Claude로 개선·보완해서 반환  
**입력**: `{ prompt: string, context?: string }`  
**출력**: `{ enhanced: string, suggestions: string[] }`  
**영향 파일**: `src/app/api/enhance-prompt/route.ts` (신규)  
**예상 소요**: 2시간

---

- [ ] **BM-03**: 초대 기반 회원가입 API + 페이지

**기능**: 관리자가 이메일 초대 → 수신자가 링크 클릭 → 비밀번호 설정 후 가입  
**신규 API**:
- `POST /api/invitations` — 초대 이메일 발송 (Resend API 사용)
- `GET /api/invitations/[token]` — 토큰 유효성 확인
- `POST /api/invitations/[token]/accept` — 초대 수락 + 계정 생성

**신규 페이지**: `/invite/[token]` — 초대 수락 폼  
**의존성**: BM-01 (invitations 테이블), Resend API 키 환경변수 필요  
**영향 파일**:
- `src/app/api/invitations/route.ts`
- `src/app/api/invitations/[token]/route.ts`
- `src/app/invite/[token]/page.tsx`
- `src/components/admin/UsersManager.tsx` (초대 버튼 UI 개선)

**예상 소요**: 4시간

---

- [ ] **BM-04**: 나만의 비서 CRUD API

**기능**: 일반 사용자가 자신만의 비서를 생성·수정·삭제 (is_personal=true)  
**API 변경**:
- `GET /api/agents` — `?type=personal` 쿼리 파라미터로 개인/공용 구분
- `POST /api/agents` — `is_personal: true`이면 USER 권한도 생성 가능하도록 완화

**의존성**: BM-01 (is_personal 컬럼)  
**영향 파일**:
- `src/app/api/agents/route.ts`
- `src/app/api/agents/[id]/route.ts`

**예상 소요**: 2시간

---

### 🟡 3순위 — 메인 UI 개편

- [ ] **BM-05**: 비서 카테고리 탭 + 즐겨찾기

**기능**:
- 비서 목록 상단에 카테고리 탭 (전체 / 업무 / 인사 / 법무 / 나만의 비서 / 즐겨찾기)
- 비서 카드에 ★ 즐겨찾기 토글 버튼
- 즐겨찾기는 `users.favorite_agent_ids` 배열에 저장

**신규 API**:
- `POST /api/users/favorites` — 즐겨찾기 추가/제거 토글

**의존성**: BM-01 (category, favorite_agent_ids), BM-04  
**영향 파일**:
- `src/components/chat/AgentSelector.tsx`
- `src/app/api/users/favorites/route.ts` (신규)

**예상 소요**: 3시간

---

- [ ] **BM-06**: 메인 화면 레이아웃 전면 개편

**기능**: 현재 에이전트 선택 → 채팅 흐름을 wrks.ai처럼 개편
- 로그인 후 비서 선택 그리드(카드) 화면이 먼저 표시
- 비서 선택 시 채팅 화면으로 전환 (슬라이드 또는 페이지 전환)
- 좌측 사이드바: 대화 목록 + 내 비서 섹션 분리

**의존성**: BM-05 (카테고리/즐겨찾기)  
**영향 파일**:
- `src/app/page.tsx`
- `src/components/chat/ChatInterface.tsx`
- `src/components/chat/AgentSelector.tsx`

**예상 소요**: 4시간

---

- [ ] **BM-07**: 나만의 비서 만들기 모달 UI

**기능**: 채팅 화면에서 "내 비서 만들기" 버튼 클릭 → 모달에서 이름/설명/프롬프트 입력  
- 요술봉 버튼으로 프롬프트 자동 개선 (BM-02 연동)
- 생성 즉시 비서 목록에 반영

**의존성**: BM-02 (요술봉), BM-04 (개인 비서 API)  
**영향 파일**:
- `src/components/chat/CreateAgentModal.tsx` (신규)
- `src/components/chat/ChatInterface.tsx`

**예상 소요**: 3시간

---

### 🟡 4순위 — 부가 기능

- [ ] **BM-08**: 공식 비서 등록 신청/승인

**기능**: 사용자가 만든 비서를 부서 전체 공용으로 신청 → 관리자 승인/반려  
- 신청: `PATCH /api/agents/[id]` `{ approval_status: 'pending' }`
- 관리자 승인 목록 UI: `/admin/agents`에 '검토 중' 탭 추가
- 승인 시 `is_personal=false`, `approval_status='approved'`로 변경

**의존성**: BM-01 (approval_status), BM-04  
**영향 파일**:
- `src/components/admin/AgentsManager.tsx`
- `src/app/api/agents/[id]/route.ts`

**예상 소요**: 3시간

---

- [ ] **BM-09**: 대화 제목 수정 / 삭제 / 공유

**기능**:
- 사이드바 대화 항목에 hover 시 수정·삭제 버튼 표시
- 제목 인라인 수정 (PUT API 이미 구현됨 — UI만 추가)
- 공유 버튼 → `share_token` 생성 → `/share/[token]` 공개 페이지

**의존성**: BM-01 (share_token)  
**신규 API**: `GET /api/conversations/share/[token]` (비인증 공개)  
**신규 페이지**: `/share/[token]/page.tsx`  
**영향 파일**:
- `src/components/chat/ConversationSidebar.tsx`
- `src/app/api/conversations/[id]/route.ts`
- `src/app/share/[token]/page.tsx` (신규)

**예상 소요**: 3시간

---

- [ ] **BM-10**: 내 사용현황 페이지 (`/my/stats`)

**기능**: 개인 사용 통계 전용 페이지  
- 이번 달 대화 수 / 보고서 생성 수 / 가장 많이 쓴 비서
- 주별 사용량 Recharts 라인 차트
- 최근 대화 10개 목록

**현황**: `GET /api/employee/stats` API 이미 존재 — 페이지·차트만 추가하면 됨  
**영향 파일**:
- `src/app/my/stats/page.tsx` (신규)
- `src/components/employee/MyStatsPage.tsx` (신규)
- `src/app/api/employee/stats/route.ts` (주별 데이터 필드 추가)

**예상 소요**: 2시간

---

### 🟢 5순위 — 공공기관 특화

- [ ] **BM-11**: 공공기관 특화 비서 8개 seed

**현황**: `supabase/seed_data.sql`에 3개 비서 존재 (복지정책 도우미, 연구기획 매니저, 시민참여 상담관)  
**추가할 5개**:
- 법무 검토 비서 (계약서·법령 검토)
- 예산 분석 비서 (예산안·결산 분석)
- 민원 응대 비서 (민원 문서 초안 작성)
- 회의록 비서 (회의 내용 요약·정리)
- 공문서 비서 (공문서 양식·작성 지원)

**영향 파일**: `supabase/seed_data.sql`  
**예상 소요**: 1시간

---

- [ ] **BM-12**: 공공기관 디자인 적용

**기능**: 공공기관 느낌의 UI 추가 옵션  
- 로고 영역에 기관명/부문 표시
- 색상 테마: 현재 인디고 → 공공기관 표준 파란색(`#003087`) 옵션
- 헤더에 기관 로고 업로드 기능

**영향 파일**:
- `src/app/admin/layout.tsx`
- `src/components/Shell.tsx`
- `src/app/api/departments/route.ts` (로고 URL 필드 추가)

**예상 소요**: 3시간

---

- [ ] **BM-13**: CSV 조직도 일괄 등록

**기능**: CSV 파일로 사용자 일괄 등록  
- 형식: `이름,이메일,부서명,역할`
- 파싱 후 유효성 검사 → 미리보기 테이블 → 일괄 초대 이메일 발송

**의존성**: BM-03 (초대 기반 가입)  
**영향 파일**:
- `src/components/admin/UsersManager.tsx` (CSV 업로드 탭 추가)
- `src/app/api/users/bulk/route.ts` (신규)

**예상 소요**: 3시간

---

## 전체 작업량 요약

| 순위 | 항목 | 개수 | 예상 시간 |
|---|---|---|---|
| 🔴 1순위 | DB 마이그레이션 | 1 | 1시간 |
| 🔴 2순위 | 핵심 API | 3 | 8시간 |
| 🟡 3순위 | 메인 UI 개편 | 3 | 10시간 |
| 🟡 4순위 | 부가 기능 | 3 | 8시간 |
| 🟢 5순위 | 공공기관 특화 | 3 | 7시간 |
| **합계** | | **13** | **~34시간** |

---

## 즉시 시작 가능한 작업 (의존성 없음)

아래 항목은 다른 작업과 독립적으로 바로 시작할 수 있습니다:

1. **BM-01** — DB 마이그레이션 (모든 작업의 전제 조건)
2. **BM-10** — `/my/stats` 페이지 (API 이미 존재, UI만 추가)
3. **BM-09** 중 제목 수정 UI — PUT API 이미 구현됨, 사이드바 버튼만 추가
4. **BM-11** — seed 데이터 추가 (코드 변경 없이 SQL만)

---

## 환경변수 추가 필요 항목

| 변수명 | 용도 | 필요 시점 |
|---|---|---|
| `RESEND_API_KEY` | 초대 이메일 발송 | BM-03 |
| `NEXT_PUBLIC_APP_URL` | 초대 링크 base URL | BM-03 |
