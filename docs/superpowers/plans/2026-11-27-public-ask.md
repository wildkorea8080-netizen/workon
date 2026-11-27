# 시민용 민원 상담 창 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 로그인 없이 `/ask/{slug}`에서 기관의 시민 전용 비서에게 묻고, 그 비서 문서만 근거로 답을 받는다. 기관 홈페이지에 `/ask/embed.js`로 붙인다.

**Architecture:** 시민 전용 비서는 `agents.tier = 'public'`(새 값 — 직원 목록은 tier로 거르므로 저절로 빠지고, 권한 함수는 직원 사용을 거절·고치기는 기관 전체 관리자만). 설정·기록은 새 표 둘(0136). 답은 직원 실행기 대신 `prepareLikeChat` → `streamChat` → `checkNumbers` → 기록 → 사용 기록(`public_ask`)의 가벼운 길(`src/lib/public-ask/`). 하루 횟수는 DB 함수 하나가 기관마다 잠그고 세고 넣는다.

**Spec:** `docs/superpowers/specs/2026-11-27-public-ask-design.md`

## Global Constraints
- IP 하루 기본 20(1~100), 기관 하루 기본 500(1~5,000), 한국 날짜. 기록 30일. 안내 문구 500자, 자주 묻는 질문 5개×60자, 부서 연락처 10개(이름 40·전화 30·안내 100자), 허용 홈페이지 https 도메인 5개. 질문 500자(넘으면 400), 저장 질문 1,000자·답 8,000자.
- 확인 못 하면 닫힘(설정·횟수·기관 한도·금지어 읽기 실패 → 503 '잠시 뒤 다시').
- 개인정보·마감으로 거절된 시도는 질문 글 없이 기록, IP 상한엔 모든 시도·기관 상한엔 모델 부른 것만.
- 공개 응답에 비서 id·문서 id·경로·근거 원문 없음 — 근거는 제목·위치만.
- 사용 기록 `public_ask`는 기관 예산에 들고 `department_spend_krw`에서는 뺀다. 시민 길 한도 판정은 기관 단위만.
- 새 표 RLS 켜고 정책 없음·공개 키 권한 없음. 공개 라우트는 `route-auth.test.ts` 목록에 이유와 함께.
- 직원 화면·기관 API 동작은 그대로.

## Review Focus
- 시민 전용 비서가 직원 비서 목록·즐겨찾기·앱 목록·대화(`canUseAgent`)·기관 API(`writableAgent`)에 나오지 않는다.
- 꺼진 기관·없는 slug·정지/종료 기관·비서 없음/문서 없음 → 닫힘(404 또는 '운영하지 않음'), 다른 기관 비서로 넘어가지 않음.
- 같은 IP 21번째·기관 501번째 → 모델을 부르지 않고 마감.
- 주민번호가 든 질문 → 거절·기록에 질문 글 없음.
- `/ask/*` 응답에는 `X-Frame-Options: DENY`가 없고 `frame-ancestors`는 허용 도메인만, 다른 화면은 DENY 그대로.

---

### Task 1: 마이그레이션 0136
**Files:** Create `supabase/migrations/0136_public_ask.sql`; Test `tests/batch-0344.test.ts`
- `agents_tier_check`를 `('personal','department','official','public')`로, 기관마다 지우지 않은 public 비서 하나(부분 유일 색인 `(organization_id) WHERE tier='public' AND deleted_at IS NULL`).
- `public_ask_settings`(organization_id PK FK, enabled bool, enabled_at, enabled_reason(1~300, 켜졌을 때만), agent_id FK agents ON DELETE SET NULL, notice text ≤500, faq text[] ≤5, contacts jsonb 배열 ≤10, allowed_origins text[] ≤5, ip_daily_cap 1~100 기본 20, org_daily_cap 1~5000 기본 500, updated_at, updated_by).
- `public_ask_logs`(id, organization_id FK, created_at, ip_hash text(64 hex), question text NULL ≤1000, answer text NULL ≤8000, sources text[], result CHECK in ('answered','no_source','rejected_pii','capped_ip','capped_org','unavailable'), model text, input_tokens int, output_tokens int) + 색인 (organization_id, created_at), (organization_id, ip_hash, created_at).
- 함수 `public_ask_claim(p_org uuid, p_ip_hash text, p_day_start timestamptz, p_ip_cap int, p_org_cap int)` → text: advisory xact lock(기관) 아래 오늘 그 IP의 모든 행 수 ≥ cap이면 'capped_ip', 오늘 기관의 모델 부른 행(answered·no_source) 수 ≥ cap이면 'capped_org', 아니면 'ok'. 실행 권한 service_role만.
- `department_spend_krw` 다시 정의 — `AND action <> 'public_ask'`.
- RLS 켬, 공개 키 권한 없음. 시험: 시험 DB(`WORK_TEST_DATABASE_URL`)에서 CHECK·유일 색인·claim 판정·department_spend 제외를 본다(DB 없으면 건너뜀).

### Task 2: tier 'public' 연결
**Files:** `src/lib/agent-permissions.ts`(AgentTier에 'public' — canUseAgent false, canEditAgent/canDeleteAgent는 같은 기관·`managesWholeOrganization`만), `src/lib/db.ts`·`agent-form.ts`·`rag-eval-tools.ts`의 tier 꼴, 직원 목록 쿼리 중 tier로 거르지 않는 곳에 `.neq('tier','public')`, 기관 API `writableAgent` 거절, 프리셋 갱신·관리자 비서 화면 제외. Test: `tests/batch-0344.test.ts`(권한 함수·소스 검사 — `src/app/api/agents/route.ts` 등 목록이 public을 내지 않음).

### Task 3: 시민 상담 엔진
**Files:** Create `src/lib/public-ask/spec.ts`(잎 — 상한·`parsePublicAskSettings`·결과 코드·공개 꼴), `src/lib/public-ask/service.ts`(`loadPublicAsk(slug)`, `askPublic({ slug, question, previousQuestion, ip }, deps)` → 이벤트 비동기 열), Route `src/app/api/ask/[slug]/route.ts`(GET 공개 설정, POST SSE `start`·`delta`·`done{sources,numberCheck,contacts?}`·`error`), `api-route-ids.ts`·`route-auth.test.ts` 공개 목록. Test `tests/batch-0345.test.ts`(가짜 deps로: 꺼짐·없음·마감·개인정보 거절 기록 글 없음·근거 없음 안내·성공 기록·사용 기록 `public_ask`·확인 못 하면 503).

### Task 4: 시민 화면·붙이기
**Files:** `src/app/ask/[slug]/page.tsx`(+ client 부품 `src/components/public-ask/PublicAskChat.tsx`), `src/app/ask/embed.js/route.ts`(스크립트), `vercel.json`(DENY를 `/ask` 밖에만), `src/middleware.ts`(`/ask`·`/api/ask`는 로그인·IP·세션 검사 건너뜀, 점검 모드는 그대로), 화면 응답 `frame-ancestors`. Test `tests/batch-0346.test.ts`(소스·머리글).

### Task 5: 관리자 '시민 상담'
**Files:** `src/app/api/admin/public-ask/route.ts`(GET 설정·비서·주소·붙일 코드 / PUT 설정 — 기관 전체 관리자·대리 접근 403·보안 로그), `.../agent/route.ts`(POST 시민 전용 비서 만들기 — 이름·지시문 기본값), `.../logs/route.ts`(GET 최근 기록 — 기간·근거 없음만), 화면 `src/app/admin/public-ask/page.tsx` + `src/components/admin/PublicAskPanel.tsx`(문서는 기존 `DocumentsPanel` 재사용), `AdminNav` 메뉴. Test `tests/batch-0347.test.ts`.

### Task 6: 30일 정리·문서
5분 실행기(`/api/cron/app-schedules`)에 지난 기록 지우기(한 번 1,000행). CLAUDE.md 표 한 줄·마이그레이션 표 0136·`docs/benchmarks/allganize/PUBLIC_ASK.md`. 전체 시험·tsc.
