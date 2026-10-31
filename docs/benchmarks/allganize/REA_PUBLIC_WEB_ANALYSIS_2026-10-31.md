# REA 공개 웹 재분석 (2026-10-31)

조사일: 2026-10-31. [2026-10-28 분석](REA_PUBLIC_WEB_ANALYSIS.md)의 공백을 메우려는 2차 분석이다. 별도 임시 프로필의 **헤드리스 Edge 156**(loopback CDP `127.0.0.1:9333`)에 REA MCP(`rea-cdp-browser` provider v2)로 연결했다. 사용자 브라우저·계정·쿠키는 쓰지 않았고 로그인·계정 생성·상담 제출·비공개 API 호출은 하지 않았다. 상태 표시는 [README](README.md)의 정의를 따른다.

## 결론

- 앱 마켓 검색·분류 필터는 **URL 매개변수로 반영되는 클라이언트 측 필터**다(`?category=…&name=…`, 서버 호출 없음). 한국어 앱 마켓 주소는 없다(`/ko/app-market/llm-apps` → `/ko/home`으로 넘어감).
- 공식 사용자 가이드는 영문 79쪽·한국어 101쪽이고 GitBook이 쪽마다 Markdown(`.md`)과 `llms.txt`를 제공한다. 대화형 앱의 **노드 12종**, 답변형·에이전트형 앱의 설정 항목, 권한·승인·그룹·가드레일·크레딧·연동·API 범위를 본문에서 확인했다(문서 확인).
- 한국어 가이드에만 있는 **워크플로우(스케줄·Webhook 트리거)·Agent 빌더·엑셀 테이블데이터·Google Drive·Box 연동·리트리버 최적화** 페이지를 찾았다. 2026-10-28 분석의 "SaaS 예약 실행 범위 미확인"은 **대시보드 워크플로우 메뉴의 스케줄 트리거로 문서 확인**으로 바뀐다.
- `ai-coworker.alli.ai/portal`은 Works와 **별도 클라이언트**(Vite+React)다. 공개 번들에 승인·커넥터·SSO·결제·템플릿·스킬·문서 질의 경로 문자열이 있다(정적 관찰 — 실행하거나 호출하지 않았고 서버 동작은 미확인).
- 답변형 앱의 입력 6종 가운데 이름을 확정한 것은 여전히 **문서·문단형 텍스트·단일 선택 3종**뿐이다(영문·한국어 가이드 모두 예시 3종만 적음).

## 공백 체크리스트와 결과

| 10-28 분석의 공백 | 이번 결과 | 상태 |
|---|---|---|
| 앱 마켓 검색 실행 결과(그때 `target_unavailable`) | 검색 `契約` → 100개 중 **3개**(NDA 퀵 리뷰·인지세 체커·계약서 조항 추출·비교). URL `?name=%E5%A5%91%E7%B4%84` | 답함 |
| 분류 체크박스 동작 | 체크박스 9개(Finance·Other·Legal·Human Resources·IT·Marketing·Customer Relations·Sales·General). Finance 체크 → `?category=Finance`, 검색과 겹치면 `&name=`. Finance+契約는 0건(스크린샷) | 답함(Legal 단독은 아래 실패) |
| 필터가 서버 호출인가 | 체크·검색 뒤 allganize 호출 없음. 관찰된 요청은 Cloudflare Turnstile·GA·웹플로우 자산뿐 | 답함(관찰 창 안에서) |
| 빌더 입력 6종 | 3종만 확정(아래) | 부분 |
| 대화형 앱 노드 목록 | 12종 확정(아래) | 답함 |
| 예약·반복 실행 | 한국어 가이드 '워크플로우 구축하기': 스케줄·Webhook 트리거 | 답함(문서 확인) |
| Coworker와 Works 경계 | 별도 포털·별도 번들. 기능 경계는 번들 문자열로만 추정 | 부분 |
| 실제 제품 클라이언트 번들 | Coworker 공개 랜딩 번들 13개(3.5MB 포함) 정적 분석. Works 로그인 화면 번들은 주소를 공개 페이지에서 찾지 못해 미분석 | 부분 |

## REA 증거 (Evidence ID)

| 관찰 | Evidence ID | 비고 |
|---|---|---|
| 대상 목록(`list_browser_targets`) | ev_7bcaae3ff94cf517bfb835b6b6f9491477f181e469e3ec1b98934cb942c1ca3f | 페이지 4개, 비페이지 36 제외 |
| 일본어 앱 마켓 DOM·접근성 | ev_bff02ffc1a0307c2c399fd80e666c4fe285d5a080894d8c26400f05b0d017708 | 접근성 노드 2,006 · 앱 카드 링크 100 · 체크박스 9 · 검색 textbox 1 |
| 영문 사용자 가이드 첫 쪽 | ev_bc81b278e253b2dcc22c43cad69aac7a19a8009700d456effd7d265ff420a33b | 좌측 목차 전체 · `llms.txt`·Markdown 링크 |
| 한국어 Alli Works 제품 페이지 | ev_f220a88d89d3a65349af39fcea1f7f5e9bdbdd88dc1b5c7f77aad69b82381bd9 | 제목 63개(마케팅 주장) |
| 시나리오 1: 검색 입력 | ev_0cdf959ab65a2e4368aaa74e8f3ae23f1244ea1890e0f8b5f98831e480d31273 | URL에 `name` 매개변수 생김. 체크박스 단계는 locator 9개 충돌로 실패 |
| 시나리오 2: `#checkbox-2-1-1` check | ev_372382f1dadabde4ef19f89383c1714308200266339762556b2f9a302079f8a6 | **실패** — 숨은 input이라 15초 시간 초과 |
| 시나리오 3: label 클릭(Finance) + 검색 | ev_0dedd9d229be9054dc602131b0c028552872a6da50d6319c2557c04777ed7608 | `?category=Finance&name=契約`, 카드 0, 스크린샷 `appmarket-finance-契約.png` |
| 시나리오 4: 검색만 / Legal 클릭 | ev_e4be9ac86b7a3655061ae5f482290345fad6d29868edb4fec3ac887110e2b2dd | 검색만 → 카드 3. Legal label 클릭은 locator 충돌로 **실패** |
| Coworker 랜딩 번들 정적 분석 | ev_7e5d764652f907a2e2d18efbcdc2b713bdc5f03b31b8295fe9f043204b1e3210 | 스크립트 13 분석·파싱 실패 0·소스맵 없음 |
| API 참조 페이지 | ev_a1decc2bd3f7e7179d0dc50d5c82fb4768ee85db533aacf68e2d340197e8a58e | 항목 12개 |
| Coworker 랜딩 스크립트 원문 포함 관찰 | ev_dcf8d05078b77f1d7624c561aeed487257487f8dbbb5abf25aefd34f03f09c2b | MCP 전송 한도 초과로 보관만 됨 |

증거 묶음(내보내기 10건, 8.9MB)과 스크린샷: `C:/Users/Public/Documents/ESTsoft/CreatorTemp/workon-alli-rea-20261031/`. 공개 페이지 원문·스크립트가 들어 있어 제품 코드에 넣지 않는다.

가이드 본문은 GitBook Markdown(`…/llms.txt`, `<쪽>.md`)을 `curl`로 받아 읽었다 — **REA 증거가 아니라 셸 관찰**이며, 받은 시각은 2026-10-31이다. Coworker 번들의 경로 문자열 집계도 받은 파일의 `grep` 결과다(REA 번들 분석은 그중 fetch 호출 인자만 `endpoints`로 냈다).

## 1. 앱 마켓(일본어)

- 주소 `https://www.allganize.ai/ja/app-market/llm-apps`. 카드 100개(기존 카탈로그와 같은 수). 한국어 주소는 홈으로 넘어간다.
- 검색창(placeholder `🔎 キーワードで検索`)·"絞り込みをリセット"·분류 9개·"チェックをクリア". 걸러진 상태는 "絞り込み状況" 칩(Finance ×, 契約 ×)으로 보인다.
- **Finance 분류는 카탈로그(8분류 100개)에 없는 아홉째 값**이고, Finance를 켜면 카드 0개였다 — 카드가 아직 없는 분류이거나 다른 조건과 겹친 결과다. Legal 단독 결과는 못 잡았다.
- 가이드(관리자용 앱 마켓)는 대시보드 쪽 마켓을 **8분류(General·Sales·Customer Support·Marketing·IT·HR·Legal·Others)**, 카드마다 **대화형/응답형** 표시와 **'사용 중'** 표시, **앱 시험 → 앱 관리에 추가(분류 지정)**, 검색창 예시, **'앱 요청'** 폼이 있다고 적는다(문서 확인 — 공개 마켓과 로그인 마켓은 다른 화면).

## 2. 앱 빌더 세 유형(문서 확인)

### 답변형(단발 실행)
앱 이름·설명 · **입력 설정 6종 중 확인된 3종**: ① 문서(기본 — 직접 업로드 또는 '지식베이스에서 문서 첨부' 켜고 선택 범위 지정, 변수 `file1`) ② 문단형 텍스트(자리 표시자, 변수 `content`) ③ 단일 선택(옵션 목록, 변수 `language`) · 활성 모델 선택 · 시스템 프롬프트/유저 프롬프트 · 마크다운 출력 버튼 · **긴 입력 처리 3방식**(분할 없음 / 맵 / 맵-리듀스) · 시험 뒤 '공개'. 결과는 복사·문서 다운로드.

### 에이전트형
앱 정보 · 모델 · 지시(시스템 프롬프트) · **변수**(`{변수}` — 사용자 입력 요구 또는 시스템 변수) · **MCP 서버·툴 추가**(프로젝트에 연동된 서버 목록, 인증은 API 키·OAuth 등 서버별, 인자는 에이전트가 채우고 **오버라이드**는 고정값) · 대화 시나리오(시작 메시지·모델 실패 메시지·변수 요청 메시지) · 미리보기 · 공개. 한국어 'Agent 만들기'에는 Allganize 기본 툴(문서 검색·FAQ 검색·답변 생성)과 **프로젝트의 싱글액션 앱이 툴로 자동 추가**된다고 적혀 있다.

### 대화형(노드 그래프) — 노드 12종

| 노드 | 확인한 계약 |
|---|---|
| 연동(Integration) | URL + GET/POST/PUT/DELETE, 헤더, 보낼 변수/받을 변수, 간단/고급(JSON 경로) 모드, 선택 변수, 실패 메시지 |
| 조건 추가 | 옵션 목록을 **위에서 아래로** 판정, 옵션 안 조건은 AND, 변수 유형별 조건 종류, 비교값은 직접 입력 또는 변수 |
| 입력 폼 보내기 | 메시지 + 항목(변수 저장, 선택 항목, 객관식·다중 선택·동적 옵션·이미지 옵션), 담당자 이메일 전송 |
| 담당 멤버 연결 | 사람에게 넘김 |
| 메시지 보내기/질문하기 | 마크다운 지원 |
| 이메일 보내기 | — |
| 변수값 설정·변수 내보내기 | 계산식·함수 |
| Q&A에서 답변 | 신뢰도 기준·후보 수·키워드 가중 등 Q&A 설정 |
| 문서에서 답변(답변 생성) | **Agent / 그룹 프롬프트** 두 방식. 검색 원천 Q&A·문서(폴더·해시태그·변수 포함/제외)·인터넷. 답을 변수에 저장, 답한 뒤 반복/다음 노드. Agent는 function call 모델만, 중간 추론 보임 |
| LLM | 단일 프롬프트 / 에이전트. 이전 메시지 맥락, 결과를 사용자에게 또는 변수에, **JSON 출력 지정** |
| LLM 인풋 | 문서(목록·해시태그 범위·사용자 검색 ON/OFF·제목/내용 검색) · 스니펫 · **업로드(100MB, txt·docx·csv·xls·xlsx·xlsm·jpg·png·hwp·hwpx·pdf·ppt·pptx·doc)** |
| 딥 리서치 | **앱의 맨 끝에만**. 질문은 사용자 입력/변수, 모델 고정, 원천 문서·인터넷(사이트 한정)·업로드 — 노드 값은 초기값이고 Works 사용자가 권한 안에서 넓힌다. 비동기 10분~수십 분 |
| MCP | 서버·툴 하나를 **고정 호출**(에이전트의 비결정 선택과 구분), 인자 필드·오버라이드 |

변수 유형에 문자열 외 **문자열 목록·JSON·JSON 목록·파일**이 있고 연동 노드로 외부 목록을 받아 선택지로 쓴다.

## 3. 운영·권한·거버넌스(문서 확인)

- **앱별 접근 권한**: 기본 전원 공개, 끄면 그룹·멤버 지정, 역할 Viewer/Editor. 관리자는 전 앱 편집.
- **앱 공개 승인 절차**: 관리자가 승인자 지정 → 요청 → 승인/반려 → 공개 또는 수정 재요청. *"현재 제한적으로 제공, 담당자 문의"*.
- **그룹**: Admin(수정 불가)·Super Agent·Agent 기본 3종, 멤버는 여러 그룹, 권한은 OR 합산, SAML 그룹 자동 반영(Admin은 대시보드에서만). SSO 속성 매핑은 `department` → `GROUP` 변수. Google·Entra·Okta 판 가이드.
- **가드레일** 3종: 키워드·정규식(기본 제공은 활성/비활성만)·AI(폭력·성·자해·혐오, 강도 조절).
- **크레딧 한도**: 프로젝트별 월 한도(최대 2,000,000,000), 80%·90%·100% 메일. `CREDIT_LIMIT_EXCEED` 오류 코드.
- **사용 기록**: 대화형(상태·담당자·메모·변수·일괄 처리·필터), 답변형(입력·문서명·결과·상태 completed/failed/interrupted·프롬프트·긴 입력 옵션), LLM 통계(요청 수·크레딧·호출 수, Top 20, Preview는 '기타'로, 6개월 엑셀).
- **문서**: 폴더 권한 상속/개별, ZIP으로 구조째 업로드, 해시태그 일괄, 오류 코드 표(`DOCUMENT_BROKEN`·`DOCUMENT_ENCRYPTED`·`PDF_ERROR`·`OCR_ERROR` 등). **엑셀 테이블데이터**: 첫 시트 표 1개를 범위·헤더·데이터 타입으로 정의해 DB화(Table Agent 앱용).
- **연동**: SharePoint·Google Drive·Box·Confluence — 조직 관리자 계정 OAuth, 폴더 구조·권한 보존, 3단계 동기화(파일 → 권한 → 매핑), **자동 실행은 매일 자정 1회**, 지금 실행, 해제.
- **리트리버 최적화**: 질문·파일명·쪽 번호 데이터셋 업로드 → **담당 PM이 2~3영업일 수작업**, 전후 정확도 리포트. 자동 서비스가 아니다.
- **워크플로우(한국어 가이드)**: Agent Builder 에이전트를 **스케줄(시작 시각·빈도)** 또는 **Webhook**(멤버 토큰 인증)으로 자동 실행, 필드(인수)·트리거·액션 구성.
- **공지사항**: 대시보드 Draft → Published, Works 알림 패널.
- **SDK**: `sdk.alli.ai/2/alli.esm.min.js`, `sdkKey`·placement·user variables. **API 참조** 항목: Authentication(API 키·유저 ID·이메일·비ASCII 제한·에이전트 정보)·Error Handling·User Management·Knowledge Base·RAG·App Market·Conversations·FAQs·MRC·Hashtags·Others·Models.
- **What's new**에서 날짜가 붙은 것: 앱별 접근 권한 2024-10, 폴더 권한·맵/맵-리듀스 2024-11, 멤버 그룹·답변형 실행 기록(문서 표기 2/14/2024, 순서상 2025로 보임), Enterprise Works·SAML·취소 2025-04, 크레딧 한도·N:M 그룹 2025-06, 딥 리서치·SharePoint·**즐겨찾기(Enterprise Works 한정)** 2025-08.

## 4. Coworker 공개 포털(정적 관찰)

`https://ai-coworker.alli.ai/portal/landing`. 제목 "Alli Coworker — Enterprise AI Dev and Ops Platform". REA 번들 분석(ev_7e5d…)이 fetch 인자로 낸 경로: `/auth/sessions`·`/auth/logout`·`/auth/alli/handoff`·`/auth/email/login`·`/auth/magic-link/send`·`/auth/sso/discover`·`/auth/sso/verify-code`·`/auth/local-bypass`·`/api/demo-request`, URL 매개변수 `code`·`state`·`installation_id`·`setup_action`·`tenant_id`·`return_to`·`team`.

받은 번들(`index-BjKaub0B.js`, 3.5MB)의 템플릿 문자열(셸 `grep`): 화면 경로 `/portal/login`·`/portal/admin/connectors`·`/apps/:tenantId/:projectId`·`/approvals/:tenantId/:approvalId`·`/agents`; API `/api/admin/{sso/connections,groups,members(/upload,/download),branding,approvals,notices,visibility,settings}`·`/api/approvals/{outbox,notifications}`·`/api/apps/{starred,creators}`·`/api/templates(/config)`·`/api/skills`·`/api/documents/{ask,highlight,folders,move,connection,settings}`·`/api/identity/{settings,reconcile(/preview)}`·`/api/billing/{subscription/*,checkout,balance,monthly_credit_cap,me/usage,payment_method/*}`·`/auth/slack/install`·`/auth/saml/login/`·`/oauth/{start,callback}`. 낱말 빈도: approval 437·agent 460·mcp 289·skill 278·tenant_id 194·github 175·schedule 109·slack 84·teams 65.

해석(추론): Coworker는 **테넌트/프로젝트 단위 앱·승인함·커넥터 관리·스킬·템플릿·셀프 결제(크레딧 상한)**를 가진 별도 제품이다. 문자열이 있다는 것이 기능이 열려 있다는 뜻은 아니며, 서버 응답·권한·실제 동작은 미확인이다. `/auth/local-bypass`는 개발용 경로로 보이지만 동작은 모른다.

## 5. 한국어 Works 제품 페이지의 주장(공급자 주장)

"100+ 에이전트", "100만 행 엑셀, 분산 처리로 빠짐없이 완결", "원본 레이아웃에 그대로 근거", "드래그 앤 드롭 빌더", "팀 바로 배포", "사내 문서 연결", "자동 분류·태깅", "문서 간 관계 구성", "문서 시각 프리뷰", "SaaS와 온프레미스, 하나의 코드베이스", "4단계 워크플로우 생성 완료"(샘플 화면). 재현 시험을 하지 않았으므로 성능 수치로 옮기지 않는다.

## 6. WORKON에 반영할 차이(현재 코드 기준, 2026-10-31 작업 트리)

| 항목 | 알리웍스(문서 확인) | WORKON 지금 | 판단 |
|---|---|---|---|
| 입력형 앱 입력 | 6종(3종 확정: 문서·문단 텍스트·단일 선택), 지식베이스 문서 선택 | 5종(짧은 글·긴 글·숫자·날짜·목록 선택) + 파일 입력 3개 | '지식베이스 문서 선택' 입력이 없다 — 비서 문서함에서 고르는 입력은 후보 |
| 긴 입력 처리 | 분할 없음/맵/맵-리듀스 선택 | 추출 자료 합계 20,000자에서 거절 | 큰 파일은 거절이 아니라 처리 방식을 고르게 할지 결정 필요(분할 결과의 검증 계약 먼저) |
| 단계·조건 | 노드 그래프, 조건은 옵션 순서·AND | 1~3 순차 단계, 선택값 equals 조건 | 그래프 편집기는 그대로 범위 밖. 조건 유형(포함·비교)·AND 묶음은 작은 확장 |
| 결정적 외부 호출 | 연동 노드(REST)·MCP 노드(툴 1개 고정) | 공공 커넥터 4종(모델이 고름) | '고정 호출' 단계가 없다 — 승인된 커넥터의 고정 호출 단계는 후보 |
| 예약·Webhook | 워크플로우 메뉴(한국어 가이드) | 없음(내부 작업자 cron만) | 공백 확정. 설계는 CURRENT_GAPS의 조건 유지 |
| 앱 공개 승인 | 승인자 지정·승인/반려(제한 제공) | 공식 비서 승인(approval_status)만, 입력형 앱은 개인/부서 저장 | 부서 앱의 공개 승인은 기존 비서 승인 흐름 재사용 가능 |
| 앱별 권한 | Viewer/Editor + 그룹 | visibility·tier·canUseAgent | 그룹 단위 지정이 없다(부서 계층으로 대신) |
| 사용 기록 | 답변형 실행마다 입력·문서·결과·상태·프롬프트·옵션 | `/apps/history`(최근 응답 요약, 원문 비노출) | 운영자용 실행 기록(입력·결과·실패 원인) 화면은 아직 없다 |
| 크레딧 한도 | 월 한도 + 80/90/100% 메일 | 연간 정액 예산 80% 경고·100% 차단 | 메일 알림 없음 |
| 문서 연동 | Drive·SharePoint·Box·Confluence, 권한 동기화, 매일 1회 | 없음 | 공백 확정 |
| 엑셀 표 | 첫 시트 표 1개를 스키마로 정의해 DB화 | 표 엔진이 병합·단위·합계 행을 다루고 프로그램이 계산 | 접근이 다르다. 우리 쪽은 계산 정확성, 저쪽은 질의 범용성. 성능 비교 안 함 |
| 검색 품질 운영 | 리트리버 최적화(사람이 2~3일) | NODA 유사도 하한 0.80·rag-test | 배치 평가 세트는 둘 다 사람이 만든다 |
| 가드레일 | 키워드·정규식·AI 3종 | 금지어·개인정보 패턴 | AI 분류 가드레일 없음 |
| SSO | SAML(Google·Entra·Okta) + 그룹 매핑 | Credentials | 공백 확정 |

## 7. 미확인·실패

- 분류 체크박스 단독(Legal) 결과: Playwright locator가 label 9개에 걸려 두 번 실패했다. 재현하려면 `label >> nth=N`이나 접근성 이름(`checkbox "Legal"`) locator로 다시 돈다.
- 답변형 앱 입력 6종 중 3종의 이름.
- 인증된 Works·Coworker의 실제 앱 실행·복제·배포·권한·예약·실패 복구·파일 생성. 서버 구현 전부.
- Works 로그인 화면(`works.alli.ai`로 추정 — What's new 2025-06 경로 변경 언급)은 공개 페이지 링크에 없어 번들을 받지 않았다.
- 관찰 창 밖의 통신, 다른 탭, 스토리지 값·헤더 값·본문은 수집하지 않았다.

재현: 헤드리스 Edge를 `--remote-debugging-port=9333 --user-data-dir=<임시>`로 띄우고 `PUT /json/new?<url>`로 탭을 연 뒤 REA `list_browser_targets` → `inspect_web_page`/`capture_browser_scenario`(connect 모드) → `export_evidence_bundle`. 끝나면 브라우저를 닫는다.
