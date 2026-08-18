# CLAUDE.md — WORKON 개발 가이드

**최종 업데이트**: 2026-08-18  
**분석 기준**: 코드베이스 전수 확인 (`next build` + `tsc --noEmit` 통과 상태에서 검증)

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
| AI/LLM | Claude API (`claude-sonnet-4-6`) — 논스트리밍 + SSE 스트리밍 양쪽 지원 |
| 임베딩 | Voyage AI (`voyage-3`) |
| 메일 | Resend REST API (선택 — 미설정 시 링크 수동 전달로 폴백) |
| 배포 | Vercel |
| 문서 파싱 | `pdf-parse`, `mammoth` (DOCX), 자체 HWP/HWPX 추출기 (`hwp.ts`) |
| 차트 | Recharts |
| 마크다운 | react-markdown + react-syntax-highlighter |

> 외부 API는 SDK 없이 `fetch`로 직접 호출하는 것이 이 코드베이스의 관례입니다 (`claude.ts`, `embeddings.ts`, `mailer.ts`).

---

## 디렉토리 구조

```
src/
├── app/
│   ├── api/              # API 라우트 78개 (아래 "API 구조" 참조)
│   ├── admin/            # 기관 관리자 포털
│   ├── super/            # 슈퍼관리자 포털 (독립 인증)
│   ├── employee/         # 직원 서브페이지 (reports/history/qna)
│   ├── my/stats/         # 내 사용현황
│   ├── shared/[token]/   # 대화 공개 공유 페이지 (비인증)
│   ├── login/ signin/ signup/ register/  # 인증 페이지
│   ├── maintenance/      # 점검 모드 안내
│   └── page.tsx          # 직원 메인 (비서 선택 + 채팅)
├── components/
│   ├── admin/   chat/   super/   employee/   report/   layout/
├── lib/
│   ├── auth.ts           # getServerAuthSession, isAdminSession
│   ├── nextAuthOptions.ts # NextAuth 설정
│   ├── super-auth.ts     # 슈퍼관리자 JWT (NextAuth와 별개)
│   ├── claude.ts         # Claude API — callClaudeAPI + streamClaudeAPI
│   ├── config.ts         # 환경 변수 (직접 process.env 접근 금지)
│   ├── crypto.ts         # API 키 AES-256 암복호화
│   ├── db.ts             # 타입 정의 전체
│   ├── document-processor.ts # PDF/DOCX/TXT 파싱 + 청킹 + 임베딩
│   ├── embeddings.ts     # Voyage AI 래퍼
│   ├── filter.ts         # 금지어 + 개인정보 패턴 필터
│   ├── connectors/       # 공공 데이터 커넥터 (MCP 형식 툴 정의)
│   ├── forbidden-words.ts # 금지어 DB 조회
│   ├── hwp.ts            # HWP 5.0 / HWPX 텍스트 추출 + 표 복원 (자체 구현)
│   ├── mailer.ts         # Resend 메일 발송 (미설정 시 폴백)
│   ├── plans.ts          # 요금제 정의
│   ├── rag.ts            # pgvector RPC 검색 (search_agent_chunks)
│   ├── usage-limit.ts    # 기관 상태 + 월 토큰 한도 검사
│   ├── logger.ts
│   ├── supabase.ts       # 클라이언트 Supabase (anon key)
│   └── supabaseAdmin.ts  # 서버 Supabase (service role key)
└── middleware.ts         # NextAuth + 슈퍼관리자 + 점검 모드
```

---

## API 구조 (78개 라우트)

라우트가 많아 개별 나열 대신 그룹과 인증 방식만 정리합니다.
정확한 목록은 `src/app/api/` 디렉토리를 직접 확인하세요.

| 그룹 | 경로 | 인증 방식 | 비고 |
|---|---|---|---|
| 공개 | `/api/signup`, `/api/register`, `/api/shared/[token]` | 없음 | 초대 토큰 검증만 |
| 직원 | `/api/chat`, `/api/conversations/*`, `/api/agents`, `/api/agents/personal/*`, `/api/agents/favorite`, `/api/my/stats`, `/api/employee/stats`, `/api/qna`, `/api/reports/*`, `/api/notices/*` | NextAuth 세션 | `department_id` 필터 필수 |
| 기관 관리자 | `/api/upload`, `/api/documents/*`, `/api/users`, `/api/templates/*`, `/api/forbidden-words/*`, `/api/security-logs`, `/api/stats`, `/api/rag-test`, `/api/admin/**` | NextAuth 세션 + `isAdminSession()` | |
| 슈퍼관리자 | `/api/super/**` (34개) | `super_token` 쿠키 JWT (`getSuperAdminFromRequest`) | NextAuth와 완전 분리 |
| 시스템 | `/api/system/maintenance` | 없음 | 점검 모드 상태 조회 |

**관리자 전용 라우트를 추가할 때는 GET/POST/PUT/DELETE 각 핸들러마다
`isAdminSession(session)` 검사를 넣어야 합니다.** 한 핸들러에만 넣고 다른
핸들러를 빠뜨리는 실수가 실제로 있었습니다 (`forbidden-words` POST, 2026-08 수정).

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

마이그레이션 0002~0012에서 추가된 것:

| 마이그레이션 | 내용 |
|---|---|
| 0002 | `security_logs` 테이블 |
| 0003 | `search_document_chunks` RPC (부서 전체 검색) |
| 0004 | `search_agent_chunks` RPC (에이전트 단위 검색) |
| 0005 | 벤치마킹 기능 컬럼 (category, is_personal, favorites, share_token, approval_status) + `invitations`, `organizations` |
| 0006 | 슈퍼관리자 시스템 (contracts, api_keys, billing_logs, super_admin_logs 등) |
| 0007~0011 | impersonation, is_active, 시스템 API 키, 공지, 로그 |
| 0012 | `usage_logs.organization_id` 자동 채움 트리거 |
| 0013 | `agents.enabled_connectors` (에이전트별 외부 도구 설정) |

**0013에 대한 주의**: `/api/chat`이 `agents.enabled_connectors`를 select 하므로
**코드 배포 전에 반드시 이 마이그레이션을 적용**해야 합니다. 컬럼이 없으면
에이전트 조회가 실패해 채팅 전체가 동작하지 않습니다.

**0012에 대한 주의**: `usage_logs.organization_id`는 애플리케이션 코드가 아니라
BEFORE INSERT 트리거가 `department_id`로부터 유도합니다.
insert 시 이 컬럼을 직접 넣을 필요가 없고, `department_id`만 정확히 넣으면 됩니다.

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
파일 업로드 → extractText (pdf-parse / mammoth / hwp.ts) → chunkText (800단어, 100 겹침)
→ getEmbeddings (Voyage AI voyage-3) → DB 저장 (metadata JSONB에 chunks 배열)
```

### 채팅 시 (`/api/chat`) — SSE 스트리밍
```
질문 → 기관 상태·월 토큰 한도 확인 (usage-limit.ts, 초과 시 429)
→ 직전 대화 이력 최대 20개 조회 (멀티턴 문맥)
→ getEmbeddings → search_agent_chunks RPC (threshold 0.72, top-5)
→ Claude 스트리밍 호출 → SSE로 즉시 전달
→ 스트림 종료 후 messages + usage_logs 저장
```

**응답 형식**: `/api/chat`은 JSON이 아니라 `text/event-stream`을 반환합니다.

| 이벤트 | 페이로드 | 시점 |
|---|---|---|
| `meta` | `{ conversation_id, chunks }` | 스트림 시작 직후 |
| `delta` | `{ text }` | 텍스트 조각마다 |
| `error` | `{ message }` | 생성 중 오류 |
| `tool_start` | `{ name, input }` | 도구 실행 직전 |
| `tool_end` | `{ name, ok, sources }` | 도구 실행 완료 |
| `done` | `{ usage, title }` | 저장 완료 후 |

스트림 시작 **전** 실패(인증·권한·한도 초과 등)는 기존대로 JSON `{ ok: false }`로 반환됩니다.
클라이언트는 `content-type`으로 둘을 구분합니다 (`ChatInterface.tsx` 참조).

### Q&A 시 (`/api/qna`)
```
질문 → getEmbeddings → supabase.rpc('search_document_chunks') → Claude 응답 생성
```

**RAG가 두 갈래인 이유**: `/api/chat`은 에이전트에 연결된 문서만(`search_agent_chunks`),
`/api/qna`는 부서 전체 문서(`search_document_chunks`)를 검색합니다. 의도된 분리입니다.

**표 처리**: HWP 문서의 표는 마크다운 표로 복원해 인덱싱합니다.
셀을 순서대로 이어붙이면 열 머리글과 값의 대응이 끊겨 "A사의 B항목?" 같은
질문에 엉뚱한 열을 답하게 됩니다. 상세 구조는 `hwp.ts`의 `renderTable` 참조.

**툴 실행 루프**: 스트리밍 중 `stop_reason='tool_use'`가 오면 툴을 실행하고
`tool_result`를 붙여 다시 호출합니다. `tool_use`의 인자는 `input_json_delta`로
잘게 쪼개져 오므로 블록 인덱스별로 모았다가 `content_block_stop`에서 파싱합니다
(`claude.ts`). 토큰 사용량은 라운드별로 누적합니다.

**출처 표기**: 응답 텍스트에 덧붙이지 않고 `messages.source_references`에 저장해
`SourceCitation`(문서 청크)과 `MessageBubble`의 링크 목록(도구 출처)이 렌더링합니다.
`source_references`는 `{ chunks: [...], links: [...] }` 구조입니다. 텍스트에 덧붙이면 DB 저장 내용과
화면 표시가 어긋나므로 이 방식을 유지하세요.

---

## 환경 변수

전체 목록은 `.env.example` 참조. 필수/선택 구분:

```bash
# 필수
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
NEXTAUTH_URL=
NEXTAUTH_SECRET=
VOYAGE_API_KEY=
ANTHROPIC_API_KEY=

# 슈퍼관리자 포털
SUPER_ADMIN_SETUP_KEY=
SUPER_JWT_SECRET=
ENCRYPTION_KEY=

# 선택 (기본값 있음)
NEXT_PUBLIC_SUPABASE_DOCUMENTS_BUCKET=documents
NEXT_PUBLIC_APP_NAME=WORKON
NEXT_PUBLIC_APP_URL=              # 미설정 시 NEXTAUTH_URL로 폴백

# 선택 (메일 발송) — 둘 다 있어야 자동 발송, 없으면 링크 수동 전달로 폴백
RESEND_API_KEY=
MAIL_FROM=
```

**환경변수는 반드시 `src/lib/config.ts`를 경유**해서 읽습니다. `process.env` 직접 접근 금지.

---

## 현재 알려진 제약 (작업 전 반드시 확인)

> 2026-08-18 전수 확인. 이전 버전 CLAUDE.md에 적혀 있던 "크리티컬 버그" 9건은
> 모두 해결된 상태였습니다 (문서만 갱신되지 않았음). 아래가 현재 실제 상태입니다.

### 🔴 구조적 위험

1. **RLS 미사용 — 테넌트 격리가 애플리케이션 코드에만 의존**
   마이그레이션 어디에도 `ROW LEVEL SECURITY` 설정이 없습니다.
   격리는 전적으로 각 라우트의 `.eq('department_id', ...)` 필터에 달려 있으며,
   라우트 하나만 빠뜨려도 타 기관 데이터가 노출됩니다.
   → 신규 라우트 작성 시 department_id 필터를 반드시 확인할 것.

2. **테스트 0개**
   회귀를 잡아줄 장치가 전혀 없습니다. 인증·테넌트 격리·RAG 검색은
   최소한의 테스트가 필요합니다.

### 🟠 기능 공백 (웍스AI 대비)

- 단일 모델 고정 (`claude-sonnet-4-6`) — 모델 선택·멀티 프로바이더 없음
- MCP / 툴 실행 루프 없음
- XLSX·PPTX 미지원, OCR·이미지 입력 없음 (HWP/HWPX는 2026-08 지원 시작)
- 회의록(STT)·번역·이미지/비디오 생성·PPT 생성 없음
- SSO, IP 제어 없음

상세 분석과 우선순위는 [docs/GAP_ANALYSIS_2026-08.md](docs/GAP_ANALYSIS_2026-08.md) 참조.

### 🟡 알려진 불일치

- **RAG 구현 2종 공존**: `/api/chat`은 `search_agent_chunks`(에이전트 단위),
  `/api/qna`는 `search_document_chunks`(부서 전체). 의도된 분리지만 통합 검토 필요.
- **과금 파이프라인 미완성**: `usage_logs`에 토큰은 정확히 쌓이지만
  원화 환산·`billing_logs` 월 집계·청구서 생성은 미구현.

---

## 코딩 규칙

- 한국어 에러 메시지: `{ ok: false, error: { message: '...' } }`
- 서버 전용 DB: `supabaseAdmin` (service role), 클라이언트: `supabase` (anon key)
- 모든 DB 쿼리에 `department_id` 필터 필수 (테넌트 격리)
- 서버 API 응답: `{ ok: true, data: T }` 또는 `{ ok: false, error: {...} }`
- 환경변수 직접 접근 금지 → `src/lib/config.ts` 경유
- 관리자 전용 API: **모든 핸들러마다** `isAdminSession(session)` 확인 필수
- 외부 API는 SDK 대신 `fetch`로 직접 호출 (기존 관례)
- `next.config.mjs`의 `ignoreBuildErrors`는 제거된 상태입니다.
  **타입 에러가 있으면 빌드가 실패합니다.** 다시 켜지 마세요.
  Supabase 행이 `any`로 추론되는 콜백은 인라인 타입을 명시하세요:
  `.map((c: { id: string }) => c.id)`

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

## 모델·단가 (확장 대비)

**단가는 `src/lib/models.ts`의 `MODELS` 레지스트리 한 곳에만 존재합니다.**
2026-08 이전에는 `(tokens/1M)*3 + (tokens/1M)*15`가 6개 라우트에 하드코딩돼
있었습니다. 다시 그렇게 하지 마세요. 모델 추가 = 레지스트리에 항목 하나 추가.

```typescript
import { estimateCostUsd, estimateCostKrw, sumCostUsd } from '@/lib/models';
```

### 토큰을 소비하는 라우트의 필수 규약

`usage_logs.details`에 **반드시** 아래를 함께 기록합니다:

```typescript
details: {
  model: usage.model,                              // 어떤 모델이 썼는지
  input_tokens: usage.input_tokens,
  output_tokens: usage.output_tokens,
  cost_usd: estimateCostUsd(usage, usage.model),   // 기록 시점 단가로 확정
  cost_krw: estimateCostKrw(usage, usage.model),
}
```

`model` 없이 토큰만 남기면 **모델을 추가하는 순간 과거 사용량을 어느 모델에
귀속시킬지 영원히 알 수 없게 됩니다.** 소급이 불가능하므로 지금부터 지킵니다.

`cost_usd`를 기록 시점에 확정해 두는 이유는 나중에 단가가 바뀌어도 과거 정산이
흔들리지 않게 하기 위해서입니다. 집계 시에는 `sumCostUsd(logs)`를 쓰세요 —
`cost_usd`가 있으면 그 값을, 없는 과거 로그(2026-08 이전)는 기본 모델 단가로
추정하는 폴백이 들어 있습니다.

환율은 `config.ts`의 `USD_KRW_RATE` (기본 1350, `USD_KRW_RATE` 환경변수로 조정).

### 한도는 아직 토큰 기준입니다

`organizations.monthly_token_limit`과 계약이 토큰 수 기준입니다.
모델이 하나뿐이라 현재는 문제가 없지만, **단가가 다른 모델을 추가하면
"토큰 100만"의 의미가 모델마다 달라집니다.** 그 시점에 `usage-limit.ts`를
비용 기준(`cost_krw` 합산)으로 바꿔야 하며, 이미 체결된 계약은 재협상 대상입니다.
비용 데이터는 지금부터 쌓이므로 전환 자체는 계산식 교체로 끝납니다.

---

## 외부 도구 연동 규약 (커넥터)

구현 위치: `src/lib/connectors/`

| 커넥터 | 상태 | 도구 |
|---|---|---|
| 국가법령정보 (법제처) | ✅ | `law_search`, `law_get_articles` |
| KOSIS / 나라장터 / DART | 미구현 | |

새 커넥터는 `Connector` 인터페이스를 구현하고 `connectors/index.ts`의
`CONNECTORS` 배열에 추가하면 끝입니다.

`/api/chat`에 툴 실행 루프가 있어 모델이 필요하다고 판단하면 호출합니다
(최대 `MAX_TOOL_ROUNDS`=4 왕복).

**도구는 에이전트별로 켜야 합니다.** `agents.enabled_connectors`(text[])에 든
커넥터의 툴만 노출됩니다. 기본값은 빈 배열 = 도구 미사용이며, 기관 관리자가
비서 수정 화면에서 켭니다. 툴 단위가 아니라 커넥터 단위인 이유는 관리자가
"국가법령정보를 쓸지"를 결정하지 "law_search를 쓸지"를 결정하지 않기 때문입니다.

만들 때 지킬 것:

**툴 정의는 MCP 표준 형식으로 작성합니다.** Anthropic tool-use 포맷에 직접
맞춰 짜면 나중에 다른 프로바이더의 function-calling으로 옮길 때 커넥터를
전부 다시 써야 합니다. MCP를 거치면 그 비용이 0입니다.

- 툴 스키마: MCP `tools/list` 형식 (name, description, inputSchema)
- 프로바이더별 변환은 `src/lib/llm/` 어댑터 계층의 책임 — 커넥터는 관여하지 않음
- 커넥터는 순수 함수여야 함: 입력 → 외부 API 호출 → 구조화된 결과 + 출처 URL
- 출처(원문 링크)를 반드시 반환할 것. 공공 데이터는 근거 제시가 요구사항입니다.

**국내 공공 API는 간헐적으로 실패합니다.** 동일 URL이 성공 → HTTP 404 →
타임아웃을 오가는 것을 실측했습니다. `fetchJson`이 3회까지 재시도하므로
커넥터에서 직접 `fetch`를 부르지 말고 이 헬퍼를 쓰세요.

남은 대상: KOSIS, 조달청 나라장터, 금감원 DART.

---

## 사용량 한도

`src/lib/usage-limit.ts`의 `checkTokenLimit(departmentId)`가
부서 → 기관 → 이번 달 `usage_logs` 합산 순으로 확인합니다.

- 기관 `status='suspended'` → 차단 (429)
- 이번 달 토큰 합산 ≥ `monthly_token_limit` → 차단 (429)
- 기관 미연결 부서, `monthly_token_limit=0`(무제한), 집계 실패 → **허용**
  (과금 집계 오류로 서비스가 멈추면 안 되므로 fail-open)

토큰을 소비하는 신규 라우트를 추가하면 이 검사를 함께 넣으세요.

> 확장 시 주의: 현재 매 요청마다 이번 달 로그를 합산합니다.
> 기관당 월 수만 건을 넘으면 일별 집계 테이블이나 RPC로 옮겨야 합니다.

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

---

## 2026-08-18 변경 (P0/P1)

품질·기반 작업. 상세 배경은 [docs/GAP_ANALYSIS_2026-08.md](docs/GAP_ANALYSIS_2026-08.md).

| 변경 | 내용 |
|---|---|
| **멀티턴 대화 복구** | `/api/chat`이 이전 대화 이력을 Claude에 전달하지 않아 문맥이 매번 초기화되던 문제 수정 (최대 20개) |
| **SSE 스트리밍** | `streamClaudeAPI()` 추가, `/api/chat`이 `text/event-stream` 반환, `ChatInterface`가 점진 렌더링 |
| **토큰 한도 차단** | `usage-limit.ts` 신설. 기관 정지·월 한도 초과 시 429 반환 (기존에는 경보만 있었음) |
| **usage_logs 집계 복구** | `organization_id`를 아무도 쓰지 않아 슈퍼관리자 사용량·과금 통계가 전부 0이던 문제를 마이그레이션 0012 트리거로 해결 |
| **메일 발송** | `mailer.ts` 신설 (Resend REST). 초대 링크·임시 비밀번호 자동 발송. 미설정 시 기존 수동 전달 방식으로 폴백 |
| **타입 안전성** | tsc 에러 61건 해소 후 `ignoreBuildErrors` 제거 |
| **권한 구멍 수정** | `POST /api/forbidden-words`에 누락됐던 `isAdminSession` 검사 추가 |
| **응답 규약 통일** | `forbidden-words`의 `success:` → `ok:` |
| **리포지토리 정리** | `disable-rls.js`·`test.exe` 등 제거/untrack, UTF-16으로 깨져 있던 `.gitignore`·`.env.example` 재작성, 루트 .md 15개를 `docs/`로 이동 |

> `.gitignore`와 `.env.example`이 UTF-16LE로 저장돼 패턴이 전부 무효였습니다
> (PowerShell `>>` 기본 인코딩). 파일 추가 시 UTF-8로 저장하세요.
