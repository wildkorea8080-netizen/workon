# TASKS.md — WORKON 작업 목록

**최종 업데이트**: 2026-04-21  
**전체 완성도 추정**: ~63%

> 우선순위: 🔴 크리티컬 → 🟠 높음 → 🟡 중간 → 🟢 낮음

---

## 전체 완성도 현황

| 영역 | 완성도 | 상태 |
|---|---|---|
| 인증 (로그인/회원가입) | 85% | 동작하나 초대 흐름 불완전 |
| 데이터베이스 스키마 | 75% | security_logs, RPC 함수 누락 |
| 문서 업로드 파이프라인 | 80% | 버그 있으나 핵심 로직 존재 |
| RAG 채팅 (`/api/chat`) | 85% | 실제 동작 가능 |
| Q&A (`/api/qna`) | 30% | RPC 함수 없어 작동 안 됨 |
| 보고서 생성 (`/api/report`) | 80% | 동작하나 히스토리 저장 없음 |
| 관리자 UI | 70% | 대부분 구현됨, 통계 미연결 |
| 직원 UI | 15% | 플레이스홀더만 존재 |
| 보안/필터링 | 60% | 금지어 필터 작동, security_logs 크래시 |
| 테스트 | 0% | 테스트 없음 |

---

## ✅ 완료된 기능

### 핵심 인프라
- [x] Next.js 14 App Router 프로젝트 설정
- [x] NextAuth.js Credentials 인증
- [x] Supabase 연동 (anon client + admin client)
- [x] 환경 변수 관리 (`src/lib/config.ts`)
- [x] API 응답 표준 포맷 (`{ ok, data/error }`)
- [x] 타입 정의 (`src/lib/db.ts`)

### 데이터베이스
- [x] 전체 스키마 마이그레이션 (`supabase/migrations/0001_init.sql`)
- [x] departments, users, agents, documents, conversations, messages 테이블
- [x] report_templates, forbidden_words, usage_logs 테이블
- [x] pgvector 확장 (`embedding vector(1024)`)
- [x] IVFFlat 인덱스 (embedding_idx)

### 문서 파이프라인
- [x] PDF 텍스트 추출 (`pdf-parse`)
- [x] DOCX 텍스트 추출 (`mammoth`)
- [x] 텍스트 청킹 (800단어, 100 겹침)
- [x] Voyage AI 임베딩 생성 (`voyage-3`)
- [x] Supabase Storage 업로드
- [x] 파일 보안 검증 (위험 확장자, 파일명 패턴)
- [x] 20MB 파일 크기 제한

### AI 기능
- [x] Claude API 래퍼 (`src/lib/claude.ts`)
- [x] RAG 채팅 API (`/api/chat`) — in-memory 코사인 유사도
- [x] 보고서 생성 API (`/api/report`) — 템플릿 플레이스홀더 치환
- [x] 금지어 필터링 (`src/lib/filter.ts`)
- [x] 개인정보 패턴 감지 (주민번호, 전화번호 등)

### 관리자 기능 (API)
- [x] 에이전트 CRUD (`/api/agents`, `/api/agents/[id]`)
- [x] 보고서 템플릿 CRUD (`/api/templates`, `/api/templates/[id]`)
- [x] 금지어 CRUD (`/api/forbidden-words`)
- [x] 통계 API (`/api/stats`)
- [x] 보안 로그 조회 API (`/api/security-logs`)
- [x] 사용자 목록 API (`GET /api/users`)

### 관리자 UI
- [x] 관리자 대시보드 레이아웃 (`/admin`)
- [x] 에이전트 관리 페이지 (`/admin/agents`)
- [x] 문서 관리 페이지 + 업로드 UI (`/admin/documents`)
- [x] 사용자 관리 페이지 (`/admin/users`)
- [x] 보고서 템플릿 관리 (`/admin/templates`)
- [x] 설정/금지어 관리 (`/admin/settings`)
- [x] 통계 페이지 (`/admin/stats`)
- [x] 사용 로그 페이지 (`/admin/logs`)
- [x] Recharts 기반 차트 (`UsageChart`)

### 채팅 UI
- [x] `ChatInterface` 컴포넌트 (전체 채팅 레이아웃)
- [x] `AgentSelector` (에이전트 카드 선택)
- [x] `ConversationSidebar` (대화 목록 사이드바)
- [x] `MessageBubble` (마크다운 렌더링 + 코드 하이라이팅)
- [x] `SourceCitation` (RAG 출처 표시)

### 보고서 UI (컴포넌트 존재)
- [x] `ReportWizard` 컴포넌트
- [x] `ReportForm` 컴포넌트
- [x] `ReportGenerator` 컴포넌트
- [x] `ReportViewer` 컴포넌트
- [x] `TemplateSelector` 컴포넌트

---

## ~~🔴 크리티컬 버그 수정~~ ✅ 완료 (2026-04-21)

### ✅ BUG-001: `upload/route.ts` — departmentId 미선언 참조 [완료]
**파일**: `src/app/api/upload/route.ts`  
**수정 내용**: 파일명/확장자 보안 검증 블록 전체를 `departmentId` 조회 이후로 이동. MIME 타입·파일 크기 검증은 앞에 유지(departmentId 불필요), 위험 파일명·차단 확장자 검증은 `departmentId` 확보 후 실행하도록 코드 순서 재정렬.

### ✅ BUG-002: `security_logs` 테이블 미존재 [완료]
**파일**: `supabase/migrations/0002_security_logs.sql` (신규 생성)  
**수정 내용**: `security_logs` 테이블 및 인덱스(department_id, user_id, event_type, severity, created_at) 마이그레이션 파일 추가. Supabase 대시보드에서 실행 필요.

### ✅ BUG-003: `search_document_chunks` RPC 미존재 [완료]
**파일**: `supabase/migrations/0003_search_document_chunks.sql` (신규 생성), `src/app/api/qna/route.ts`  
**수정 내용**: JSONB `metadata->'chunks'` 배열을 언팩하여 청크별 코사인 유사도를 계산하는 PostgreSQL 함수 작성. `/api/qna`의 RPC 파라미터 이름을 `p_department_id`로 맞춤.

---

## 🟠 높은 우선순위

### ~~TASK-001~~: `/api/users` POST 수정 ✅ 완료 (2026-04-21)
**파일**: `src/app/api/users/route.ts`, `src/lib/nextAuthOptions.ts`  
**완료**:
- ✅ `supabase` → `supabaseAdmin` 교체
- ✅ `session.user.department_id` → `departmentId` 로컬 변수 사용
- ✅ SHA-256 → bcryptjs (saltRounds: 12) 해싱으로 교체
- ✅ 로그인 시 bcrypt.compare 폴백 경로 추가 (Supabase Auth 실패 시 `users.password_hash` 검증)
- ⚠️ 구 SHA-256으로 저장된 계정은 bcrypt 해시 불일치로 로그인 불가 — 비밀번호 재설정 필요

### ~~TASK-002~~: `stats/route.ts` messages 쿼리 수정 ✅ 완료 (2026-04-21)

### ~~TASK-003~~: Admin 대시보드 통계 카드 실제 데이터 연결 ✅ 완료 (2026-04-21)
`QuickStats` 클라이언트 컴포넌트로 분리, `/api/stats`에 `totalUsers` 카운트 추가

### ~~TASK-004~~: 문서 목록 API 추가 ✅ 완료 (2026-04-21)
`GET /api/documents`, `DELETE /api/documents` 구현. `DocumentsManager`에서 목록 조회 + 삭제 지원

---

## 🟡 중간 우선순위

### ~~TASK-005~~: 직원 Q&A 페이지 구현 ✅ 완료 (2026-04-21)
`ChatInterface` 연결 완료. `'use client'` 디렉티브 추가.

### ~~TASK-006~~: 직원 보고서 페이지 구현 ✅ 완료 (2026-04-21)
`ReportWizard` 연결 완료.

### ~~TASK-007~~: 직원 히스토리 페이지 구현 ✅ 완료 (2026-04-21)
`ConversationHistory` 클라이언트 컴포넌트 구현. 날짜·비서명·첫 메시지 미리보기 표시, 클릭 시 전체 대화 내용 펼치기. `conversations` 목록 API에 `first_message` 필드 추가. `[id]` 라우트의 `conversation_messages` → `messages` 테이블명 수정.

### ~~TASK-008~~: 보고서 생성 결과 DB 저장 ✅ 완료 (2026-04-21)
`/api/report` POST에서 `usage_logs.details.report_content`에 보고서 내용 저장 후 `saved_id` 반환. `GET /api/reports` (목록 조회), `PATCH /api/reports/[id]` (편집 저장) 추가. `ReportViewer` 저장 버튼 연결 및 저장 상태 표시.

### ~~TASK-009~~: 직원 대시보드 실제 내용 추가 ✅ 완료 (2026-04-21)
`GET /api/employee/stats` 신규 생성 (사용한 비서 목록·최근 대화 3개·이번 달 사용 횟수). `EmployeeDashboard` 클라이언트 컴포넌트 구현. 요약 카드 3개 + 비서 목록 + 최근 대화 + 빠른 접근 링크.

### ~~TASK-010~~: Claude 모델 버전 업그레이드 ✅ 완료 (2026-04-21)
`claude-3-sonnet-20240229` → `claude-sonnet-4-6` 교체

### ~~TASK-011~~: RAG 구현 통일 ✅ 완료 (2026-04-21)
`supabase/migrations/0004_search_agent_chunks.sql` 생성 (agent_id 기반 pgvector RPC). `rag.ts`를 in-memory 코사인 유사도 제거 후 `search_agent_chunks` RPC 호출로 전면 교체. `/api/qna`의 죽은 `cosineSimilarity` 코드 제거, `supabase` anon → `supabaseAdmin` 교체, 세션 `departmentId` 직접 사용으로 DB 조회 제거. TASK-019도 이 작업으로 동시 해결.
⚠️ Supabase 대시보드에서 `0004_search_agent_chunks.sql` 실행 필요

---

## 🟢 낮은 우선순위 / 개선사항

### TASK-012: 사용자 초대 이메일 구현
**파일**: `src/app/api/users/route.ts:114`  
**현재**: `// TODO: 초대 이메일 발송` 주석만 있음  
**수정**: Supabase `auth.admin.inviteUserByEmail()` 또는 외부 이메일 서비스 (SendGrid, Resend 등)

### ~~TASK-013~~: 문서 삭제 기능 ✅ 완료 (2026-04-21)
`DELETE /api/documents` 구현 (Storage + DB 동시 삭제). TASK-004와 통합.

### ~~TASK-014~~: `supabaseClient.ts` 중복 제거 ✅ 완료 (2026-04-21)
`supabaseClient.ts`는 `export { supabase } from '@/lib/supabase'` 한 줄 재수출 파일이었으며 실제 import 없음 확인 후 삭제. `supabase.ts`와 `supabaseAdmin.ts`에 역할 주석 추가.

### ~~TASK-015~~: `openai.ts` 제거 ✅ 완료 (2026-04-21)
`src/lib/openai.ts` 스텁 삭제. `config.ts`에서 `OPENAI_API_KEY` export 제거.

### ~~TASK-016~~: TypeScript 타입 캐스팅 개선 ✅ 완료 (2026-04-21)
`(session.user as any).departmentId` → `session.user.departmentId` 전체 교체 (API 라우트 11개 + Navigation + nextAuthOptions). 미사용 import·미사용 `request` 파라미터(`_request` 명명) 정리.

### TASK-017: 페이지네이션 추가
**현재**: 대화 목록, 사용자 목록, 로그 등이 전체 조회  
**수정**: cursor 기반 또는 offset 기반 페이지네이션 추가

### TASK-018: 에러 추적 설정 (Sentry)
**현재**: `console.error()`만 사용  
**수정**: Sentry SDK 설치 및 `instrumentation.ts` 설정

### ~~TASK-019~~: 성능 — pgvector 네이티브 검색 전환 ✅ TASK-011에서 해결

### TASK-020: 보고서 내보내기 (PDF/DOCX)
**현재**: 보고서가 텍스트로만 반환됨  
**수정**: PDF 또는 DOCX 다운로드 기능 추가 (`puppeteer` 또는 `docx` 라이브러리)

---

## 가장 시급한 3가지 수정 순서

1. **BUG-002 + BUG-001** (security_logs 테이블 추가 + upload 변수 순서 수정)  
   → 문서 업로드와 채팅 기능 안정화

2. **BUG-003** (search_document_chunks RPC 추가)  
   → Q&A 기능 활성화

3. **TASK-005 + TASK-006** (직원 Q&A + 보고서 페이지에 기존 컴포넌트 연결)  
   → 실제 사용 가능한 MVP 완성

---

## 다음 마일스톤: MVP 완성 체크리스트

- [x] BUG-001: upload departmentId 순서 수정
- [x] BUG-002: security_logs 테이블 마이그레이션
- [x] BUG-003: search_document_chunks RPC 함수 추가
- [x] TypeScript 오류 19개 수정 + 빌드 성공 (tsc 0 errors, npm run build ✓)
- [ ] TASK-001: /api/users POST 수정 (비밀번호 해싱 보안 강화 — supabaseAdmin 전환은 완료)
- [x] TASK-002: stats messages 쿼리 수정 (conversations INNER JOIN으로 department_id 필터링)
- [ ] TASK-003: 관리자 대시보드 통계 카드 실데이터 연결
- [ ] TASK-004: GET /api/documents 추가
- [ ] TASK-005: 직원 Q&A 페이지 ChatInterface 연결
- [ ] TASK-006: 직원 보고서 페이지 ReportWizard 연결
- [x] TASK-010: Claude 모델 버전 업그레이드 (claude-3-sonnet-20240229 → claude-sonnet-4-6)
