# 기관 통계 읽기 API (2026-11-09, 0075)

알리웍스는 플랫폼 API(인증·사용자·지식베이스·RAG·앱 마켓·대화·모델 등 12개 항목)를 문서로 낸다([REA 재분석](REA_PUBLIC_WEB_ANALYSIS_2026-10-31.md)). WORKON에는 화면 안 API만 있고 기관의 다른 시스템이 부를 길이 없었다. 공공기관이 가장 먼저 요구하는 것은 **경영정보·보고 시스템에 사용 현황 숫자를 옮기는 것**이라, 첫 단계로 **범위를 제한한 읽기 전용 키**로 도입 현황·이용통계의 숫자만 내보낸다.

## 무엇을 내보내나

| 주소(GET) | 범위 | 내용 |
| --- | --- | --- |
| `/api/v1/adoption-report?month=YYYY-MM` | `adoption` | 월별 도입 현황과 전월(관리자 통계 '월별 도입 현황'과 같은 DB 함수 `adoption_report`·같은 줄 `adoptionRows`) |
| `/api/v1/adoption-report/departments?month=YYYY-MM` | `adoption` | 부서별 도입 현황(`adoption_by_department` — 부서마다 자기 부서 기록만) |
| `/api/v1/usage-summary?by=agent\|department&from=YYYY-MM-DD&to=YYYY-MM-DD` | `usage` | 비서별·부서별 이용통계(`usage_summary` — 횟수·토큰·원가·모델·활동). 기간은 한국 날짜, 비우면 최근 30일, 366일까지 |
| `/api/v1/feedback-summary?from=YYYY-MM-DD&to=YYYY-MM-DD` | `usage` | (2026-11-11, 0086) 답변 평가 요약 — 관리자 통계 '답변 평가'와 같은 `loadFeedbackSummary`: 전체·비서별 도움됨·아쉬움·도움됨 비율·이유 수·줄인 시간(자기 신고, 분)·고른 답 수. 기간 규칙은 관리자 화면과 같다(비우면 최근 30일, 1년까지, 없는 날짜 400) |
| `/api/v1/app-runs` | `usage` | (2026-11-11, 0086) 입력형 앱 실행 현황(`?from=&to=` 한국 날짜·끝 날 포함, 비우면 최근 30일·1년까지, 틀리면 400 — 2026-11-26) — 관리자 통계와 같은 `loadAppRunOverview`(0133 `app_run_states_between` — 끝 시각까지 DB에서): 앱마다 실행·완료·중단·확인 필요·응답 없음·자주 멈춘 단계 이름·멈춘 까닭 코드(`failedCauses`, 2026-11-26)·마지막 중단 시각. 개인 앱은 이름 없이 한 묶음 |
| `/api/v1/documents?status=&agent=&limit=&cursor=` | `documents` | (2026-11-23, 0099) **문서함 목록** — 아래 '문서함 목록' 절 |
| `POST /api/v1/documents/upload-url` · `POST /api/v1/documents` | `documents_write` | (2026-11-24, 0100) **문서 올리기·새 판 올리기** — 아래 '문서 올리기' 절 |
| `POST /api/v1/chat` | `chat` | (2026-11-24, 0101) **비서에게 묻기** — 아래 '비서에게 묻기' 절. 이 끝점만 **글(답·근거 발췌)을 밖으로 낸다** |
| `/api/v1/budget` | `usage` | (2026-11-11, 0086) 예산 소진 현황 — 차단·알림과 같은 `organizationBudgetStatus`(연간 정액이면 계약 기간 금액 `unit: krw`, 종량제면 이번 달 토큰 `unit: tokens`, 한도가 없으면 `organization: null`)·`departmentBudgetStatuses`(월 한도를 둔 부서의 이번 달 사용액, 집계 못 한 부서 수 `departmentsFailed`). **개인 한도는 싣지 않는다** |

- **숫자만**: 직원 이름·이메일·질문 원문·답변 글·결과 파일은 어느 주소에도 없다(앱 실행 현황의 앱·단계 이름, 부서 이름은 관리자 화면과 같이 싣는다). **직원별 이용통계(`by=user`)는 400**이다. 나만의 비서는 직원이 붙인 이름 대신 `(나만의 비서)`로 보인다. 비서 아이콘 같은 화면 칸은 뺀다.
- 응답은 `{ ok: true, data }`, 오류는 `{ ok: false, error: { message } }`, 모두 `Cache-Control: no-store`. `month`가 없으면 이번 달, 아직 오지 않은 달은 400.
- 숫자의 범위는 **키를 만든 기관 전체 관리자의 관리 범위**(= 기관의 모든 부서)다. 관리자 화면과 같은 셈이라 두 곳의 숫자가 갈리지 않는다.

## 문서함 목록 (2026-11-23, 0099)

기관 문서관리시스템(EDMS)이 WORKON 문서함과 맞대 보게 하는 읽기 전용 목록이다(`src/lib/org-api/documents.ts`). 숫자만 내는 다른 주소와 달리 **문서 이름이 나간다** — 그래서 범위를 `documents`로 따로 두어, 통계 키로는 읽지 못한다.

- 한 줄: `id`·`title`(제목, 없으면 파일 이름)·`fileName`·`fileType`·`agent { id, name }`(비서 없는 옛 문서는 null)·`departmentId`·`departmentName`·`status`(`legacy` 옮기기 전·`reading`·`ready`·`failed`·`unreadable`·`deleting`·`retired`)·`reason`(실패·못 읽음일 때만)·**`citable`**(지금 대화에서 근거로 쓰는가 — 대화와 같은 판 규칙 `notCitableEditionIds`: 읽힘이고, 시행 중인 읽힌 새 판이 대신하지 않고, 시행일 전인 새 판이 아님)·`tags`·`edition { replacesId, replacedById, effectiveFrom, retiredAt }`·`createdAt`·`readAt`.
- **싣지 않는 것**: 본문·요약·원본·저장소 경로·NODA 파일 이름·올린 사람. **나만의 비서의 문서**(직원의 개인 자료 — 이름도)와 **지운 비서의 문서**(치우는 중)는 내지 않는다.
- 거르기: `status`(위 일곱 중 하나)·`agent`(비서 uuid)·`limit`(1~200, 기본 100). 틀린 값은 기본값으로 바꾸지 않고 400(밖의 시스템이 틀린 거르기를 모르고 전체를 받지 않게).
- 쪽 넘기기: 오래된 것부터(만든 시각, id). 응답 `next`를 다음 호출의 `cursor`로 그대로 넣는다(꼴이 틀리면 400). 숨긴 문서를 빼므로 한 쪽이 `limit`보다 적을 수 있다 — `next`가 null일 때까지 따라간다. `updated_since`는 없다(`documents.updated_at`이 읽기 상태가 바뀔 때 갱신되지 않아 증분 기준으로 믿을 수 없다).
- 새 판·부서 이름을 못 읽으면 판정을 꾸미지 않고 500.

## 문서 올리기 (2026-11-24, 0100)

기관 문서관리시스템이 규정·지침을 비서 문서함에 올리거나 새 판으로 바꾼다(`src/lib/org-api/document-write.ts`). **쓰는 범위**라 `documents_write`를 따로 두었다 — 읽기 키(`documents`)로는 못 올리고, 쓰기 키로는 목록을 못 읽는다(둘 다 필요하면 한 키에 두 범위). 화면은 이 범위를 고르면 경고를 보인다.

1. `POST /api/v1/documents/upload-url` `{ agentId, fileName, size, fileType? }` → `{ path, uploadUrl, method: 'PUT', headers: { Content-Type }, expiresAt }`. 파일 검사(형식·20MB·위험한 이름)와 비서 검사를 먼저 한다.
2. 밖의 시스템이 `uploadUrl`에 **파일 바이트를 그대로 PUT**(받은 `Content-Type`으로). 저장소(Supabase Storage)로 바로 가므로 기관 방화벽은 그 주소를 열어야 한다 — Vercel 함수 본문 상한(4.5MB)을 거치지 않으려는 것이다.
3. **10분 안에** `POST /api/v1/documents` `{ path, agentId, fileName, fileType?, title?, replacesId?, effectiveFrom?, tags?, visibility? }` → 201 `{ id, agentId, status, replacesId, effectiveFrom, tags }`. 화면 확인(`/api/documents/confirm`)과 같은 검사를 한다 — path가 **이 키를 만든 관리자에게 발급한 것**인지(아니면 403), 10분 안인지(지나면 원본을 지우고 410), 저장소가 아는 실제 크기(없으면·20MB 넘으면 413), 확장자가 주소를 받을 때와 같은지, 비서 권한·비서당 문서 수, 바꿀 옛 판(같은 기관·같은 비서의 현재 판·경쟁하는 새 판 없음 — 아니면 409), 시행일 꼴, 태그(기관 분류표 표기로 맞추고 '분류표의 태그만'이면 밖의 태그 400, 분류표를 못 읽으면 503 — 등록하지 않음). 그다음 읽기를 건다(NODA 비동기 넣기라 대개 `reading`으로 바로 돌아오고, 결과는 웹훅·목록 맞추기가 쓴다 — 읽기 걸기가 실패해도 등록은 됐고 `reading`으로 답한다).

- **올린 사람은 키를 만든 기관 전체 관리자**다(그 사람의 권한으로 판정하고 `uploaded_by`에 남는다 — 그 관리자가 퇴직·강등되면 키가 멈추는 것은 읽기와 같다).
- 비서는 **이 기관의 지우지 않은 공식·부서 비서**만. 나만의 비서(키 주인 것이어도)·지운 비서·다른 기관 비서·없는 비서는 같은 404(목록 API가 감추는 비서와 같다).
- 같은 path를 다시 보내면 409와 이미 만든 문서 id(원본은 지우지 않는다 — 응답을 놓친 재시도가 문서를 둘로 만들지 않는다).
- 새 판(`replacesId`)은 화면처럼 **새 판이 읽히는 순간** 옛 판이 지난 판으로 내려간다(시행일이 미래면 그날부터). `effectiveFrom`은 2000~2100년의 있는 날짜.
- 기록: 보안 로그 `org_api_document_uploaded`(medium — 키 id·문서·비서·옛 판, 감사 화면 '기관 API로 문서 올림'), 막힌 파일은 화면과 같은 `file_upload_blocked`(high, `via: org_api`·키 id), 비서 변경 기록 `document_added`(`via: org_api`), 문서 찾기 능력 켜기(판에 남음).
- 지우기는 이 범위로 하지 않는다 — 되돌릴 수 없어 **따로 고르는 범위** `documents_delete`(아래 '문서 지우기', 0104)로만. 여러 비서에 한 번에 올리기는 없다(비서마다 호출).

## 문서 지우기 (2026-11-24, 0104)

기관 문서관리시스템이 폐지한 규정을 비서 문서함에서 내린다 — `DELETE /api/v1/documents/{id}`(범위 **`documents_delete`** — 올리기 `documents_write`와 따로 고른다, 화면이 고를 때 '되돌릴 수 없음'을 경고).

- 지울 수 있는 문서는 **이 기관의 지우지 않은 공식·부서 비서**에 붙은 문서만(올리기·묻기와 같은 `writableAgent`). 나만의 비서(키 주인 것도)·지운 비서·비서 없는 문서·다른 기관 문서·이미 지운 문서·꼴이 틀린 id는 모두 같은 404(있는지 드러내지 않음).
- 지우는 길은 관리자 문서 화면과 **같은 함수**(`src/lib/document-delete.ts` `deleteAgentDocument` — NODA → 행 → 원본, 여러 비서가 함께 쓰는 원본은 남김). NODA를 못 비우면 행을 '지우는 중'으로 남기고 502 `error.code: documents_unavailable`(같은 호출을 다시 보내면 이어 지운다), 행 삭제 실패는 500, 문서·비서를 못 읽으면 503(아무것도 지우지 않음).
- 지운 사람은 키를 만든 기관 전체 관리자 — 비서 타임라인 `document_removed`(`via: org_api`), 보안 로그 `org_api_document_deleted`(**high**, 키·문서·비서 id만). 성공 200 `{ id, deleted: true }`.
- 새 판을 지워도 이미 내린 옛 판은 되살리지 않는다(화면 삭제와 같다).
- 시험: `tests/batch-0282.test.ts`.

## 키

- **기관 전체 관리자**(최상위 부서 소속 관리자)만 '기관 정보' 화면 아래 **'기관 통계 API 키'**에서 만들고(`POST /api/admin/api-keys` `{ name, scopes, days }`) 회수한다(`DELETE /api/admin/api-keys/[id]`). 하위 부서 관리자에게는 안내만 보인다. 대리 접근 세션은 만들 수 없다(키가 대리 접근을 넘어 남는다).
- 키는 `wo_api_` + 32바이트. **원문은 만든 응답에서 한 번만** 보이고 DB에는 SHA-256과 앞 12자만 남는다. 유효 기간 30·90·365일(무기한 없음), 범위는 `adoption`·`usage`·`documents`(0099)·`documents_write`(0100 — 쓰기)·`chat`(0101 — 비서에게 묻기, 글을 밖으로 냄) 중 하나 이상, 기관에 쓸 수 있는 키 10개까지.
- 만들기·회수는 보안 로그(`security_logs` — `org_api_key_created`·`org_api_key_revoked`, high, 키 이름·앞부분·범위만)에 남고 감사 화면에 '기관 통계 API 키 만들기/회수(관리자)'로 보인다.
- 목록은 이름·앞부분·범위·상태(쓰는 중·회수됨·만료됨)·만료·마지막 호출·호출 수·만든 사람, 그리고 최근 호출 50개(시각·키·주소·상태 코드).

## 호출 확인 (`src/lib/org-api/keys.ts` `handleOrgApiCall`)

1. `Authorization: Bearer wo_api_…` 꼴이 아니면 401(차지하지 않음).
2. **차지** — `org_api_key_claim`(행 잠금)이 활성·만료 전·하루 1,000번(한국 날짜)을 원자적으로 보고 사용 기록을 올린다. 없음·회수·만료는 모두 같은 401(어느 키가 있었는지 밖에 가르지 않는다). 하루 상한은 429.
3. **기관 접속 허용 IP**(0023)가 있으면 그 안에서만 — 화면 세션과 달리 **주소를 모르면 막는다**(밖에서 부르는 API는 닫는 쪽으로). 허용 목록을 읽지 못하면 500(닫힘).
4. **키 범위** 밖 주소는 403.
5. **키를 만든 관리자가 아직 그 기관의 전체 관리자인가** — 활성·탈퇴 아님·ADMIN·최상위 부서·같은 기관. 아니면 403(새 키를 만들라는 안내). 그래서 관리자가 퇴직·전보·강등되면 그 사람이 만든 키는 곧바로 멈춘다(탈퇴 처리가 키를 따로 회수하지 않아도).
6. 그 관리자의 관리 범위로 센다. 입력 오류는 400, 집계 실패는 500.

차지를 통과한 호출(2단계 이후)은 상태 코드와 함께 `org_api_key_calls`에 남는다 — 요청 값·응답 내용은 남기지 않는다. 기록 실패는 응답을 바꾸지 않는다. 점검 모드에서는 다른 API처럼 503이다.

## 마이그레이션 0075

`org_api_keys`(키 — 범위 CHECK `scopes <@ {adoption, usage}`·1~2개, 해시 꼴, 회수 짝, 이름 1~40자, 만료가 만든 때 뒤)·`org_api_key_calls`(호출 기록 — 끝점 셋·상태 코드 CHECK, 키를 지우면 함께 지움)·`org_api_key_claim(text, timestamptz, integer)`. 추가만, 여러 번 적용해도 안전, 두 표 모두 RLS 켜고 정책 없음, 함수 실행 권한 service_role만. **코드 배포 전에 적용** — 없으면 키 화면과 `/api/v1/*`만 실패한다(다른 기능은 이 표를 읽지 않는다).

## 마이그레이션 0086 (2026-11-11)

호출 기록 `org_api_key_calls.endpoint`의 CHECK를 끝점 여섯(`feedback-summary`·`app-runs`·`budget` 추가)으로 넓힌다 — 옛 CHECK를 이름과 상관없이 찾아 지우고 다시 건다. 키의 범위(`scopes`)는 그대로(`usage` 키가 새 셋을 읽는다). 여러 번 적용해도 안전. 코드 배포 전이 좋다 — 없으면 새 끝점 호출은 돌지만 호출 기록만 빠진다(기록 실패는 응답을 바꾸지 않음).

## 마이그레이션 0099 (2026-11-23)

키 범위 `org_api_keys.scopes` CHECK를 `{adoption, usage, documents}`·1~3개로, 호출 기록 끝점 CHECK에 `documents`를 더한다(옛 CHECK를 찾아 지우고 다시 건다). 값만 넓힘·여러 번 적용해도 안전. **코드 배포 전에 적용** — 없으면 `documents` 범위의 키 만들기가 CHECK에 걸려 실패한다(다른 범위·끝점은 그대로).

## 비서에게 묻기 (2026-11-24, 0101)

기관 시스템(민원 창구·그룹웨어 봇·업무포털)이 이 기관의 공식·부서 비서에게 묻고 답을 받는다(`src/lib/org-api/chat.ts`, `POST /api/v1/chat`, 라우트 300초). 범위 `chat`은 다른 범위와 달리 **답 글·근거 발췌가 밖으로 나가므로** 따로 두었고 화면은 고르면 경고한다.

- 요청 `{ agentId, question, conversationId?, skipDocuments?, tags? }` — 질문 4,000자까지, `skipDocuments`는 참거짓만(틀린 꼴 400 — 조용히 무시하면 문서를 찾은 답을 문서 없는 답으로 안다), `tags`는 대화의 '문서 좁히기'와 같은 규칙(실행기가 검사).
- 응답 200 `{ conversationId, messageId, continuable, answer, sources: [{ n, title, location, common, effectiveFrom, excerpt }], links: [{ title, url }], files, numberCheck: { unverified, rechecked }, documentsSkipped }`. `answer` 속 `[n]`이 `sources[].n`을 가리킨다(화면 근거 칩과 같은 번호·제목·위치, 발췌는 근거 창의 원문 — 2,000자까지, NODA 파일 이름 앞부분 뗌). `numberCheck.unverified`는 화면의 '확인되지 않은 숫자'와 같다. `files`는 문서 만들기 도구가 만든 파일의 **이름만**(파일은 키를 만든 관리자의 결과물 화면에).
- **묻는 사람은 키를 만든 기관 전체 관리자**다 — 그 사람의 세션 꼴로 대화 실행기(`prepareTurn`·`streamTurn`)를 화면과 같은 본문으로 태운다. 그래서 비서 사용 권한·기관/부서/**그 사람의 개인** 한도·모델 정책·금지어·개인정보 검사(걸리면 보안 로그)·문서 근거·숫자 확인·NODA 검증 기록·사용 기록이 화면 대화와 같다.
- 대화는 그 관리자의 대화로 남는다 — 제목 앞 `[API] `, `conversations.metadata.org_api = { key_id, started_at }`(마이그레이션 없음). 관리자 화면 대화 목록에서 보이고 지울 수 있다. 새 대화마다 보안 로그 `org_api_chat_started`(low — 키·대화·비서 id만, 질문 글 없음).
- **이어 묻기**는 응답의 `conversationId`를 보내면 앞 대화 이력과 함께 답한다. **같은 키로 같은 비서에게 시작한 대화만** — 다른 키·화면에서 시작한 대화·없는 대화는 같은 404(있는지 알리지 않음), 못 읽으면 503. 새 대화에 키 표시를 못 남기면 답은 하되 `continuable: false`(운영 기록 warning).
- 비서는 문서 올리기와 같은 규칙(**이 기관의 지우지 않은 공식·부서 비서**, 꺼진 비서 포함 404 — 나만의 비서는 키 주인 것이어도 아님). 링크형 비서·입력형 앱은 400(앱은 입력 항목이 있어 질문 하나로 돌지 않는다 — 앱은 앱 연동(Webhook)으로).
- 거절은 실행기 그대로 — 한도 429, 금지어·개인정보 400, 권한 403, NODA를 못 부르면 503과 `error.code: "documents_unavailable"`(`skipDocuments: true`로 문서 없이 다시 물을 수 있다). 생성 중 오류는 502(실행기의 한국어 안내 — 원문은 운영 기록에), 240초 안에 못 마치면 504. 둘 다 대화는 남았을 수 있다.
- **스트리밍 답**(2026-11-24, 마이그레이션 없음): 요청에 `"stream": true`(참거짓만 — 글자 `"true"`는 400)를 넣으면, 확인·준비(키·범위·비서·이어 묻기·한도·금지어·NODA)를 **마친 뒤에만** `text/event-stream`으로 답한다 — 그 전 실패는 지금처럼 JSON 오류(상태 코드 그대로).
  - 사건(한 사건 = `event:` 줄 + `data:` JSON 한 줄): `start { conversationId, continuable }` → `tool { name }`(부른 도구 이름 — 입력은 싣지 않음)·`delta { text }`(답 글 조각) … → 끝은 `done { …stream 없이 물었을 때와 같은 data }` 또는 `error { status, message, code? }`(502 생성 오류·504 시간 안에 못 마침 — 그 앞의 글 조각은 이미 갔으니 버린다).
  - 호출 기록은 흐름을 연 때 200. 받는 쪽이 끊어도 답은 끝까지 만들어 대화에 저장한다(화면 대화와 같다 — `conversationId`로 이어 물을 수 있다). 보안 로그 `org_api_chat_started`에 `stream: true`.
  - 라우트는 `Cache-Control: no-store, no-transform`·`X-Accel-Buffering: no`(중간 프록시가 모아 보내지 않게). 시험: `tests/batch-0283.test.ts`.
- **첨부**(2026-11-24, 0105): ① `POST /api/v1/chat/attachments/upload-url { fileName, size }` → `{ attachmentId, uploadUrl, method: 'PUT', headers, expiresAt }` ② `uploadUrl`에 파일 바이트를 그대로 PUT ③ `POST /api/v1/chat/attachments { attachmentId }`(10분 안) → 읽은 결과 `{ attachmentId, fileName, sizeBytes, status, error, summary: { kind, pages, sheets, tables[{ id, title, rows, columns }], warnings } }` ④ `POST /api/v1/chat { …, attachmentIds: [...] }`(10개까지, uuid 배열만 — 틀리면 400).
  - 첨부 주인은 **키를 만든 기관 전체 관리자**(대화와 같다). 화면 대화 첨부와 **같은 함수**(`createUpload`·`confirmUpload` — `src/lib/org-api/chat-attachments.ts`)라 형식(엑셀·CSV·한글·워드·PDF·파워포인트·TXT)·10MB·보내지 않은 첨부 20개(429)·10분 확인 창(410)·스캔 PDF(NODA `/parse`)·사용 기록 `file_attached`·24시간 정리가 같다. 읽지 못한 파일은 200 + `status: 'failed'`와 까닭.
  - 붙일 수 있는지는 ④에서 대화 실행기가 다시 본다 — '파일 받아 읽기'가 꺼진 비서·남의 것·이미 보낸 것·읽지 못한 것은 400. 응답에 저장소 경로·사람 id는 없다. 범위는 그대로 `chat`.
  - 시험: `tests/batch-0284.test.ts`.
- **직원으로 묻기**(2026-11-25, 0108, 범위 `chat_as_user` — `chat`과 함께만): 그룹웨어 봇·업무포털처럼 직원 로그인을 이미 확인한 기관 시스템이 묻기·첨부 요청에 `asUser: "직원 이메일"`을 실으면 **그 직원으로** 묻는다(`src/lib/org-api/as-user.ts`).
  - 이 기관 부서에 등록된 쓸 수 있는 직원만 — 이메일 대소문자 무시·하나만. 없음·같은 주소 둘·다른 기관·슈퍼관리자·소속 없음은 같은 404, 사용 중지·탈퇴는 403, 범위가 없으면 403, 못 읽으면 503. **계정을 만들지 않는다.**
  - 그 직원의 세션 꼴로 대화 실행기를 태우므로 비서 사용 권한(그 직원이 못 쓰는 비서면 403)·그 직원의 월 한도·금지어·대화 기록이 그 직원의 것이다. 대화 `metadata.org_api`에 `as_user: true`, 이어 묻기는 **같은 키·같은 직원**의 대화만. 첨부도 같은 `asUser`로 올려야 그 직원의 첨부로 붙는다.
  - 새 대화의 보안 로그 `org_api_chat_started`가 medium이 되고 `as_user_id`가 실린다(키를 만든 관리자 이름으로 남김).
  - WORKON은 기관 시스템이 직원을 제대로 확인했는지 알 수 없다 — 그래서 따로 고르는 범위이고 키 화면이 빨간 글로 경고한다. 시험: `tests/batch-0288.test.ts`.
- 받지 않는 것: 사진, 입력형 앱 실행. 호출은 키 하나 하루 1,000번 상한을 다른 끝점과 함께 쓴다.

## 마이그레이션 0101 (2026-11-24)

키 범위 CHECK를 `{adoption, usage, documents, documents_write, chat}`·1~5개로, 호출 기록 끝점 CHECK에 `chat`을 더한다(0100처럼 옛 CHECK를 찾아 지우고 다시 건다). 값만 넓힘·여러 번 적용해도 안전, **0100 뒤에**. **코드 배포 전에 적용** — 없으면 `chat` 범위의 키 만들기가 CHECK에 걸려 실패한다.

## 마이그레이션 0108 (2026-11-25)

`org_api_keys.scopes` CHECK를 1~7개·`chat_as_user`까지(끝점은 그대로라 호출 기록 CHECK는 그대로). 값만 넓힘, 여러 번 적용해도 안전, **0104 뒤·코드 배포 전에 적용** — 없으면 직원으로 묻기 범위의 키 만들기가 실패한다.

## 마이그레이션 0105 (2026-11-24)

`org_api_key_calls.endpoint` CHECK에 `chat-attachment-upload-url`·`chat-attachment-confirm`(키 범위 CHECK는 그대로). 값만 넓힘, 여러 번 적용해도 안전, **0104 뒤**·코드 배포 전이 좋다 — 없으면 첨부 호출은 돌고 호출 기록만 빠진다.

## 마이그레이션 0104 (2026-11-24)

`org_api_keys.scopes` CHECK를 1~6개·`documents_delete`까지, `org_api_key_calls.endpoint` CHECK에 `documents-delete`. 값만 넓힘, 여러 번 적용해도 안전, **0101 뒤·코드 배포 전에 적용** — 없으면 지우기 범위의 키 만들기가 실패한다.

## 마이그레이션 0100 (2026-11-24)

키 범위 CHECK를 `{adoption, usage, documents, documents_write}`·1~4개로, 호출 기록 끝점 CHECK에 `documents-upload-url`·`documents-create`를 더한다(0099처럼 옛 CHECK를 찾아 지우고 다시 건다). 값만 넓힘·여러 번 적용해도 안전, **0099 뒤에**. **코드 배포 전에 적용** — 없으면 `documents_write` 범위의 키 만들기가 CHECK에 걸려 실패한다.

## 하지 않은 것

- 사용자 API는 없다. 대화는 공식·부서 대화형 비서에게 묻기까지(0101 — 스트리밍 답·첨부(0105)는 있고, 입력형 앱은 없다). 문서는 목록 읽기(0099)·올리기·새 판 올리기(0100)·지우기(0104, 따로 고르는 범위)까지 — 태그 고치기·여러 비서에 한 번에 올리기는 API로 하지 않는다. SSO(SAML/OIDC)·그룹 매핑도 그대로 남은 일이다.
- 키마다 IP를 따로 정하지 않는다(기관 접속 허용 IP를 따른다). 분당 속도 제한은 없고 하루 상한만 있다.
- 실제 외부 시스템에서 키로 불러 보지 않았다(운영 배포 뒤 로그인 없이 401만 확인). 화면은 브라우저로 보지 않았다. 올리기 주소에 실제로 PUT해 등록까지 해 본 적도 없다(서명 주소 PUT 꼴은 저장소 SDK의 `uploadToSignedUrl`이 몸을 그대로 보내는 길과 같다). 묻기(0101)도 실제 모델·NODA로 끝까지 불러 보지 않았다 — 실행기 자리는 가짜로 두고 넘기는 값·받은 사건을 맞췄다.

## 시험

- `tests/org-api.test.ts` — 키 꼴·해시·Bearer(연동 토큰 접두는 아님), 만들기 검사(이름 다듬기·범위 순서·기간), 이용통계 기간(최근 30일·날짜 꼴·366일), 화면 꼴(해시 없음·만료), 호출 확인 여덟 경우(성공·관리 범위·무효 401은 기록 없음·하루 상한 429 기록·IP 밖/모름 403·범위 밖 403·만든 관리자 일곱 경우 403·입력 오류·집계 실패 500·기록 실패해도 응답), 나만의 비서 이름 숨김·직원별 400, 기관 전체 관리자만, 라우트 셋이 같은 확인·no-store, 관리 라우트 관리자 확인·대리 접근·해시 안 실음, 화면이 잎 파일만 가져옴, 0075 꼴
- `tests/org-api-db.test.ts`(시험 DB) — 무효 한 사유·키 정보·사용 기록, 하루 상한 한국 날짜·다음 날 0부터, 동시 호출 하나만, CHECK 일곱, 호출 기록 CHECK·연쇄 삭제, anon·authenticated 거절
- `tests/route-auth.test.ts`에 `/v1/*` 여섯을 이유와 함께 공개 라우트로 적었다
- `tests/batch-0277.test.ts`(2026-11-23) — 문서함 목록: 범위·끝점, 상태 이름, 틀린 거르기 400, 기관·관리 범위 조건·본문 칸 안 읽음·밖으로 내는 칸, 나만의 비서·지운 비서 문서 뺌, 판(`citable`·`replacedById`·시행일 전 새 판), 까닭, 거르기·쪽 넘기기(숨긴 행 뒤부터), 틀린 cursor·판/부서 읽기 실패, usage 키로는 403, 0099 CHECK(시험 DB)
- `tests/org-api-more.test.ts`(2026-11-11) — 새 셋의 범위·주소, 답변 평가 기간(관리자 화면과 같은 규칙·없는 날짜 400·읽지 않음), 앱 실행 현황이 관리자 라우트와 같은 읽기 함수, 예산(단위·키 범위 부서만·집계 못 한 부서 수·개인 한도와 내부 열쇠 없음·한도 없으면 null), 0086 CHECK(시험 DB — 새 셋 받고 모르는 끝점 거절)
- `tests/batch-0278.test.ts`(2026-11-24) — 문서 올리기: 쓰기 범위·POST 끝점 둘, 요청 꼴 400, 주소는 키 주인의 경로·기관 전체 관리자 범위로 판정, 나만의 비서(키 주인 것)·지운·다른 기관·없는 비서는 같은 404, 막는 이름은 보안 로그(high·키 id), 범위를 못 읽으면 503, 등록은 행 하나(키 주인 이름)·문서 찾기 켜기·보안 로그·읽기 걸기(던져도 `reading`), 남의 경로 403·꼴 400, 같은 path 409(원본 안 지움), 10분·크기·확장자는 원본을 치우고 거절, 새 판(같은 기관 조건·지난 판·경쟁 새 판·없음 409), 없는 시행일 400, 태그 분류표(표기·밖 400·못 읽으면 503), 읽기·쓰기 실패는 던짐, 읽기 키로는 못 올리고 쓰기 키로는 목록 못 읽음·201·쓰기 실패 글, 라우트에 지우기 핸들러 없음, 0100 CHECK(시험 DB)
- `tests/batch-0279.test.ts`(2026-11-24) — 비서에게 묻기: 요청 꼴 400(4,000자·uuid·참거짓), 키 주인 세션 꼴·실행기에 넘기는 몸·240초 마감, 답·근거(번호·제목·위치·발췌의 NODA 앞부분 뗌·공통 자료실)·도구 출처(중복 뺌)·파일 이름·확인되지 않은 숫자, 새 대화의 키 표시·[API] 제목·보안 로그(질문 글 없음), 문서 없이·태그 넘김, 나만의·지운·꺼진·다른 기관 비서 404·링크형·앱 400(실행기 안 부름), 이어 묻기는 같은 키만(다른 키·화면 대화·없음 404, 못 읽으면 503), 실행기 거절 그대로(`documents_unavailable` 코드), 생성 오류 502(원문 없음)·못 마침 504, 키 표시 실패면 `continuable: false`, chat 키만 묻고 chat 키로 통계 못 읽음·`error.code`, 라우트 300초·화면 경고, 0101 CHECK(시험 DB)
