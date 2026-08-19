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
| 기관 관리자 | `/api/upload`, `/api/documents/*`, `/api/users`, `/api/departments/*`, `/api/admin/audit-logs`, `/api/templates/*`, `/api/forbidden-words/*`, `/api/security-logs`, `/api/stats`, `/api/rag-test`, `/api/admin/**` | NextAuth 세션 + `isAdminSession()` | |
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
| 0014 | `departments.parent_id` (부서 계층) + 기관 단위 유일성 + `organization_id` NOT NULL |
| 0015 | `department_ancestors` RPC + `search_document_chunks` 상위 부서 확장 |
| 0016 | `agents`·`documents`에 `visibility` + `organization_id` (기관 전체 공개가 기본) |
| 0017 | `contracts.billing_type` 연간 정액 계약 + `organization_spend_krw` RPC |

**0014에 대한 주의**: `departments.organization_id`가 NOT NULL이 됐고 유일성
기준이 `(organization_id, slug)` / `(organization_id, name)`로 바뀌었습니다.
부서를 만들거나 찾을 때 **반드시 `organization_id`로 한정**하세요. 이름만으로
조회하면 타 기관의 동명 부서('총무과')가 잡혀 크로스 테넌트 접근이 생깁니다.
하위 부서 전체가 필요하면 `department_descendants(uuid)` RPC를 쓰세요.

**0013에 대한 주의**: `/api/chat`이 `agents.enabled_connectors`를 select 하므로
**코드 배포 전에 반드시 이 마이그레이션을 적용**해야 합니다. 컬럼이 없으면
에이전트 조회가 실패해 채팅 전체가 동작하지 않습니다.

**0012에 대한 주의**: `usage_logs.organization_id`는 애플리케이션 코드가 아니라
BEFORE INSERT 트리거가 `department_id`로부터 유도합니다.

**컬럼만 있고 트리거가 없는 상태가 실제로 있었습니다** (2026-08-19 발견).
그러면 대화는 정상이고 오류도 안 나는데, 새로 쌓이는 로그가 전부
`organization_id` NULL이 되어 **기관 사용량 집계와 예산 소진 판정에서 조용히
빠집니다** — 쓴 만큼 청구되지 않고 한도도 걸리지 않습니다.
0022가 트리거를 복구하고 재백필합니다.

`npm run db:check`가 이 증상을 봅니다. PostgREST로는 `pg_trigger`를 못 보므로,
**부서에는 `organization_id`가 있는데 로그만 NULL인 경우**를 트리거 부재로
판정합니다.
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
파일 업로드 → extractText (pdf-parse / mammoth / hwp.ts / spreadsheet.ts)
→ [PDF에 텍스트 레이어가 없으면 Claude로 스캔 판독 → pdf-ocr.ts]
→ chunkText (800단어, 100 겹침)
→ getEmbeddings (Voyage AI voyage-3) → DB 저장 (metadata JSONB에 chunks 배열)
```

**스캔 PDF는 Claude가 직접 읽습니다** (`src/lib/pdf-ocr.ts`).
공공기관은 옛 공문·결재문서·붙임이 스캔본인 경우가 많은데, 텍스트 레이어가
없으면 pdf-parse가 빈 문자열을 주고 업로드가 거부돼 그 자료를 아예 못 썼습니다.

- **이미지로 렌더링하지 않습니다.** Anthropic API가 PDF를 `document` 블록으로
  직접 받습니다. 렌더링 방식은 pdfium/poppler 바이너리가 필요해 Vercel에서 부담입니다
- **새 업체를 붙이지 않습니다.** Anthropic은 이미 필수 의존이라 OCR 업체나
  멀티모달 임베딩 업체를 늘리지 않고 해결됩니다. 공공기관 보안성 검토에서
  문서 본문이 나가는 곳이 하나 늘고 마는 차이가 큽니다
- 판정 기준은 **페이지당 글자 수**(50자 미만). 전체 길이만 보면 표지만 텍스트고
  본문이 스캔인 문서를 놓칩니다
- 상한 100쪽 / 30MB (Anthropic `document` 블록 제한)
- 페이지당 대략 1,500~3,000 토큰을 씁니다. **`/api/upload`에 한도 검사와
  `usage_logs` 기록(`action='document_ocr'`)이 들어 있습니다**
- 판독을 거치면 업로드 응답에 그 사실을 알립니다. 원문과 다르게 읽혔을 수 있어
  담당자가 확인할 근거가 됩니다

**표 문서(XLSX·CSV)도 마크다운 표로 복원합니다** (`src/lib/spreadsheet.ts`).
공공기관 업무의 상당량이 표입니다 — 예산서, 집행내역, 통계표.

- 수식 셀은 **계산 결과**를 씁니다. `=SUM(...)`을 색인해도 검색에 안 걸립니다
- 숨긴 시트는 제외합니다 (대개 계산용 보조 자료)
- CSV는 UTF-8로 읽어 깨지면 **EUC-KR로 재시도**합니다. 공공기관 CSV는 EUC-KR이 흔합니다
- **한 시트에 표가 여러 개 쌓여 있으면 나눕니다** (빈 행 2줄 이상이 경계).
  공공기관 엑셀에 흔한 형태인데, 이어붙이면 머리글이 표 한가운데 끼어들어
  어느 표의 값인지 알 수 없게 됩니다
- 전부 빈 열은 떼어냅니다. 서식만 넣은 여백 열이 자주 남습니다
- 시트당 500행 상한. 수만 행을 통째로 임베딩하면 비용이 감당되지 않습니다
- `exceljs`는 무거워 표 문서를 올릴 때만 동적으로 불러옵니다

### 기본 비서 세트 (P3-2)

기관을 등록하면 `src/lib/agent-presets.ts`의 세트가 기본 부서에 깔립니다
(`installPresetAgents`). **정의는 그 파일 한 곳에만 둡니다** — 스크립트가
목록을 따로 들고 있으면 한쪽만 바뀌어 기관마다 다른 세트를 받습니다.

`npm run seed:agents`는 이 기능 이전에 만들어진 기관을 메우는 용도입니다.
여러 번 돌려도 같은 이름은 건너뜁니다.

**프리셋을 고쳤으면 `-- --update`로 기존 기관에도 반영하세요.** 건너뛰기만 하면
기관마다 다른 프롬프트를 쓰게 됩니다 — 실제로 두 기관의 같은 이름 비서가
서로 다른 길이의 프롬프트를 갖고 있었습니다(민원인 답변: 89자 vs 211자).

`--update`는 **`updated_by`가 비어 있는 비서만** 갱신합니다. 관리 화면의
수정·노출 토글이 모두 이 값을 남기므로, 관리자가 기관 사정에 맞춰 고쳐 둔
문구는 덮이지 않습니다. 건너뛴 비서는 이름을 출력해 이유를 알 수 있게 합니다.
노출 여부·공개 범위·정렬처럼 운영자가 조정하는 값도 건드리지 않습니다.

프리셋 비서는 `is_published=true`로 깔립니다. 관리자가 직접 만드는 비서가
'노출 대기중'에서 시작하는 것과 다릅니다 — 큐레이션한 세트라 바로 쓸 수 있어야 합니다.

### 채팅 시 (`/api/chat`) — SSE 스트리밍
```
질문 → 기관 상태·월 토큰 한도 확인 (usage-limit.ts, 초과 시 429)
→ 직전 대화 이력 최대 20개 조회 (멀티턴 문맥)
→ getEmbeddings → search_agent_chunks RPC (threshold 0.25, top-5)
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
| `tool_limit` | `{ rounds }` | 툴 라운드 상한 도달 |
| `done` | `{ usage, title }` | 저장 완료 후 |

스트림 시작 **전** 실패(인증·권한·한도 초과 등)는 기존대로 JSON `{ ok: false }`로 반환됩니다.
클라이언트는 `content-type`으로 둘을 구분합니다 (`ChatInterface.tsx` 참조).

### Q&A 시 (`/api/qna`)
```
질문 → getEmbeddings → supabase.rpc('search_document_chunks') → Claude 응답 생성
```

**유사도 임계값은 실측으로 정합니다.** 한때 0.72였는데 그 값으로는 **어떤 문서도
통과한 적이 없었습니다.** voyage-3의 한국어 유사도 분포를 실측한 결과
(2026-08-19, 공문 HWP 1건):

| 구분 | 유사도 |
|---|---|
| 관련 질문 | 0.41 ~ 0.49 |
| 무관 질문 (요리·코딩·날씨) | 0.02 ~ 0.11 |

임계값은 "관련도 하한"이 아니라 **"아무것도 관련 없을 때 빈 결과를 주기 위한
바닥"**입니다. 순위 선별은 top-k(`MATCH_COUNT`)가 합니다. 바꿀 때는 감이 아니라
관련/무관 질문을 각각 몇 개 측정해 분리 구간을 확인하세요 (`src/lib/rag.ts`).

**검색 결과가 없으면 모델에게 그 사실을 알려야 합니다.** 예전에는 빈 결과일 때
프롬프트에 아무것도 넣지 않아서, 모델이 문서가 있다는 것조차 모른 채 일반
지식으로 그럴듯하게 답했습니다. 공공기관에서는 근거 없는 답이 근거 있는 답처럼
보이는 것이 가장 위험합니다. `/api/chat`은 세 경우를 구분합니다:

| 상황 | 프롬프트 |
|---|---|
| 청크 찾음 | 참고 자료로 붙임 |
| 문서는 있는데 못 찾음 | `[문서 검색 결과 없음]` + 근거 없음을 밝히도록 지시 |
| 연결된 문서 자체가 없음 | 비서 프롬프트만 |

**RAG가 두 갈래인 이유**: `/api/chat`은 에이전트에 연결된 문서만(`search_agent_chunks`),
`/api/qna`는 부서 전체 문서(`search_document_chunks`)를 검색합니다. 의도된 분리입니다.

**표 처리**: HWP 문서의 표는 마크다운 표로 복원해 인덱싱합니다.
셀을 순서대로 이어붙이면 열 머리글과 값의 대응이 끊겨 "A사의 B항목?" 같은
질문에 엉뚱한 열을 답하게 됩니다. 상세 구조는 `hwp.ts`의 `renderTable` 참조.

**툴 실행 루프**: 스트리밍 중 `stop_reason='tool_use'`가 오면 툴을 실행하고
`tool_result`를 붙여 다시 호출합니다. 라운드 상한(`MAX_TOOL_ROUNDS`)에 걸리면
**도구 정의는 유지한 채 `tool_choice='none'`으로 한 번 더 호출해 답변을
마무리**합니다. `tools`를 빼면 이력의 `tool_use`/`tool_result` 블록 때문에 Anthropic이 **400으로 거부**합니다. 그냥 루프를 끝내면 마지막 툴 결과를 모델에 돌려주지 못해
사용자가 도입부만 받고 답을 못 받습니다. 이때 `tools`를 통째로 빼면 이력의
`tool_use` 블록 때문에 빈 응답이 오므로 반드시 `tool_choice`를 쓰세요. `tool_use`의 인자는 `input_json_delta`로
잘게 쪼개져 오므로 블록 인덱스별로 모았다가 `content_block_stop`에서 파싱합니다
(`claude.ts`). 토큰 사용량은 라운드별로 누적합니다.

**Supabase 배치 삽입 주의**: PostgREST는 여러 행을 한 번에 넣을 때 모든 행의
컬럼을 **합집합**으로 맞추고, 그 컬럼이 없는 행에는 **명시적 NULL**을 넣습니다.
컬럼에 기본값이 있어도 우회되므로 NOT NULL이면 배치 전체가 23502로 실패합니다.

실제로 `/api/chat`이 사용자 행에만 `source_references`를 빠뜨려 **대화 메시지가
한 건도 저장되지 않았습니다.** 답변은 이미 스트리밍된 뒤라 화면은 정상이고,
새로고침해야 사라진 것을 압니다. `.insert([...])`를 쓸 때는 **모든 행이 같은
키 집합을 갖는지** 확인하세요 (`tests/message-persistence.test.ts`가 봅니다).

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

0. **부서를 '추측해서' 배정하지 말 것**
   소속을 알 수 없을 때 임의의 부서(예: 가장 오래된 부서)를 배정하면 타 기관
   자료에 접근하게 됩니다. 실제로 `signup`·`chat`·`bulk-register` 세 곳에
   있었고 2026-08-18에 제거했습니다. 소속을 특정할 수 없으면 **거부**하세요.

1. **RLS 미사용 — 테넌트 격리가 애플리케이션 코드에 의존**
   마이그레이션 어디에도 `ROW LEVEL SECURITY` 설정이 없습니다.
   격리는 각 라우트의 `.eq('department_id', ...)` 필터와 `visibilityFilter()`에
   달려 있으며, 라우트 하나만 빠뜨려도 타 기관 데이터가 노출됩니다.
   → 신규 라우트 작성 시 department_id 필터를 반드시 확인할 것.

   **RLS를 켜도 이 구조에서는 실효가 거의 없습니다.** 앱이 전부
   `supabaseAdmin`(service role)으로 접근하는데 service role은 RLS를
   우회합니다. 실제 위험은 "라우트가 필터를 빠뜨리는 것"이고, 그건 정책이
   아니라 실측으로 잡아야 합니다.

   `npm run isolation:check`가 기관이 둘 이상일 때 실제 DB에서 확인합니다 —
   부서 범위 함수 3종이 기관 경계를 넘는지, `visibilityFilter`로 조회했을 때
   타 기관 자료가 섞이는지, 부서와 자료의 기관이 어긋나는지.
   격리를 일부러 깨뜨려 실제로 잡히는 것까지 확인했습니다.

2. **테스트 부분 도입** (2026-08-19)
   `npm test`로 순수 함수 회귀 테스트 44개가 돕니다 (`tests/`).
   대상은 "동작하는가"가 아니라 **"조용히 틀리지 않는가"**입니다 — 이 프로젝트에서
   실제로 난 버그는 전부 오류 없이 결과만 틀리는 종류였습니다.

   | 파일 | 고정한 것 |
   |---|---|
   | `model-policy.test.ts` | 정책 밖 모델 대체, **과거 정산 소급 방지** |
   | `agent-catalog.test.ts` | 링크형 `javascript:`·`data:` 차단, 유형 전환 시 주소 처리 |
   | `spreadsheet.test.ts` | 열 머리글 대응, 수식→결과값, BOM·파이프 |
   | `pdf-ocr.test.ts` | 스캔 판정, **RAG 임계값이 실측 분리 구간 안에 있는지** |

   변이 테스트로 실제로 무는지 확인했습니다 — 임계값을 0.72로 되돌리면 실패합니다.

   **아직 없는 것**: DB를 거치는 경로(테넌트 격리, 관리 범위, 트리거)와 API 라우트.
   그쪽은 `npm run db:check`·`npm run connector:probe`가 실측으로 봅니다.

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

### 공개 범위 — 기관 전체가 기본

**부서 종속은 기본값이 아닙니다.** 공공기관 규정 대부분(복무·여비·문서관리·
정보공개·행동강령)은 전 직원 공통이라, 부서로 나누면 오히려 못 찾습니다.
게다가 정기 인사이동 때마다 부서 트리와 자료 배치를 다시 손봐야 합니다.

| `visibility` | 동작 | 용도 |
|---|---|---|
| `organization` **(기본)** | 같은 기관 전 직원 | 규정, 공통 매뉴얼, 공문 서식 |
| `department` | 지정 부서 + 하위 부서 | 인사·감사·법무 자료 |

조회는 `visibilityFilter(scope)`가 만드는 `.or()` 조건을 씁니다.
**부서 조건에도 `organization_id`를 함께 겁니다** — `department_id`만 보면,
트리거가 빠져 기관이 어긋난 행이 부서 조건으로 걸려 기관을 넘습니다
(0022에서 실제로 트리거가 없던 적이 있습니다).
`organization_id`가 NULL인 행은 이 조건에서 빠져 아무에게도 안 보입니다 —
보이는 쪽으로 여는 것보다 안전하고, 그런 행은 `npm run db:check`가 잡습니다.
`organization_id`는 `department_id`에서 트리거(0016)가 채우므로 insert 시
직접 넣을 필요가 없습니다.

**0016 마이그레이션은 기존 행을 `department`로 백필합니다.** 기본값을 그대로
적용하면 부서 전용이던 자료가 갑자기 기관 전체에 공개되기 때문입니다.

### 비서 카탈로그 — 표시와 권한을 섞지 말 것

비서에는 성격이 다른 축이 넷 있습니다. 섞으면 어느 쪽이 이기는지를 매번
판단해야 하므로 분리해서 씁니다 (마이그레이션 0019).

| 컬럼 | 뜻 | 성격 |
|---|---|---|
| `visibility` | 누가 볼 수 있는가 | **권한** |
| `category` | 어디에 묶여 보이는가 | 표시 |
| `is_published` | 지금 목록에 내보내는가 | 표시 |
| `is_active` | 쓸 수 있는가 (끄면 기존 대화도 불가) | 상태 |

**카테고리에 권한을 얹지 마세요.** 웍스AI는 카테고리 단위로만 공유하는데,
그건 비서 단위 통제가 없어서입니다. 우리는 `visibility`가 이미 있으므로
카테고리를 권한으로 쓰면 "카테고리는 공개인데 비서는 비공개" 같은 모순
상태가 생깁니다. 권한의 근거는 `visibility` 하나입니다.

`is_published`와 `approval_status`도 다른 축입니다.
`approval_status`는 "직원이 올린 것을 받아줄 것인가",
`is_published`는 "지금 직원 화면에 내보낼 것인가"입니다. 관리자가 비서를
만들어 두고 공개 전에 직접 써 보는 단계가 후자입니다.
새 비서의 기본값은 `false`(노출 대기중)입니다.

관리 화면은 `/api/agents?manage=true`로 조회해야 노출 대기중까지 내려옵니다.
직원 화면은 이 파라미터를 붙이지 않습니다.

`agent_categories`는 기관별 표시 분류입니다. `agents.category`는 FK가 아니라
이름(text)이라, 카테고리 이름을 바꾸면 그 이름을 쓰던 비서를 **함께 갱신**해야
합니다(`/api/admin/agent-categories/[id]` PATCH). 삭제 시에는 비서를 지우지
않고 미분류로 떼어냅니다 — 분류를 정리하려다 비서가 사라지면 되돌릴 수 없습니다.

### 링크형 비서

`agent_type='link'`이면 대화하지 않고 `link_url`을 새 탭으로 엽니다.
기관이 이미 쓰는 그룹웨어·업무포털을 비서 목록에 함께 두기 위한 것입니다.

- `http`/`https`만 허용합니다. `javascript:`는 클릭 시 스크립트가 실행되고
  `data:`는 임의 문서를 띄울 수 있어, 관리자 계정 하나가 뚫리면 전 직원
  화면에 그대로 노출됩니다 (`agent-catalog.ts`의 `normalizeLinkUrl`)
- `window.open`에 `noopener`를 반드시 붙입니다. 빼면 열린 창이
  `window.opener`로 이 페이지를 조작할 수 있습니다
- DB CHECK 제약이 유형과 주소를 짝으로 강제합니다. 다만 검증은 애플리케이션에서
  먼저 해야 합니다 — 제약에만 맡기면 사용자가 `23514` 코드만 보게 됩니다

### 개인 비서의 커넥터 범위

커넥터를 쓸지는 관리자가 정한다는 설계를 개인 비서에서도 지킵니다.
직원은 **기관이 이미 쓰고 있는 커넥터**만 자기 비서에 켤 수 있습니다.
판정은 "내가 볼 수 있는 공식 비서 중 하나라도 그 커넥터를 켜 두었는가"
(`getPersonalConnectorIds`, `src/lib/connector-scope.ts`).

별도의 기관 단위 허용 목록을 두지 않은 이유는 관리자가 같은 결정을 두 곳에서
반복하게 되고, 둘이 어긋나면 어느 쪽이 맞는지 알 수 없기 때문입니다.
조회 실패 시에는 **아무것도 못 켜는 쪽으로 닫습니다** — 실패가 권한을 넓히면 안 됩니다.
화면 필터는 표시일 뿐이고 실제 제한은 `POST /api/agents/personal`에서 겁니다.

### 부서 계층 공유

`visibility='department'`일 때 상위 부서에 걸린 자료를 하위 부서가 함께 씁니다.
공공기관은 `기관 > 국/본부 > 과 > 팀`으로 위계가 깊습니다.

방향을 혼동하면 격리가 깨지므로 이름을 분명히 씁니다 (`src/lib/department-scope.ts`):

| 함수 | 의미 | 쓰는 곳 |
|---|---|---|
| `getVisibleDepartmentIds(D)` | D + **상위** 부서들 | D 소속 직원이 볼 수 있는 자료 범위 |
| `getSharedDepartmentIds(D)` | D + **하위** 부서들 | D에 공유하면 누가 보는지 |
| `getManagedDepartmentIds(D)` | D + **하위** 부서들 | 관리자가 관리할 수 있는 범위 |

**관리자 권한 범위는 자기 부서 + 하위 부서**입니다. 최상위 부서 소속 관리자는
기관 전체를, 과 단위 관리자는 자기 과 아래만 관리합니다.
직원·부서를 수정하는 라우트는 **대상과 목적지 양쪽**을 이 범위로 검사해야
합니다. 한쪽만 보면 범위 밖 직원을 끌어오거나 관리 밖 부서로 밀어낼 수 있습니다.

**최상위 부서 소속 관리자는 기관 전체를 관리합니다.** `getManagedDepartmentIds`가
자기 부서에 상위가 없으면 같은 기관의 부서 전체를 돌려줍니다. 하위만 돌려주면
최상위 부서가 둘 이상인 기관에서 아무도 기관 전체를 관리할 수 없습니다 —
조직도를 아직 세우지 않은 기관에서 바로 부딪힙니다. 기관 경계는 넘지 않습니다.

`getSharedDepartmentIds`(공유 영향 범위)는 이 규칙을 따르지 않습니다.
총무팀에 올린 자료가 기획팀에 보이면 안 되기 때문입니다. 두 함수는 이름만
다른 같은 계산이었지만 이제 실제로 갈라졌습니다.

사용자에게 보일 자료를 조회할 때는 `.eq('department_id', D)`가 아니라
`.in('department_id', await getVisibleDepartmentIds(D))`를 씁니다.
RPC 조회가 실패하면 **자기 부서만** 돌려줍니다 — 실패가 범위를 넓히면 안 됩니다.

부서 트리 관리는 `/admin/departments` (기관 관리자). 상위 부서를 바꿀 때
**자기 자신이나 하위 부서를 상위로 지정하면 거부**합니다. 허용하면 그 하위
부서들이 어떤 최상위에도 닿지 못하는 끊어진 고리가 되어 화면에서 사라지고
재귀 조회가 무한루프에 빠집니다.

### 그 밖의 쿼리

부서 계층과 무관한 쿼리(대화·사용로그 등)는 그대로:
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

**`DEFAULT_MODEL_ID`와 `LEGACY_PRICING_MODEL_ID`를 분리해 두었습니다.**
둘을 같이 쓰면 기본 모델을 바꾸는 순간 **과거 정산이 소급해서 달라집니다** —
2026-08 이전 로그에는 `details.model`이 없어 폴백 단가로 추정되기 때문입니다.
그 시기에 실제로 돌던 모델은 Sonnet 4.6이고, 그 사실은 앞으로 무엇을
기본으로 삼든 변하지 않습니다.

현재 등록된 모델 (2026-08-19):

| 모델 | 단가(입력/출력, $/1M) | 컨텍스트 | 용도 |
|---|---|---|---|
| `claude-sonnet-4-6` | 3 / 15 | 1M | **기본**. 일반 문서 작성·요약 |
| `claude-opus-5` | 5 / 25 | 1M | 법령 해석 등 틀리면 곤란한 일 |
| `claude-sonnet-5` | 3 / 15 | 1M | 같은 단가로 더 나은 품질 |
| `claude-haiku-4-5` | 1 / 5 | 200K | 음슴체 변환 등 단순 변환 |

모델 id에 **날짜 접미사를 붙이지 마세요** (`claude-sonnet-4-6-20251114` 같은 형태는 없습니다).

다른 프로바이더(OpenAI·Google)를 붙이려면 `src/lib/llm/` 어댑터 계층이
먼저 필요합니다. 커넥터가 MCP 표준 형식으로 툴을 정의하는 이유가 이것입니다.

환율은 `config.ts`의 `USD_KRW_RATE` (기본 1350, `USD_KRW_RATE` 환경변수로 조정).

**집계 경로가 둘이고 옛 로그를 다르게 셉니다.** 의도된 차이입니다.

| 경로 | 근거 | `cost_*` 없는 옛 로그 |
|---|---|---|
| 화면 표시 (JS `sumCostUsd`) | `details.cost_usd` | 기본 모델 단가로 **추정해 포함** |
| 예산 판정 (SQL `organization_spend_krw`) | `details.cost_krw` | **제외** (`AND details ? 'cost_krw'`) |

판정은 추정치로 서비스를 차단하지 않겠다는 뜻이라 이대로 둡니다.
대신 **새 라우트가 `cost_krw` 기록을 빠뜨리면 그 사용량은 예산 판정에서
조용히 0원이 되어 한도가 걸릴 수 없게 됩니다.** `npm run db:check`가
2026-08-01 이후 로그의 `cost_krw`·`model` 누락을 세므로 배포 후 한 번 돌리세요.

### 기관별 허용 모델 정책 (0021)

**모델을 늘리기 전에 정책을 먼저 넣었습니다.** 순서가 반대면 정책이 붙기까지
쌓인 사용 내역을 보안성 검토에서 설명할 수 없습니다. 공공기관은 "어떤 데이터가
어느 사업자에게 갔는지"를 전부 소명해야 합니다.

`organizations.allowed_models`(text[])가 기준입니다.

| 값 | 뜻 |
|---|---|
| `NULL` | 아직 정하지 않음 → **기본 모델만** |
| `['a','b']` | 그 둘만. 단 레지스트리에 없거나 꺼진 모델은 걸러냄 |
| `[]` | 저장하지 않습니다 — NULL로 되돌립니다 |

빈 배열을 그대로 두면 그 기관이 아무 대화도 못 하게 **잠깁니다**. 조회 실패
시에도 기본 모델로 닫습니다 — 실패가 범위를 넓히면 안 됩니다.

**토큰을 쓰는 라우트는 `resolveModelForDepartment()`를 거쳐야 합니다.**
각자 기관을 조회해 정책을 적용하면 한 곳만 빠뜨려도 그 경로가 정책 밖으로
샙니다. 현재 `/api/chat`·`/api/qna`·`/api/report`가 이 함수를 씁니다.

화면에서 거르는 것은 표시일 뿐이고 실제 제한은 서버에서 겁니다
(개인 비서 커넥터 범위와 같은 원칙).

변경 이력은 `model_policy_logs`에 남깁니다. 감사에서 "그 시점에 무엇이
허용돼 있었는가"를 실제로 묻는데, 현재 값만 보관하면 답할 수 없습니다.

### 한도는 계약 형태에 따라 갈립니다

| `contracts.billing_type` | 판정 기준 | 대상 |
|---|---|---|
| `pay_as_you_go` **(기본)** | 이번 달 **토큰** 합산 vs `organizations.monthly_token_limit` | 기존 민간 계약 |
| `annual_fixed` | 계약 기간 누적 **금액** vs `contracts.annual_budget_krw` | 공공기관 |

공공기관 예산은 전년도에 확정 금액으로 편성되므로 종량제와 맞지 않습니다.
연간 정액 계약은 `organization_spend_krw` RPC로 `usage_logs.details.cost_krw`를
합산해 판정합니다. `budget_alert_percent`(기본 80)를 넘으면 경고, 100%면 차단입니다.

토큰 기준은 모델이 늘면 "토큰 100만"의 의미가 모델마다 달라지는 약점이 있습니다.
금액 기준이 그 문제를 함께 해결하므로, 신규 계약은 `annual_fixed`를 권합니다.

---

## 외부 도구 연동 규약 (커넥터)

구현 위치: `src/lib/connectors/`

| 커넥터 | id | 도구 | 필요 키 |
|---|---|---|---|
| 국가법령정보 (법제처) | `law` | `law_search`, `law_get_content` | `LAW_API_OC` (기본 'test') |
| 국가통계포털 KOSIS | `kosis` | `kosis_search_tables`, `kosis_get_data` | `KOSIS_API_KEY` |
| 나라장터 (조달청) | `g2b` | `g2b_search_bids` | `G2B_API_KEY` |
| 전자공시 DART | `dart` | `dart_search_disclosures`, `dart_get_company` | `DART_API_KEY` |

키가 없는 커넥터는 `isConfigured()`가 false를 돌려 도구 목록에서 아예 빠집니다.

**판례 본문 조회는 기관 자체 `LAW_API_OC`가 있어야 열립니다.** 기본값 `test`로는
`lawService.do?target=prec`이 거부됩니다. 자체 OC면 `ID` 파라미터로 열리며
(`MST`는 빈 응답), 응답 봉투는 `PrecService`이고 본문에 `<br/>`가 섞여 옵니다.
거부되면 검색 결과의 공개 링크를 안내하도록 폴백합니다.

`npm run connector:probe`가 설정된 커넥터 전부를 검색 → 상세 조회까지 태웁니다.
판례 본문만 선택(SKIP 허용) 항목입니다 — 기본 OC 환경에서 실패가 정상이기 때문입니다.

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
(인증 실패는 제외) 커넥터에서 직접 `fetch`를 부르지 말고 이 헬퍼를 쓰세요.

**오류를 HTTP 상태가 아니라 본문에 싣는 API가 많고, 둘을 섞어 쓰기도 합니다.**
- KOSIS: HTTP 200 + `{ err, errMsg }`
- DART: HTTP 200 + `{ status: '010', message }`
- 나라장터: **HTTP 403 + 본문에 `OpenAPI_ServiceResponse.cmmMsgHeader`**

그래서 `fetchJson`은 2xx가 아니어도 본문이 JSON이면 그대로 돌려주고, 오류
판별은 각 커넥터가 자기 API 규약대로 합니다. 상태 코드만 보고 본문을 버리면
원인을 알 수 없는 "HTTP 403"만 남습니다.

**나라장터 경로의 `ad/` 접두사 주의**: 공공데이터포털 문서에는 End Point가
`1230000/BidPublicInfoService`로 적혀 있지만 실제로는 `1230000/ad/...`라야
동작합니다. 접두사가 없으면 `NO_OPENAPI_SERVICE_ERROR`가 납니다.
(data.go.kr에서 경로 오류는 `NO_OPENAPI_SERVICE_ERROR`, 키 오류는
`SERVICE_KEY_IS_NOT_REGISTERED_ERROR`로 구분됩니다.)

---

## 기관 브랜딩 (0020)

멀티테넌트인데 화면 이름이 `NEXT_PUBLIC_APP_NAME` 전역 단일값이었습니다.
공공기관은 CI 사용이 규정 사항이라 "우리 기관 시스템"으로 보여야 합니다.

| 항목 | 저장 | 화면 |
|---|---|---|
| 기관명 | `organizations.name` | 헤더, 로그인 |
| 로고 | `organizations.logo_url` = **스토리지 경로** | `/api/branding/logo?org=` |
| 로그인 경로 | `organizations.slug` | `/signin/{slug}` |
| AI 고지 | `organizations.ai_notice` (NULL이면 기본) | 대화 화면 하단 |

**`logo_url`은 URL이 아니라 스토리지 경로입니다.** `documents` 버킷이
비공개라 공개 URL이 없고 서명 URL은 만료됩니다. 로고를 위해 공개 버킷을
따로 만들면 운영자가 관리할 것이 하나 늘어납니다.

`/api/branding/logo`는 `org`를 **UUID로만** 받고, DB에 적힌 경로가 정말
`branding/{orgId}/`로 시작하는지 다시 확인합니다. 자유 텍스트 컬럼이라
잘못된 값이 들어 있으면 경로를 거슬러 올라가 다른 파일을 요청할 수 있습니다.

**`/api/branding`은 인증 없이 열립니다.** 기관 전용 로그인 화면이 로그인
전에 기관명과 로고를 그려야 하기 때문입니다. 기관명·로고는 기관 홈페이지에도
있는 공개 정보입니다. **도메인·연락처·한도는 절대 싣지 마세요.**

없는 slug는 404가 아니라 기본 브랜딩으로 떨어집니다. 404를 주면 어떤 기관이
등록돼 있는지 확인하는 통로가 됩니다.

로그인 폼은 `components/auth/LoginForm.tsx` 한 벌이고 `/login`과
`/signin/{slug}`가 공유합니다. 화면을 복제하면 한쪽만 고치게 됩니다.

## 예산·이용 현황 (기관 관리자)

`/admin/organization`에 예산 소진 현황이 있습니다. 0017에서 판정 로직만 넣고
보는 화면을 슈퍼관리자에만 뒀던 것을 메운 것입니다 — 공공기관은 분기별
집행률 보고가 있어 조회 편의가 아니라 업무 요건입니다.

판정은 `checkTokenLimit()`을 그대로 씁니다. 화면에서 다시 계산하면 실제
차단 기준과 어긋납니다.

`/admin/stats`의 이용통계는 **비서별·직원별·부서별** 축을 냅니다.
비서별은 `details.agent_id`가 있는 로그만 셉니다 — 문서 업로드·스캔 판독은
비서를 거치지 않아 묶을 대상이 아닙니다. **집계 화면에는 질문 원문을 싣지
않습니다.** 개별 내역이 필요하면 사용 내역 조회를 씁니다.

## 감사 대응 (공공기관)

공공기관은 감사·정보공개 청구가 들어오면 "특정 기간, 특정 직원의 AI 사용
내역"을 제출해야 합니다. `/admin/audit` 화면과 `GET /api/admin/audit-logs`가
이를 담당합니다.

- 조회 범위는 **관리 범위(자기 부서 + 하위)**로 한정. 범위 밖 직원 지정은 403
- `kind=usage`(사용 내역) / `kind=security`(보안 이벤트)
- `format=csv`면 기간 전체를 내보냅니다 (화면 페이지가 아니라 전체). 최대 5만 건
- 시간은 **KST 기준**으로 표기합니다 — 감사 자료는 한국 시간으로 제출합니다
- 활동 코드는 한국어로 변환합니다 (`chat_message` → `AI 대화`)

**직원 질문 원문은 기본적으로 가립니다.** `/api/qna`가 `details.query`에
질문을 저장하는데(`/api/chat`은 저장하지 않습니다), 그걸 감사 화면에 그대로
띄우면 상시 근로자 감시가 됩니다. 감사 CSV는 정보공개 청구로 기관 밖에
나갈 수도 있습니다.

| | 동작 |
|---|---|
| 기본 | 앞 12자만 + `(전문 비공개)` |
| 열람 | `?reveal=true&reason=...` — **사유 5자 이상 필수** |
| 기록 | `security_logs`에 `query_revealed`(severity high)로 남김 |

저장 자체를 막지 않는 이유는, 실제 감사에서 "무엇을 물었는지" 제출 요구가
오면 없는 자료는 만들 수 없기 때문입니다. **수집은 하되 열람을 통제합니다.**
사유 없이 통과시키면 기록만 남고 사실상 상시 열람이 되므로 거절합니다.

**CSV에는 반드시 UTF-8 BOM(`﻿`)을 붙이세요.** 없으면 Excel에서 한글이 깨집니다.
기존 클라이언트 측 내보내기(`super/logs`, `super/usage`)도 같은 방식입니다.

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
