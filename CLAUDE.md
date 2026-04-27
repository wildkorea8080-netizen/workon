# CLAUDE.md — WORKON 개발 가이드

**최종 업데이트**: 2026-04-27  
**분석 기준**: 실제 코드베이스 + docs/ 문서 전체 반영

---

## 프로젝트 요약

WORKON은 부서(Department) 기반 멀티테넌트 SaaS 플랫폼입니다.  
내부 문서를 업로드·임베딩하고, AI 에이전트로 RAG 기반 Q&A를 제공하며, 템플릿으로 보고서를 생성합니다.

---

## 실제 스택 (현재 코드베이스 기준)

| 레이어 | 기술 |
|---|---|
| Frontend | Next.js 14 (App Router) + React 18 + TypeScript + Tailwind CSS |
| Auth | NextAuth.js 4 (Credentials) — Supabase Auth도 signup에서 일부 사용 |
| DB | Supabase PostgreSQL + pgvector (임베딩 저장) |
| 파일 저장 | Supabase Storage (`documents` 버킷) |
| AI/LLM | Claude API (`claude-3-sonnet-20240229`) |
| 임베딩 | Voyage AI (`voyage-3`) |
| 배포 | Vercel |
| 문서 파싱 | `pdf-parse`, `mammoth` (DOCX) |
| 차트 | Recharts |
| 마크다운 | react-markdown + react-syntax-highlighter |

> **주의**: `src/lib/openai.ts`는 스텁(stub)이며 실제로 사용되지 않습니다. 임베딩은 Voyage AI, 생성은 Claude를 사용합니다.

---

## 디렉토리 구조

```
src/
├── app/
│   ├── api/              # API 라우트
│   │   ├── agents/       # 에이전트 CRUD
│   │   ├── chat/         # RAG 채팅 (POST)
│   │   ├── conversations/ # 대화 관리
│   │   ├── forbidden-words/ # 금지어 관리
│   │   ├── qna/          # 부서 전체 문서 Q&A (pgvector RPC 사용)
│   │   ├── rag-test/     # RAG 테스트용
│   │   ├── report/       # 보고서 생성/템플릿 목록
│   │   ├── security-logs/ # 보안 로그 조회
│   │   ├── signup/       # 회원가입
│   │   ├── stats/        # 통계
│   │   ├── templates/    # 보고서 템플릿 CRUD
│   │   ├── upload/       # 문서 업로드+처리
│   │   └── users/        # 사용자 관리
│   ├── admin/            # 관리자 페이지 (대부분 구현됨)
│   ├── employee/         # 직원 페이지 ⚠️ 대부분 플레이스홀더
│   ├── login/ signin/ signup/ # 인증 페이지
│   └── report/           # 독립 보고서 페이지
├── components/
│   ├── admin/            # 관리자 UI (실제 구현됨)
│   ├── chat/             # 채팅 UI (실제 구현됨)
│   └── report/           # 보고서 UI (구현됨, but 직원 페이지에 미연결)
├── lib/
│   ├── auth.ts           # getServerAuthSession, isAdminSession
│   ├── claude.ts         # Claude API 래퍼 (raw fetch)
│   ├── config.ts         # 환경 변수 관리
│   ├── db.ts             # 타입 정의 전체
│   ├── document-processor.ts # PDF/DOCX/TXT 파싱 + 청킹 + 임베딩
│   ├── embeddings.ts     # Voyage AI 래퍼
│   ├── filter.ts         # 금지어 + 개인정보 패턴 필터
│   ├── forbidden-words.ts # 금지어 DB 조회
│   ├── openai.ts         # ⚠️ 스텁 — 실제로 사용 안 함
│   ├── rag.ts            # RAG 검색 로직 (in-memory 코사인 유사도)
│   ├── supabase.ts       # 클라이언트 Supabase (anon key)
│   ├── supabaseAdmin.ts  # 서버 Supabase (service role key)
│   └── supabaseClient.ts # 추가 클라이언트 (중복 주의)
└── middleware.ts         # NextAuth 미들웨어
```

---

## API 엔드포인트 목록

| 메서드 | 경로 | 설명 | 권한 |
|---|---|---|---|
| POST | `/api/signup` | 회원가입 (Supabase Auth) | 공개 |
| GET | `/api/agents` | 부서 에이전트 목록 | 인증 |
| POST | `/api/agents` | 에이전트 생성 | ADMIN |
| GET/PUT/DELETE | `/api/agents/[id]` | 에이전트 CRUD | ADMIN (수정/삭제) |
| POST | `/api/chat` | RAG 채팅 응답 | 인증 |
| GET | `/api/conversations` | 대화 목록 | 인증 |
| POST | `/api/conversations` | 새 대화 생성 | 인증 |
| GET/PUT/DELETE | `/api/conversations/[id]` | 대화 상세/수정/삭제 | 인증 |
| GET | `/api/forbidden-words` | 금지어 목록 | ADMIN |
| POST | `/api/forbidden-words` | 금지어 추가 | ADMIN |
| DELETE | `/api/forbidden-words/[id]` | 금지어 삭제 | ADMIN |
| POST | `/api/qna` | 부서 전체 문서 Q&A | 인증 |
| GET | `/api/rag-test` | RAG 디버그 테스트 | ADMIN |
| GET | `/api/report` | 템플릿 목록 조회 | 인증 |
| POST | `/api/report` | 보고서 생성 | 인증 |
| GET | `/api/security-logs` | 보안 로그 조회 | ADMIN |
| GET | `/api/stats` | 대시보드 통계 | 인증 |
| GET | `/api/templates` | 보고서 템플릿 목록 | 인증 |
| POST | `/api/templates` | 템플릿 생성 | ADMIN |
| GET/PUT/DELETE | `/api/templates/[id]` | 템플릿 CRUD | ADMIN (수정/삭제) |
| POST | `/api/upload` | 문서 업로드+처리+임베딩 | ADMIN |
| GET | `/api/users` | 부서 사용자 목록 | ADMIN |
| POST | `/api/users` | 사용자 초대 | ADMIN |

---

## 데이터베이스 스키마 (실제 구현)

`supabase/migrations/0001_init.sql` 기준:

- `departments` — 부서(테넌트) 루트
- `users` — 사용자 (department_id FK)
- `agents` — AI 에이전트 (department_id FK)
- `documents` — 문서 메타데이터 + JSONB 청크+임베딩 + `embedding vector(1024)`
- `conversations` — 대화 세션
- `messages` — 채팅 메시지
- `report_templates` — 보고서 템플릿
- `forbidden_words` — 부서별 금지어
- `usage_logs` — 사용 로그

**⚠️ 마이그레이션에 누락된 DB 객체:**
- `security_logs` 테이블 — `filter.ts`와 `/api/security-logs`에서 참조하지만 없음
- `search_document_chunks` RPC 함수 — `/api/qna`에서 `supabase.rpc()`로 호출하지만 없음
- `messages` 테이블에 `department_id` 컬럼 없음 — `stats/route.ts`가 이 컬럼으로 쿼리

---

## 인증 흐름

NextAuth.js Credentials 방식:
```
사용자 로그인 → NextAuth → Supabase Auth 검증 → 세션에 {id, role, departmentId} 포함
```

세션 타입 확장: `src/types/next-auth.d.ts`

서버 측 인증 패턴:
```typescript
const session = await getServerAuthSession();
if (!session?.user?.id) return 401;
if (session.user.role !== 'ADMIN') return 403;
const departmentId = (session.user as any).departmentId; // 타입 캐스팅 필요
```

**주의**: `departmentId`가 세션에 없는 경우 DB에서 재조회하는 로직이 라우트마다 다르게 구현되어 있습니다.

---

## RAG 파이프라인

### 문서 업로드 시
```
파일 업로드 → extractText (pdf-parse/mammoth) → chunkText (800단어, 100 겹침)
→ getEmbeddings (Voyage AI voyage-3) → DB 저장 (metadata JSONB에 chunks 배열)
```

### 채팅 시 (`/api/chat`)
```
질문 → getEmbeddings → in-memory 코사인 유사도 계산 (rag.ts)
→ 상위 5개 청크 → Claude 프롬프트 조립 → 응답 반환
```

### Q&A 시 (`/api/qna`)
```
질문 → getEmbeddings → supabase.rpc('search_document_chunks') [⚠️ 함수 없음]
→ Claude 응답 생성
```

**두 RAG 구현이 서로 다릅니다**: `/api/chat`은 in-memory 방식, `/api/qna`는 pgvector RPC 방식. 통일 필요.

---

## 환경 변수

```bash
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
NEXTAUTH_URL=
NEXTAUTH_SECRET=
VOYAGE_API_KEY=
ANTHROPIC_API_KEY=
OPENAI_API_KEY=         # 설정해도 실제로 사용 안 됨 (스텁)
NEXT_PUBLIC_SUPABASE_DOCUMENTS_BUCKET=documents  # 기본값
NEXT_PUBLIC_APP_NAME=WORKON                        # 기본값
```

---

## 현재 알려진 버그 (작업 전 반드시 확인)

### 🔴 크리티컬 (런타임 크래시)

1. **`upload/route.ts` 변수 선언 순서 오류** (`src/app/api/upload/route.ts:81,97`)
   `logSecurityEvent(departmentId, ...)` 호출이 `departmentId` 변수 할당보다 먼저 나옴
   → 위험 파일명/확장자 감지 시 `ReferenceError` 발생

2. **`security_logs` 테이블 미존재**
   `filter.ts`의 `logSecurityEvent()`가 마이그레이션에 없는 테이블에 INSERT 시도
   → 금지어 감지 시 DB 오류 발생

3. **`search_document_chunks` RPC 미존재**
   `/api/qna`가 `supabase.rpc('search_document_chunks', ...)` 호출
   → QnA API 항상 500 에러

### 🟠 주요 버그

4. **`/api/users` POST 컴파일 에러** (`src/app/api/users/route.ts:77`)
   `supabase` 임포트 없이 사용 (`supabaseAdmin` 사용해야 함), `session.user.department_id` 참조 오류

5. **`stats/route.ts` 잘못된 쿼리** (`src/app/api/stats/route.ts:47`)
   `messages` 테이블에 `department_id` 컬럼이 없음

6. **Admin 대시보드 통계 카드가 하드코딩 "--"** (`src/app/admin/page.tsx`)
   `StatsDashboard` 컴포넌트가 실제 `/api/stats`를 호출하지 않음

### 🟡 미완성

7. **직원 페이지 전체가 플레이스홀더**
   `/employee/qna`, `/employee/reports`, `/employee/history` — 내용 없음

8. **문서 목록 API 없음**
   `DocumentsManager`가 문서 목록을 로드 못함 (`GET /api/documents` 라우트 없음)

9. **사용자 초대 이메일 미구현**
   `// TODO: 초대 이메일 발송` 주석만 있음

---

## 코딩 규칙

- 한국어 에러 메시지: `{ ok: false, error: { message: '...' } }`
- 서버 전용 DB: `supabaseAdmin` (service role), 클라이언트: `supabase` (anon key)
- 모든 DB 쿼리에 `department_id` 필터 필수 (테넌트 격리)
- 서버 API 응답: `{ ok: true, data: T }` 또는 `{ ok: false, error: {...} }`
- 환경변수 직접 접근 금지 → `src/lib/config.ts` 경유
- 관리자 전용 API: `isAdminSession(session)` 확인 필수

---

## 멀티테넌트 격리 원칙

모든 DB 쿼리에서 반드시:
```typescript
.eq('department_id', departmentId)
```

`departmentId` 소스 우선순위:
1. `(session.user as any).departmentId` — NextAuth 세션에 있으면 사용
2. DB에서 재조회: `supabaseAdmin.from('users').select('department_id').eq('id', session.user.id)`

---

## Claude 모델 업그레이드

현재 `claude.ts`에서 `claude-sonnet-4-6` 사용 중.

---

## 슈퍼관리자 포털 (STEP 1~12, 2026-04-27 완료)

### 경로 구조

```
/super/login          슈퍼관리자 전용 로그인 (NextAuth와 완전 분리)
/super                대시보드 (전체 현황 + 차트)
/super/organizations  기관 관리 (CRUD + 대리 접근)
/super/accounts       계정 관리 (전체 사용자 + 슈퍼관리자)
/super/api-keys       API 키 관리 (시스템 + 기관별)
/super/usage          사용량 모니터링 (실시간 + 차트 + 알림)
/super/contracts      계약/과금 관리 (계약 + 매출 + 요금제)
/super/notices        공지사항 관리
/super/settings       시스템 설정 (기본 + 점검모드 + 보안)
/super/logs           로그 관리 (접속 + 시스템 + 대리접근)
/maintenance          점검 모드 안내 페이지
```

### 인증 방식

- **쿠키**: `super_token` (httpOnly, 24시간)
- **JWT**: HMAC-SHA256, `SUPER_JWT_SECRET` 서명
- **미들웨어**: Edge Runtime에서 Web Crypto API로 검증 (30초 캐시)

### 신규 환경변수

```bash
SUPER_ADMIN_SETUP_KEY=   # 최초 슈퍼관리자 계정 생성 키
SUPER_JWT_SECRET=        # 슈퍼관리자 JWT 서명 비밀키 (32바이트)
ENCRYPTION_KEY=          # API 키 AES-256 암호화 키 (64자 hex)
```

### 신규 DB 테이블

| 테이블 | 용도 |
|---|---|
| `contracts` | 기관별 계약 (플랜/기간/요금) |
| `api_keys` | 기관/시스템 API 키 암호화 저장 |
| `billing_logs` | 월별 과금 집계 |
| `super_admin_logs` | 슈퍼관리자 조작 감사 로그 |
| `impersonation_logs` | 대리 접근 이력 |
| `notices` | 공지사항 |
| `notice_reads` | 공지 읽음 처리 |
| `system_settings` | 서비스 설정값 (key-value) |
| `access_logs` | 접속 로그 |
| `system_logs` | 시스템 이벤트 로그 |

### organizations 테이블 추가 컬럼

`status`, `plan`, `domain`, `contact_*`, `max_users`, `max_agents`, `monthly_token_limit`

### departments 테이블 추가 컬럼

`organization_id` FK (기관↔부서 계층 연결)

### users 테이블 추가 컬럼

`is_super_admin`, `is_active`

### 대리 접근 (Impersonation)

`next-auth/jwt encode()`로 임시 admin 세션 생성 → 기존 admin 코드 무수정 재사용.
세션에 `isImpersonating: true` 포함 → admin layout에서 노란 배너 표시.

---

## 구현 완료 기능 (2026-04-27 기준)

### 슈퍼관리자 포털 (/super) — STEP 1~12
- ✅ 대시보드: 실시간 현황 카드, 30일 라인차트, 플랜 도넛차트, Top5 기관, 알림 배너
- ✅ 기관 관리: CRUD + 슬라이드 패널 등록 + 상세(5탭) + 기관 정지/활성화
- ✅ 대리 접근(Impersonation): next-auth/jwt 임시 세션 + 노란 배너 + 복귀
- ✅ 계정 관리: 전체 사용자 + 슈퍼관리자 추가/비활성화 + 비밀번호 변경
- ✅ API 키 관리: 시스템 키 AES-256 암호화 저장/검증 + 기관별 키 현황
- ✅ 사용량 모니터링: 기간 필터, 실시간 카드, 차트, 한도 경보, CSV 내보내기
- ✅ 계약/과금: 계약 CRUD, 갱신 모달, 만료 예정, 월별 매출 차트, 요금제 설정
- ✅ 공지사항: 작성(마크다운)/발행/수정/삭제 + 기관 배너 + 읽음 처리
- ✅ 시스템 설정: 기본값 인라인 수정, 점검 모드 토글(미들웨어 30초 캐시), 보안
- ✅ 로그 관리: 접속로그(의심IP 감지) + 시스템로그(JSON 상세) + 대리접근 이력

### 기관 관리자 포털 (/admin) — BM-01~13
- ✅ 비서 관리: 공식/승인대기/반려 3탭, 승인 처리
- ✅ 문서 업로드: PDF/DOCX/TXT 파싱 + Voyage AI 임베딩
- ✅ 사용자 관리: 초대 링크 + CSV 일괄 등록 + 임시 비밀번호
- ✅ 사용량 통계, 보안 설정(금지어)

### 직원 포털 (/) — BM-04~13
- ✅ 비서 선택 + 카테고리 탭 + 즐겨찾기
- ✅ RAG 기반 채팅 + 대화 자동 제목 생성
- ✅ 나만의 비서 만들기 (이모지, 파일 업로드, 프롬프트 다듬기)
- ✅ 공식 비서 등록 신청 → 관리자 승인 플로우
- ✅ 대화 공유/수정/삭제
- ✅ 내 사용현황 (/my/stats): recharts 라인차트 + 비서별 통계

### 공공기관 특화
- ✅ 정부 파란색 디자인 시스템 (#003087 기반)
- ✅ 공공기관 특화 비서 8개 seed 데이터 (음슴체변환, 공문, 보고서, 회의록 등)
- ✅ Pretendard 폰트
