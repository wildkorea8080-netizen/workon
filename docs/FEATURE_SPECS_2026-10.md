# 기능 명세서 — 구축 대상 전체

**작성일**: 2026-10-14 · **기준 코드**: WORKON `e3c7905` · **상위 문서**: [`BUILD_PLAN_2026-10.md`](BUILD_PLAN_2026-10.md)

> 각 기능을 **구현 가능한 수준**으로 적는다 — 어느 표에 어떤 컬럼, 어느 라우트, 어느 화면, 무엇을 테스트로 고정하는지.
> 실제 코드 자리를 짚었다(표·RPC·라우트 이름). 추정한 곳은 「확인」이라고 표시했다.

---

## 공통 규약 — 모든 기능이 지킨다

| 규약 | 내용 | 근거 |
|---|---|---|
| 응답 | `{ ok: true, data }` / `{ ok: false, error: { message } }` 한국어 | CLAUDE.md |
| 인증 | 관리자 라우트는 **핸들러마다** `isAdminSession()`. `tests/route-auth.test.ts`가 전수 검사 | 금지어 사고 |
| 격리 | 모든 조회에 `organization_id`·`department_id` 필터. 관리 범위는 `getManagedDepartmentIds()` | 0014 |
| 토큰을 쓰면 | `checkTokenLimit(deptId, userId)` 먼저 · `usage_logs.details`에 `model·input_tokens·output_tokens·cost_usd·cost_krw` · `resolveModelForDepartment()` 경유 | `tests/usage-limit.test.ts`가 전수 검사 |
| 환경변수 | `config.ts` 경유. `process.env` 직접 접근 금지 | — |
| 외부 API | SDK 없이 `fetch`. 커넥터는 `fetchJson`(3회 재시도) | — |
| 화면 검사 | 표시일 뿐. **실제 제한은 서버** | 커넥터 범위·이미지·파일 상한 |
| 빈 값 | 「안 정함」은 `NULL`. 빈 배열·빈 문자열을 저장하지 않는다 | `allowed_models`·`allowed_ips` |
| 실패 방향 | 권한·범위는 **닫는다**, 과금 집계는 **연다** | CLAUDE.md |
| 테스트 | 동작보다 **「조용히 틀리지 않는가」**. 순수 함수 + 소스 전수 검사 | 이 프로젝트의 버그 전부가 조용한 종류 |
| 임베딩 | **Voyage에 새 의존을 만들지 않는다.** 임베딩·검색이 필요한 새 기능은 NODA(`/context`·`/search`)를 쓰거나 B1 뒤로 미룬다 | 2026-10-14 결정 |
| 마이그레이션 | 코드보다 **먼저** 적용. 새 컬럼을 select 하는 화면이 깨진다 | 0013·0023·0024 |

---

## A1. 업로드 결재

### 목적
문서가 **AI에 쓰이기 전에** 결재자가 승인한다. 공공기관은 자료 반출·공유에 결재가 붙는 조직이고,
웍스 드라이브의 「올리기 전에 결재받기」가 같은 자리다.

**「AI에 쓰이기 전」의 뜻을 정확히 둔다**: 승인 전 문서는 **검색에 안 걸리고, 파싱·임베딩도 하지 않는다.**
지금 파싱은 Voyage(미국)로 본문을 보내므로, 결재 전에 파싱하면 "승인 전에 이미 나갔다"가 된다.
Voyage는 B1에서 걷어낸다(사용 안 함 결정). 그 뒤로는 NODA 업로드가 이 자리다 — 승인 → NODA 업로드.
**그래서 승인 라우트는 `ingestDocument()` 하나만 부르게 짓는다.** B1이 그 함수 안만 바꾸면 결재 코드는 손대지 않는다.

### 역할
| 역할 | 할 수 있는 것 |
|---|---|
| 직원·관리자(올리는 사람) | 올린다 → `결재 대기`. 자기 문서의 상태를 본다 |
| 결재자 | 대기 목록 · 승인 · 반려(사유 필수) |
| 기관 관리자 | 기능 켜기/끄기 · 부서별 결재자 지정 |

**결재자 결정 순서** (웍스와 같은 3단계):
① 문서의 부서 `departments.approver_user_ids` → ② 기관 기본 `organizations.default_approver_user_ids` → ③ 기관의 관리자(`role='ADMIN'`) 전원.
결재자는 **관리자 역할이어야** 한다(라우트가 `/api/admin/*`이고 `route-auth`가 그걸 요구). 과장이 결재자면 과장을 관리자로 둔다.

### 데이터 — 0026
```sql
ALTER TABLE organizations
  ADD COLUMN upload_approval_required boolean NOT NULL DEFAULT false,
  ADD COLUMN default_approver_user_ids uuid[];
ALTER TABLE departments
  ADD COLUMN approver_user_ids uuid[];           -- NULL이면 위 ②③으로
ALTER TABLE documents
  ADD COLUMN approval_status text NOT NULL DEFAULT 'approved'
    CHECK (approval_status IN ('pending','approved','rejected')),
  ADD COLUMN approval_note text,
  ADD COLUMN approved_by uuid REFERENCES users(id),
  ADD COLUMN approved_at timestamptz;
CREATE INDEX ON documents(organization_id, approval_status);
```
기본값이 `'approved'`인 이유: 기존 행과 기능을 끄는 기관이 **아무 영향도 받지 않게**(0016이 기존 행을 백필한 것과 같은 판단).

**검색 RPC 둘을 재정의** (0026에서 `create or replace`):
- `search_agent_chunks` (0015 판): `where d.agent_id = p_agent_id` 뒤에 `and d.approval_status = 'approved'`
- `search_document_chunks` (0016 판): visibility 조건 뒤에 같은 줄
RPC에 넣는 이유: 애플리케이션 코드가 빠뜨려도 새지 않는다. 화면 필터는 표시일 뿐.

### 흐름
```
업로드 (/api/upload)
  기관 upload_approval_required = false → 지금과 같다 (파싱·임베딩·approved)
  = true  → Storage 저장만 · approval_status='pending' · metadata={} · 결재자에게 알림
승인 (POST /api/admin/documents/[id]/approve)
  → ingestDocument(doc) 실행 → 'approved' · approved_by/at
     (B1 전: 지금의 processDocumentFile — 파싱·임베딩 / B1 뒤: NODA /documents/upload + ACL 재생성)
  → 처리 실패 시 'pending' 유지 + approval_note에 까닭 (조용히 approved로 두지 않는다)
반려 (POST /api/admin/documents/[id]/reject { note })
  → 'rejected' · note 필수(5자 이상 — 질문 열람 사유와 같은 규칙) · Storage 파일은 보관(감사)
```
승인은 스캔 PDF면 수십 초가 걸린다. 라우트는 처리 완료 뒤 응답하고 화면은 「처리 중」을 보인다. Vercel 함수 제한에 걸리면 B-track의 비동기 방식을 앞당긴다(「확인」).

### API
| 메서드·경로 | 인증 | 하는 일 |
|---|---|---|
| `GET /api/admin/documents/approvals?status=pending` | 관리자 + 관리 범위 | 대기 목록(문서명·올린 사람·부서·올린 시각·크기). 범위 밖 부서 문서는 안 보임 |
| `POST /api/admin/documents/[id]/approve` | 관리자 + 관리 범위 + **결재자 목록에 있거나 목록이 비어 있음** | 위 흐름 |
| `POST /api/admin/documents/[id]/reject` | 같음 | `{ note }` 필수 |
| `PATCH /api/admin/organization` | 관리자 | `upload_approval_required`·`default_approver_user_ids` 추가 |
| `PATCH /api/departments/[id]` | 관리자 | `approver_user_ids` 추가. 관리 범위 안 사용자만 허용 |
| `GET /api/documents` | 직원·관리자 | 응답에 `approval_status`·`approval_note` 추가 |

`/api/chat`의 `hasDocuments` 판정(「문서는 있는데 못 찾음」 분기)은 **승인된 문서만** 센다 — 대기 문서만 있는 비서가 "검색 결과 없음"이 아니라 "문서 없음"으로 가야 모델이 헛근거를 말하지 않는다.

### 화면
- **기관 정보**: 「올리기 전에 결재받기」 토글 + 기본 결재자 선택(관리자 목록에서)
- **부서 관리** 수정 행: 결재자 선택(관리 범위 안 관리자)
- **관리자 → 결재함**(신규, AdminNav에 대기 건수 배지): 목록 · 승인 · 반려(사유 입력)
- **문서 관리 / 개인 비서 파일**: 상태 배지 `결재 대기` · `반려 — 사유` · 승인 전 문서는 흐리게
- **직원 대화 화면**: 대기 문서만 연결된 비서에 「결재 대기 중인 문서 N건 — 승인 뒤 답변에 쓰입니다」 한 줄

### 알림·기록
- 대기 발생 시 결재자에게 메일(`mailer.ts`, 미설정이면 생략) + 배지
- `logSecurityEvent`: `document_approval_requested`(low) · `document_approved`(low) · `document_rejected`(medium, note 포함). 감사 CSV의 활동 코드 한국어 표에 셋을 추가

### 테스트 (`tests/document-approval.test.ts`)
- 0026 SQL에 두 RPC 모두 `approval_status = 'approved'` 줄이 있다 (소스)
- `/api/upload`가 플래그를 읽고 `pending`일 때 `ingestDocument`를 **부르지 않는다** (소스: 분기 안에 호출이 없음)
- 승인 라우트가 `ingestDocument` 말고 처리 함수(`processDocumentFile`·`getEmbeddings`·NODA 클라이언트)를 직접 부르지 않는다 — B1 교체 지점을 하나로 지킨다
- approve·reject 라우트에 `isAdminSession` + `getManagedDepartmentIds` (`route-auth`가 자동으로도 봄)
- reject의 `note` 5자 미만 거부
- 결재자 결정 함수(`resolveApprovers`)는 순수 함수로 두고 ①②③ 순서를 고정
- `db:check`에 「pending인데 `metadata.chunks`가 있는 문서」 = 0건 항목 추가 (승인 전 파싱이 샌 증상)

### 범위 밖
폴더(하위 계층) 단위 결재자 — 우리는 부서가 폴더다. 다단계 결재(2인 이상 순차) — 요구가 오면.

---

## A2. 공공데이터 커넥터 6종

### 목적
웍스AI 공공데이터 10종 대비 우리 4종. 나머지 6종은 틀이 있어 각각 작다. 전부 **공식 DB를 직접 열어 출처와 함께** 답하는 같은 원칙.

### 공통 구현 틀
`src/lib/connectors/<id>.ts`가 `Connector` 구현(`id`·`label`·`tools[]`·`isConfigured()`·`execute()`) →
`connectors/index.ts`의 `CONNECTORS`에 추가 → `connector-labels.ts`에 이름 → `scripts/connector-probe.mjs`에 검색→상세 항목 → `.env.example`에 키.
키 없으면 `isConfigured()=false`로 조용히 빠지므로 **배포 뒤 `connector:probe` 실행**이 규약.
오류는 상태 코드가 아니라 본문에 실리는 API가 많다 — `fetchJson`을 쓰고 각 API 규약대로 판별(나라장터 교훈).

### 여섯 커넥터
| id | 이름 | 도구 | 입력 → 출처 | 키 |
|---|---|---|---|---|
| `ecos` | 한국은행 ECOS | `ecos_search_tables`(통계표 검색) · `ecos_get_series`(통계표코드·주기·기간) | 금리·환율·물가·GDP → `ecos.bok.or.kr` 통계표 링크 | `ECOS_API_KEY` (ecos.bok.or.kr) |
| `juso` | 도로명주소 | `juso_search`(건물명·지번 일부) | 도로명주소·우편번호 → `juso.go.kr` | `JUSO_API_KEY` (juso.go.kr confmKey) |
| `assembly` | 국회 의안정보 | `assembly_search_bills`(제목·발의자·대수) · `assembly_get_bill`(의안번호 → 심의 진행) | `likms.assembly.go.kr` 의안 상세 링크 | `ASSEMBLY_API_KEY` (열린국회정보 open.assembly.go.kr) — **엔드포인트 ID는 발급 시 확인** |
| `apt` | 공동주택 실거래가 | `apt_trades`(법정동코드·거래년월) | 단지·전용면적·거래금액·층 → 국토부 실거래가 공개시스템 링크 | `DATA_GO_KR_KEY` 공용 가능 (공공데이터포털 `RTMSDataSvcAptTradeDev`) |
| `worknet` | 고용·산재보험 사업장 | `insurance_lookup_workplace`(사업장명·사업자번호) | 상시 근로자 수·업종·보험료율 → 근로복지공단 | 공공데이터포털 근로복지공단 서비스 — **서비스 ID 발급 시 확인** |
| `scienceon` | KISTI ScienceON | `scienceon_search`(논문·특허·R&D 보고서, 키워드) | 제목·저자·연도·원문 링크 | `SCIENCEON_API_KEY` (scienceon.kisti.re.kr) |

### 프리셋 비서
각 커넥터를 켠 프리셋을 `agent-presets.ts`에 추가(정의는 그 파일 한 곳): 「경제지표 조회 비서」(ecos) · 「주소 확인 비서」(juso) · 「의안 추적 비서」(assembly) · 「부동산 시세 비서」(apt) · 「연구자료 검색 비서」(scienceon). 고용·산재는 「입찰공고 조회 비서」에 함께 켠다(참가업체 확인 용도). 기존 기관에는 `seed:agents -- --update`.

### 테스트
- `connector:probe`에 6개 항목(검색 → 상세). 키가 없으면 SKIP이 아니라 **없다고 출력**
- `tests/connectors.test.ts`: `CONNECTORS` 배열의 모든 커넥터가 `connector-labels.ts`에 있다 · `isConfigured()`가 `config.ts` 상수만 본다(소스) · 도구 이름이 `<id>_` 접두를 따른다(`findConnector`가 이름으로 라우팅하므로 충돌 방지)

### 범위 밖
웍스의 금융 리서치 3종·의약 3종 — 공공기관 업무와 거리가 멂.

---

## A3. 스마트 라우팅

### 목적
쉬운 질문에 비싼 모델을 쓰지 않는다. 기관 예산(연간 정액)과 직결. 웍스는 이를 「요금 절감」으로 판다.

**정책이 먼저다**(0021과 같은 순서): 기관이 켜야 돌고, 기관 허용 모델 **안에서만** 고른다. 기본은 꺼짐.

### 판정 — 1차는 규칙 기반, LLM 판별은 안 쓴다
판별에 LLM을 쓰면 판별 비용이 절감분을 먹고, 틀렸을 때 왜 그 모델이 골라졌는지 설명할 수 없다. 규칙은 설명 가능하고 기록할 수 있다.

| 등급 | 신호 | 모델 (허용 목록 안에서) |
|---|---|---|
| `light` | 비서 카테고리가 변환·번역·표정리 · 질문 200자 미만 · 문서·도구 없음 | 가장 싼 모델 (`claude-haiku-4-5`) |
| `standard` | 그 외 기본 · 문서 첨부 · 커넥터 켜짐 | 기본 모델 (`claude-sonnet-4-6` 또는 기관 기본) |
| `heavy` | 비서 카테고리가 법령·규정·의회·민원 · 질문에 「검토·해석·판단·근거」 · 이미지 첨부 · 질문 1,500자 이상 | 최상위 (`claude-opus-5`) |

- 비서 설정 `agents.model_policy`: `'auto'`(기본) 또는 **모델 id 고정**. 관리자가 "이 비서는 항상 Opus"를 정할 수 있다
- 사용자가 화면에서 모델을 직접 고르면 그것이 우선(지금 동작 유지)
- 허용 목록에 그 등급의 모델이 없으면 **한 단계 위**로(아래로 내리지 않는다 — 품질을 몰래 낮추지 않는다)

### 데이터 — 0027
```sql
ALTER TABLE organizations ADD COLUMN smart_routing_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE agents ADD COLUMN model_policy text NOT NULL DEFAULT 'auto';   -- 'auto' | 모델 id
```
### 기록
`usage_logs.details.routing = { class, reason: string[], requested, chosen }` — 모든 대화에. 통계 화면 모델별 내역에 「라우팅으로 바뀐 건수」 추가. **절감액 주장은 이 기록으로 2주 측정한 뒤에만** 한다 — 웍스의 "90%"는 자사 실측 표기다.

### 코드 자리
`src/lib/model-router.ts` — `classify(input): {class, reason[]}` 순수 함수 · `routeModel(class, allowed, agentPolicy, requested)`.
`/api/chat`·`/api/qna`·`/api/report`의 `resolveModel()` 호출 **앞**에서 요청 모델을 정한다 — 정책 검사는 그대로 거친다(라우팅이 정책을 우회하지 못하게).

### 화면
기관 정보: 토글 + 설명(「질문 난이도를 재서 맞는 모델로 보냅니다. 허용 모델 안에서만 고릅니다」). 비서 수정: 모델 고정 선택. 대화 화면: 답변 아래 작은 글씨로 쓰인 모델(지금도 있으면 유지).

### 테스트 (`tests/model-router.test.ts`)
- 등급별 대표 입력 → 기대 모델 (순수 함수)
- 허용 목록 밖 모델이 **절대** 안 나온다 (변이: 허용 목록을 비우면 기본 모델)
- 「위로만 올린다」 — light인데 haiku가 허용에 없으면 sonnet, 반대는 없음
- 세 라우트 모두 `routeModel`을 거친다 (소스 전수)

### 범위 밖
LLM 기반 판별 · 응답 품질 자동 평가. 대리 지표(재질문율)는 통계에서 보기만 한다.

---

## A4. 워크플로우 예약

### 목적
정해진 시각에 비서가 일하고 결과를 메일로 보낸다. **입찰 모니터링**(나라장터 새 공고)은 공공기관 계약 담당자의 매일 아침 업무다.

### 범위 — 템플릿 둘로 시작
| 템플릿 | 하는 일 | 쓰는 것 |
|---|---|---|
| `bid_monitor` 입찰 모니터링 | 키워드로 나라장터를 검색해 **지난 실행 이후 새 공고만** 정리 → 메일 | `g2b` 커넥터 · `state.seen_bid_ids` |
| `morning_brief` 아침 브리핑 | 법령 개정·통계·공시 중 지정 주제를 훑어 요약 → 메일 | `law`·`kosis`·`dart` |

자유 프롬프트 워크플로우는 두 템플릿이 돌아간 뒤에.

### 데이터 — 0028
```sql
CREATE TABLE workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL, department_id uuid NOT NULL REFERENCES departments(id),
  created_by uuid NOT NULL REFERENCES users(id),
  name text NOT NULL, template text NOT NULL, agent_id uuid REFERENCES agents(id),
  params jsonb NOT NULL DEFAULT '{}',          -- 키워드·주제
  schedule_cron text NOT NULL,                 -- 'Asia/Seoul' 기준 표기, 실행기가 UTC로 환산
  recipients text[] NOT NULL,                  -- 기관 도메인 메일만 허용
  enabled boolean NOT NULL DEFAULT true,
  state jsonb NOT NULL DEFAULT '{}',           -- seen_bid_ids 등
  last_run_at timestamptz, last_status text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE workflow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workflow_id uuid REFERENCES workflows(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  status text NOT NULL, summary text, error text
);
```
### 실행
- `vercel.json`에 `crons: [{ path: "/api/cron/workflows", schedule: "*/10 * * * *" }]`. **Vercel Hobby는 크론이 하루 1회라 Pro가 필요하다**(「확인」). 시각 표기는 KST, 실행기가 환산(월 한도의 KST 교훈과 같은 자리)
- `/api/cron/workflows`: `CRON_SECRET` 헤더 검사(`config.ts`) → 이번 10분 창에 걸리는 `enabled` 워크플로우를 돌린다. `route-auth`의 공개 목록에 **사유와 함께** 등록
- 실행 하나 = `checkTokenLimit(dept, created_by)` → 템플릿 실행 → `usage_logs`(`action='workflow_run'`, `details`에 토큰·원가·`workflow_id`) → `workflow_runs` 기록 → `sendMail`
- 대화 파이프라인을 라우트 밖에서 부를 수 있어야 한다 → `/api/chat`의 핵심을 `src/lib/agent-turn.ts`(`runAgentTurn()`)로 떼어낸다. **이 리팩터링이 A4의 절반이다**
- `mailer.ts`에 범용 `sendMail(to[], subject, html)` export 추가(지금은 초대·임시비밀번호 전용 둘뿐)
- 한도 초과·커넥터 키 없음·메일 미설정은 `workflow_runs.error`에 까닭을 남긴다 — 조용히 빈 메일을 보내지 않는다

### 화면
관리자 → 워크플로우: 목록(이름·템플릿·주기·수신·마지막 실행·상태) · 만들기(템플릿 고르기 → 키워드/주제 → 시각 → 수신자) · 켜기/끄기 · 실행 이력. **직원은 만들지 못한다**(토큰을 자동으로 쓰는 기능이라 관리자 통제).

### 테스트
- 크론 라우트가 `CRON_SECRET`을 검사한다 (소스) · 공개 목록에 사유 있음
- `bid_monitor`의 "새 공고만" 판정 순수 함수 — 같은 입력 두 번이면 두 번째는 빈 결과
- 실행 경로가 `checkTokenLimit`·`usage_logs` 규약을 지킨다 (`usage-limit.test.ts` 전수 검사가 잡도록 `callClaudeAPI` 호출이 그 파일 안에 있게)
- 수신자 도메인 검증(기관 도메인 밖 거부)

### 범위 밖
Slack·Teams 발송 · 워크플로우 간 연결 · 사용자별 개인 워크플로우.

---

## A5. 작은 것들

| 기능 | 내용 | 자리 |
|---|---|---|
| 대화 목록 접기 | 사이드바 접기 버튼, 상태는 `localStorage` | `Sidebar.tsx` |
| 사용법 링크 | 사이드바 하단 「이용 가이드」 → 기관이 정한 URL(`organizations.guide_url`, NULL이면 숨김) | 0026에 컬럼 추가 |
| 비서 공유 범위 | 개인 비서를 **부서**까지 공유(`visibility='department'` + 소유자 유지). 전사는 지금의 승인 플로우 | `/api/agents/personal/[id]` PATCH |

---

## B2. 근거 화면 — NODA 의존

NODA `/context`의 `sources[]`와 `/verify`의 결과를 화면에 낸다. **NODA 연결(B1) 뒤.**

| 요소 | NODA 필드 | 화면 |
|---|---|---|
| 쪽 번호·경로 | `sources[n].anchors.page` · `path`(제목 > 절) | `SourceCitation`에 「공고.hwpx · 3쪽 · 3. 신청기간」 |
| OCR 배지 | `sources[n].extractors` 에 `ocr` | 「스캔 판독 — 숫자·날짜 확인 필요」. 오차 0.19는 **화면에 적을 수치** |
| 원문 하이라이트 | `GET /view?tenant&question` (PDF·그림만) | 출처 옆 「원문에서 보기」 → 새 창. HWPX·HWP·DOCX는 **왜 못 칠하는지** 적음 |
| 근거에 없는 숫자 | `/verify.sentences[].unsupported[]` | 말풍선에 「근거에 없는 숫자: 28, 1,200」 배지 + 본문 표시. **고치지 않는다** |
| 없는 인용 | `/verify.unknown_refs[]` | 「[3]은 근거 목록에 없습니다」 |
| 잘림 | `/context.truncated` | 「자료가 길어 일부만 참고했습니다」 |

저장: `messages.source_references.verify = {grounded, unsupported, unknown_refs}` — 감사 CSV에 「검증」 열.
테스트: SSE `verify` 이벤트가 저장되는지(소스) · `unsupported` 렌더링 순수 함수.

## B3. NODA 덕에 작아진 기능 — NODA 의존

| 기능 | 흐름 | 비고 |
|---|---|---|
| **텍스트 추출 → 엑셀** | 이미지 최대 20장(통장사본·영수증·명함) → 종류 선택 → NODA `/parse`(OCR) → 추출 항목 선택 → Claude가 구조화 → `exceljs`로 XLSX | OCR 숫자는 「확인 필요」 열을 함께 낸다. 상단 메뉴 「업무 도구」(웍스처럼 비서와 별개) |
| **문서 작성 — 목차 인식** | HWP/DOCX 양식 업로드 → NODA `structure`(제목·조항)로 목차 → 항목 고르면 초안 → 수정 요청 → 전체 복사 | NODA W463이 목차를 이미 준다(outline_f1 0.906) |

둘 다 토큰 규약·한도·감사를 그대로 탄다. 「업무 도구」 메뉴는 비서가 아니라 **정해진 입출력의 워크플로**라 상단 메뉴로 둔다.

---

## 구현 순서와 의존

```
A1 결재 ──┐
A2 커넥터 ─┼─ 서로 독립. A1부터.
A3 라우팅 ─┤   A4는 A3 뒤가 낫다(워크플로우도 라우팅을 탄다)
A4 예약 ───┘
A5 ──────── 언제든
B2·B3 ───── NODA B1 뒤
```

마이그레이션 번호: 0026(결재 + guide_url) · 0027(라우팅) · 0028(워크플로우) · 0029(NODA 연결, B1). 각각 **코드보다 먼저** 적용.
