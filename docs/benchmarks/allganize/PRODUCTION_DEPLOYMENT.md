# 운영 배포: 업무 앱 중심 첫 화면

## 주의: GitHub 연동 — `main` 푸시가 곧 운영 배포다

- 2026-11-02 14:xx KST `feat/s6-1-currentize`를 푸시하고 `main`을 같은 커밋으로 fast-forward 푸시했더니 Vercel GitHub 연동이 **`main` 푸시마다 Production 배포를 만들어 Ready가 되면 운영 주소에 자동으로 붙였다**(`dpl_BYYmTTAhuh9fa232L7yES54RyogA`, 56205e4 — 바로 전 CLI 배포와 같은 코드 + 문서 커밋. 가지 푸시는 Preview 빌드). 그 전까지 운영은 CLI `--skip-domain` 빌드 → promote로만 올렸고 `main`은 10-30에 멈춰 있어 이 길이 잠들어 있었다.
- 그래서 앞으로 **`main`에 올리는 것 = 운영 배포**다. 운영 DB 마이그레이션이 먼저여야 하는 커밋은 적용 전에 `main`에 올리지 않는다. 커밋 메시지의 `[vercel skip]`은 **이 프로젝트에서 빌드를 막지 못했다**(6cc3e23을 푸시하자 Production 빌드가 또 잡혔다) — 문서만 고친 푸시도 운영을 같은 코드로 다시 배포한다는 뜻이니, 빌드를 피하려면 Vercel 프로젝트 설정의 Ignored Build Step을 따로 걸어야 한다. CLI promote 방식도 그대로 쓸 수 있다(둘 다 같은 운영 주소를 바꾼다 — 나중 것이 이긴다).

## 2026-11-06(아침): 원문에서 보기·대화 입력 필터 고침

- 2026-11-06 08:32 KST 배포 `dpl_UWCH75NDrx4mKisQqPUtPJKeHNc9`(커밋 `59a9585`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영"). 되돌릴 때는 직전 `dpl_7kFNkPGYU3HvUWfoVAjJqrk2Xebc`(0b01ddb)로 promote한다. 마이그레이션 없음.
- 들어간 커밋(5개): `0a64b40`(직전 배포 기록), `7e86bb1` 근거 창 '원문에서 보기'(원본을 글로 다시 읽어 근거 자리 강조, 스캔 PDF 제외), `804b385` 필터 — **한글 금지어를 한 번도 잡지 못하던 결함**·특수 글자 금지어로 검사가 깨지던 결함·단위 붙은 큰 금액(예산 150000000원)이 계좌번호로 막히던 오탐, `ef052f9` 사무실·대표 전화번호와 이메일은 막지 않음(사용자 결정 — 휴대전화·주민등록번호·카드·계좌번호 꼴은 계속 막음), `59a9585` 금지어 맞추기 규칙 한 곳(`forbidden-match.ts`).
- **배포 전**: 가지 Preview(`59a9585`, `workon-485jgu6mm`) Ready를 확인한 뒤 `main`에 올렸다(그 전에 전체 시험 2,815개·tsc 0).
- 배포 뒤 확인(로그인 없이, 운영 주소): `/login`·`/api/system/maintenance` 200, `GET /api/documents/[id]/text`·`GET /api/common-documents/[id]/text`·`POST /api/chat` 401.
- **알아 둘 것**: 이 배포부터 관리자가 등록해 둔 **한글 금지어가 실제로 걸린다**(전에는 등록만 되고 걸리지 않았다) — 예전에 넣어 둔 금지어가 있으면 그 낱말이 든 질문이 거절되기 시작한다. 반대로 사무실 번호·이메일이 든 질문은 이제 통과한다.
- **확인하지 못한 것**(사용자 몫): 로그인한 대화에서 '원문에서 보기'의 근거 강조, 등록한 한글 금지어가 든 질문의 거절, 사무실 번호·메일이 든 질문 통과.

## 2026-11-06(새벽): 지난 파일·이어지는 질문·답변 평가·부서별 도입 현황·완료 시간·공식 앱 신청·반복 단계(0064~0066)

- 2026-11-06 01:17 KST 배포 `dpl_7kFNkPGYU3HvUWfoVAjJqrk2Xebc`(커밋 `0b01ddb`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영"). 되돌릴 때는 직전 `dpl_9j3pMNLWLi99bsn7KpTC78S1uLJg`(ee11d03)로 promote한다 — **0064~0066은 되돌리지 않는다**(표·함수 추가와 같은 이름 함수 다시 정의뿐 — 옛 코드는 새 표·칸을 읽지 않는다).
- 들어간 커밋(8개): `681dc5f`(직전 배포 기록), `acdcc66` 대화 '지난 파일' 다시 붙이기, `1ce267a` 이어지는 짧은 질문은 앞 질문과 묶어 한 번 더 찾기, `1f1f614` 답변 평가(0064), `b85887d` 부서별 도입 현황(0065), `9e189ff` 앱 빌더 공식 앱 신청, `981f953` 도입 현황 완료까지 걸린 시간(0066), `0b01ddb` 앱 반복 단계([조건 문서](CONDITIONAL_APP_STEPS.md)·[도입 현황](ADOPTION_REPORT.md)).
- **배포 전**: 운영 DB에 0064~0066이 없음을 읽기 전용으로 확인한 뒤 차례로 적용(`db:migrate -- 0064` … `-- 0066`, 모두 OK). 다시 읽기 전용 확인: `message_feedback` 표·외래 키·CHECK 셋(평가·이유·이유는 아쉬움에만)·RLS 켜짐·권한 service_role만, `adoption_by_department` 함수 하나(anon 거짓·service_role 참, 한 기관 부르기 1줄), `adoption_report`가 `completed_median_hours`를 포함(칸 16개, 이번 달 완료 작업 없어 null). 가지 Preview(`0b01ddb`, `workon-4mckexkgh`) Ready를 확인한 뒤 `main`에 올렸다(그 전에 전체 시험 2,795개·tsc 0).
- 배포 뒤 확인(로그인 없이, 운영 주소): `/login`·`/api/system/maintenance`·`/apps/builder` 200, `GET /api/attachments/reusable`·`POST /api/attachments/reuse`·`PUT /api/messages/[id]/feedback` 401, `GET /api/admin/feedback-summary`·`GET /api/admin/adoption-report/departments`·`GET /api/admin/adoption-report` 403.
- **확인하지 못한 것**(사용자 몫): 로그인한 대화에서 '지난 파일' 다시 붙이기·짧은 후속 질문의 근거·답변 '도움됨/아쉬움', 관리자 통계의 답변 평가 표·부서별 보기·완료 시간 줄, 앱 빌더의 공식 앱 신청·반복 단계를 둔 앱 실제 실행.

## 2026-11-05(밤 2): 근거 창 원본 열기·앱 분류 단계

- 2026-11-05 22:52 KST 배포 `dpl_9j3pMNLWLi99bsn7KpTC78S1uLJg`(커밋 `ee11d03`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영"). 되돌릴 때는 직전 `dpl_8WE2so5EPQFsib27LF9PpfNBqAVH`(6ed909c)로 promote한다. 마이그레이션 없음.
- 들어간 커밋: `3592c3c`(직전 배포 기록), `55aba8c` 대화 근거 창 '원본 열기'(볼 수 있는 문서·쓸 수 있는 비서·같은 기관 유형만, 60초 서명 주소, PDF는 그 쪽), `ee11d03` 입력형 앱 분류 단계(뒤 단계 조건·갈래가 `@N`으로 가름 — [조건 문서](CONDITIONAL_APP_STEPS.md)).
- **배포 전**: 가지 Preview(`ee11d03`, `workon-qqmfm4cuv`) Ready를 확인한 뒤 `main`에 올렸다(그 전에 전체 시험 2,743개·tsc 0).
- 배포 뒤 확인(로그인 없이, 운영 주소): `/login`·`/api/system/maintenance`·`/apps/builder` 200, `GET /api/documents/[id]/original?page=3`·`GET /api/common-documents/[id]/original`·`GET /api/documents/tag-vocabulary` 401.
- **확인하지 못한 것**(사용자 몫): 로그인한 대화에서 근거 창 '원본에서 p.N 열기'(PDF가 그 쪽으로 열리는지·HWPX가 원래 이름으로 내려받아지는지), 빌더에서 분류 단계를 둔 앱을 만들어 실제 모델로 실행(분류 정확도는 재지 않았다).

## 2026-11-05(밤): 문서 태그·태그 분류표·평가 세트·앱 문서함 문서(0059~0063)

- 2026-11-05 22:25 KST 배포 `dpl_8WE2so5EPQFsib27LF9PpfNBqAVH`(커밋 `6ed909c`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영"). 되돌릴 때는 직전 `dpl_4AFuMXsF6zi4dVQ3XBkN3DdsK9k4`(56d20a2)로 promote한다 — **0059~0063은 되돌리지 않는다**(표·칸·CHECK 추가뿐, 옛 코드는 새 표·칸을 읽지 않는다).
- 들어간 커밋(8개): `0bc9384`(직전 배포 기록), `89ed69f` 앱 긴 첨부 맵-리듀스, `67b50bf` 일괄 평가 세트 보관(0059, [일괄 평가](RAG_EVAL.md)), `fc67533` 입력형 앱 '문서함에서 고르기', `41c4942` 비서 문서 태그·문서 목록 찾기·거르기(0060), `aaf8fb3` AI 태그 초안, `b11fef6` 기관 태그 분류표(0061)·여러 문서 AI 초안([문서 태그](DOCUMENT_TAGS.md)), `4918c49` 앱 예약·연동에 문서함 문서(0062·0063, [예약](APP_SCHEDULES.md)·[연동](APP_WEBHOOKS.md)), `6ed909c` 문서.
- **배포 전**: 운영 DB에 0059~0063이 하나도 없음을 읽기 전용으로 확인한 뒤 차례로 적용(`db:migrate -- 0059` … `-- 0063`, 모두 OK). 다시 읽기 전용 확인: `rag_eval_sets`·`document_tag_vocabularies` 표와 CHECK, 두 표 RLS 켜짐·권한은 service_role만, `documents.tags`·`app_schedules.document_ids`·`app_webhooks.document_ids` 칸 NOT NULL·기본 빈 배열·개수 CHECK, 기존 문서 3개(태그 0)·예약 0·연동 0, 세 칸을 select 할 수 있음. **0060·0062·0063은 목록이 select 하므로 코드보다 먼저 넣었다.** 가지 Preview(`6ed909c`, `workon-1yxr1hz13`) Ready를 확인한 뒤 `main`에 올렸다(그 전에 전체 시험 2,720개·tsc 0).
- 배포 뒤 확인(로그인 없이, 운영 주소): `/login`·`/api/system/maintenance` 200, `GET /api/documents/tag-vocabulary`·`PATCH /api/documents/[id]`·`GET /api/apps/schedules`·`GET /api/apps/webhooks`·`POST /api/apps/webhook` 401, `PUT /api/documents/tag-vocabulary`·`GET /api/admin/rag-eval/sets` 403(관리자 검사가 먼저 — 다른 관리자 라우트와 같은 꼴).
- **확인하지 못한 것**(사용자 몫): 로그인한 문서 화면에서 태그 붙이기·찾기·분류표 정하기·AI 초안(한 문서·여러 문서 — 모델 사용량이 기록된다), 일괄 평가 세트 저장, 문서함 문서를 고른 앱 실행·예약·연동 만들기. 운영에는 아직 태그·예약·연동이 하나도 없다.

## 2026-11-05(오후 2): 신구대비표 한글(HWPX)

- 2026-11-05 오후 배포 `dpl_4AFuMXsF6zi4dVQ3XBkN3DdsK9k4`(커밋 `56d20a2`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영"). 되돌릴 때는 직전 `dpl_B1S3CmtpuV4mgHVDc5Z8NkmbyveK`(911f69a)로 promote한다. 마이그레이션 없음.
- 들어간 커밋: `7ab1f99`(직전 배포 기록), `56d20a2` 신구대비표 한글 내려받기 — 개정 쪽 밑줄·현행 쪽 취소선, 표 넣기의 칸 조각·열 폭 비율, `next.config.mjs` 배포 묶음에 표준 양식(`/api/documents/**`·`/api/super/common-documents/**`) ([문서 판](DOCUMENT_EDITIONS.md)).
- **배포 전**: 가지 Preview(`56d20a2`, `workon-5q6fp7rkq`) Ready — 바뀐 `next.config.mjs`로 빌드가 통과함을 확인한 뒤 `main`에 올렸다(그 전에 전체 시험 2,542개·tsc 0, 한글 2018에서 샘플 신구대비표 열기·다시 저장·PDF).
- 배포 뒤 확인(로그인 없이): `/login`·`/api/system/maintenance` 200, `GET /api/documents/[id]/compare?format=hwpx`·`?format=xlsx`·`GET /api/super/common-documents/[id]/compare?format=hwpx`·`GET /api/documents` 401, `POST /api/rag-test` 403.
- **확인하지 못한 것**(사용자 몫): 로그인한 화면에서 '신구대비표 한글'을 실제로 내려받아 한글로 열기 — 운영 함수 묶음에 표준 양식이 들어갔는지는 이것으로만 확인된다(없으면 503 '기본 한글 양식이 준비되지 않았습니다').

## 2026-11-05(오후): 사용 기록 행 상한(0057·0058)·문서 판 시행일·두 판 비교·적용 기준일 판 고르기

- 2026-11-05 오후 배포 `dpl_B1S3CmtpuV4mgHVDc5Z8NkmbyveK`(커밋 `911f69a`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영"). 되돌릴 때는 직전 `dpl_C31cvHGWgodnnCvNiWWjmTLjGN7m`(ccc5a6f)로 promote한다 — **0057·0058은 되돌리지 않는다**(함수·색인 추가뿐, 옛 코드는 부르지 않는다).
- 들어간 커밋(10개): `b356f60`(직전 배포 기록), `1f518eb` API 1,000행 상한 — 한도 판정 DB 함수·쪽 읽기(0057, [1,000행 상한](USAGE_ROW_CAP.md)), `8ea3241` 비서 문서 새 판의 시행일 예약, `e40fbc6` 일괄 평가가 대화와 똑같이 찾기·세트 다시 쓰기, `0b29eaa` 이용통계를 DB에서 묶기(0058), `221c0d5` 두 판 신구 대비, `4767c78` 신구대비표 엑셀·번호 제목 위치, `71369a4` 공통 자료실 두 판 비교, `5ebe33b` 규정 확인의 적용 기준일 판 고르기, `911f69a` 단건 검색 시험도 대화와 같은 찾기([문서 판](DOCUMENT_EDITIONS.md)·[일괄 평가](RAG_EVAL.md)).
- **배포 전**: 0057은 사용자가 오전에, 0058은 낮에 운영 DB에 적용해 두었다. 배포 직전 읽기 전용으로 다시 확인: `organization_chat_tokens`·`usage_summary` 함수 각 하나, `documents.replaces_id`·`effective_from`, `common_documents.replaces_id`·`storage_path` 칸 있음. 가지 Preview(`911f69a`, `workon-l0cyxzo3u`) Ready를 확인한 뒤 `main`에 올렸다(그 전에 전체 시험 2,530개·tsc 0, 업무 흐름 시험은 시험 DB로 41개).
- 배포 뒤 확인(로그인 없이, 운영 주소): `/login`·`/api/system/maintenance` 200, 새 라우트 `GET /api/documents/[id]/compare`(`?format=xlsx` 포함)·`GET /api/super/common-documents/[id]/compare` 401, `GET /api/admin/usage-summary`·`POST /api/rag-test`·`GET /api/admin/rag-eval` 403.
- **확인하지 못한 것**(사용자 몫): 로그인한 관리자 화면에서 이용통계 세 축·문서 화면 '옛 판과 비교'·신구대비표 엑셀 내려받기·검색 시험의 [공통] 표시, 슈퍼관리자 공통 자료실 '옛 판과 비교', 시행일을 예약한 새 판으로 대화·규정 확인. 운영에는 바꾼 옛 판이 있는 문서가 아직 없을 수 있다.

## 2026-11-05(새벽): 월별 도입 현황 보고서(0056)

- 2026-11-05 00:00 KST쯤 배포 `dpl_C31cvHGWgodnnCvNiWWjmTLjGN7m`(커밋 `ccc5a6f`, `main` fast-forward — GitHub 연동). 사용자 선택("0056 반영해줘"). 되돌릴 때는 직전 `dpl_FpeEx9eUqFb1nUcesfE9hFe9Jt6P`(b8e72a9)로 promote한다 — **0056은 되돌리지 않는다**(함수 추가뿐).
- 들어간 커밋: `90c4882`(직전 배포 기록), `ccc5a6f` 월별 도입 현황 보고서([도입 현황](ADOPTION_REPORT.md)).
- **배포 전**: 운영 DB에 0056 적용(`db:migrate -- 0056`). 읽기 전용 확인: `adoption_report` 함수 하나, 실행 권한 anon·authenticated 거짓·service_role 참, 두 기관에 11월을 불러 15개 칸이 모두 나옴(각 60ms 안). 가지 Preview(`ccc5a6f`, `workon-e4rwcea2j`) Ready를 확인한 뒤 `main`에 올렸다(그 전에 전체 시험 2,441개·tsc 0).
- 배포 뒤 확인: `/admin/stats` 로그인 없이 307, `/apps` 200, 관리자 세션 없는 `GET /api/admin/adoption-report`(달 있음·없음) 403, 예약 실행기 pg_cron 배포 뒤에도 200.
- **확인하지 못한 것**: 로그인한 관리자 통계 화면에서 보고서 표·CSV 내려받기(사용자 몫).

## 2026-11-04(밤 4): 비서 문서의 판(개정본) 관리(0055)

- 2026-11-04 23:40 KST쯤 배포 `dpl_FpeEx9eUqFb1nUcesfE9hFe9Jt6P`(커밋 `b8e72a9`, `main` fast-forward — GitHub 연동). 사용자 선택("운영 반영"). 되돌릴 때는 직전 `dpl_2MnuNeVvVmYpf7BaApBLm9pjLo1h`(6307a5c)로 promote한다 — **0055는 되돌리지 않는다**(칸·CHECK 추가, 옛 코드는 새 칸을 읽지 않고 `retired` 행도 없다).
- 들어간 커밋: `ce6e7a2`(직전 배포 기록), `b8e72a9` 비서 문서의 판 관리([문서 판](DOCUMENT_EDITIONS.md)).
- **배포 전**: 운영 DB에 0055 적용(`db:migrate -- 0055`). 읽기 전용 확인: 칸 셋(`replaces_id` uuid·`retired_at`·`effective_from` date), CHECK 셋(`documents_noda_status_check`에 `retired`·`documents_replaces_not_self`·`documents_retired_pair`), 기존 문서 3개(모두 ready) 그대로, 문서 찾기·목록과 같은 칸 묶음 select 됨. **칸이 없으면 문서 있는 비서의 대화가 막히므로 코드보다 먼저 넣었다.** 가지 Preview(`b8e72a9`, `workon-bi7q5083w`) Ready를 확인한 뒤 `main`에 올렸다(그 전에 전체 시험 2,433개·tsc 0).
- 배포 뒤 확인: `/admin/documents` 로그인 없이 307, `/apps` 200, 로그인 없는 `GET /api/documents`·`POST /api/documents/confirm` 401·`POST /api/documents/assign` 403(관리자 검사 — 전과 같음), 예약 실행기 pg_cron 배포 뒤에도 200.
- **확인하지 못한 것**: 로그인한 문서 화면에서 개정본을 '바꿀 옛 판'으로 올려 실제 NODA 읽기 → 옛 판 지난 판 → 대화가 새 판만 근거로 쓰는지(사용자 몫).

## 2026-11-04(밤 3): 문서 찾기 일괄 평가(0054)

- 2026-11-04 22:50 KST쯤 배포 `dpl_2MnuNeVvVmYpf7BaApBLm9pjLo1h`(커밋 `6307a5c`, `main` fast-forward — GitHub 연동). 사용자 선택("운영 반영"). 되돌릴 때는 직전 `dpl_3xfVqFGsFbZAj7HyZz8gyoP1vt1X`(6659a95)로 promote한다 — **0054는 되돌리지 않는다**(표 추가뿐, 옛 코드는 쓰지 않음).
- 들어간 커밋: `ed120e2`(직전 배포 기록), `6307a5c` 문서 찾기 일괄 평가([일괄 평가](RAG_EVAL.md)).
- **배포 전**: 운영 DB에 0054 적용(`db:migrate -- 0054`). 읽기 전용 확인: `rag_eval_runs` 칸 10개·CHECK 4개·RLS 켜짐, anon·authenticated는 읽기·쓰기 권한 없음, service_role만 있음, 색인 둘. 가지 Preview(`6307a5c`, `workon-8lcor95dg`) Ready를 확인한 뒤 `main`에 올렸다(그 전에 전체 시험 2,421개·tsc 0).
- 배포 뒤 확인: `/admin/documents` 로그인 없이 307, `/apps` 200, 관리자 세션 없는 `GET`·`POST /api/admin/rag-eval` 403(단건 검색 시험과 같은 꼴), 예약 실행기 pg_cron 배포 뒤에도 200.
- **확인하지 못한 것**: 로그인한 관리자 화면에서 세트를 붙여 실제 NODA로 평가 한 번(평가 기록이 운영 DB에 남는다 — 사용자 몫).

## 2026-11-04(밤 2): 입력형 앱 시험 판·배포(0053)

- 2026-11-04 22:25 KST쯤 배포 `dpl_3xfVqFGsFbZAj7HyZz8gyoP1vt1X`(커밋 `6659a95`, `main` fast-forward — GitHub 연동). 사용자 선택("운영 반영").
- 되돌릴 때는 직전 `dpl_ExPiSLnpY5PgnBfiGqVfpcPf4HJW`(f0db3e4)로 promote한다. **0053은 되돌리지 않는다** — 칸 추가뿐이고 옛 코드는 이 칸을 읽지 않는다.
- 들어간 커밋: `bbd9312`(직전 배포 기록), `6659a95` 부서·공식 입력형 앱의 시험 판([시험 판](APP_DRAFTS.md)).
- **배포 전**: 운영 DB에 0053을 적용했다(`db:migrate -- 0053`). 읽기 전용으로 확인한 것:
  - `agents.app_draft` jsonb 칸이 있다.
  - `agents_app_draft_shape` CHECK가 COALESCE 꼴로 들어갔다.
  - 비서 42개 중 시험 판이 있는 것은 0개다.
  - 대화 실행기와 같은 칸 묶음(`… app_definition, app_draft`)을 select 하면 된다. **이 칸이 없으면 모든 대화가 멈추므로 코드보다 먼저 넣었다.**
  - 가지 Preview(`6659a95`, `workon-gfg0xrn78`) Ready를 확인한 뒤 `main`에 올렸다. 그 전에 전체 시험 2,408개를 통과했고 tsc는 0이었다.
- 배포 뒤 확인:
  - 화면: `/apps`·`/apps/builder`·`/apps/run?…&draft=1` 200.
  - 로그인 없는 요청: `/api/agents`·`/api/chat`(POST)·`PUT /api/agents/[id]/app-draft` 401. `GET …/app-draft`는 처리기가 없어 405.
  - 예약 실행기 pg_cron은 배포 뒤에도 13:24·13:25·13:26(UTC) 모두 200.
- **확인하지 못한 것**:
  - 로그인한 빌더에서 시험 판 저장 → 시험 실행 → 배포 → 버리기.
  - 운영에서 실제 대화 한 번(로그인 필요). 대화가 새 칸을 읽는 길은 위 select로만 확인했다.

## 2026-11-04(밤): 앱 공공 데이터 조회 단계·법령 본문·개인 월 한도 알림(0052)

- 2026-11-04 21:30 KST쯤 배포 `dpl_ExPiSLnpY5PgnBfiGqVfpcPf4HJW`(커밋 `f0db3e4`, `main` fast-forward — GitHub 연동). 사용자 선택("운영에 올려줘"). 되돌릴 때는 직전 `dpl_HbUow4tgdQ8sS45SrEP8K4CnhL6d`(dfb8c95)로 promote한다 — **0052는 되돌리지 않는다**(CHECK를 넓히고 함수를 더했을 뿐, 옛 코드는 둘을 쓰지 않는다).
- 들어간 커밋
  - `60e8f43`: 직전 배포 기록
  - `9c2337d`: 입력형 앱 중간 단계의 공공 데이터 조회 — 법령·통계표·입찰공고 검색, 앱 전용 법령·자치법규 본문([조회 단계](APP_LOOKUP_STEPS.md))
  - `f0db3e4`: 개인 월 한도 알림 메일(0052, [예산 알림](BUDGET_ALERTS.md))
- **배포 전**: 운영 DB에 0052 적용(`db:migrate -- 0052`). 읽기 전용으로 확인했다.
  - `budget_alerts_subject_check`·`budget_alerts_kind_check`가 `user:{id}`·`user_monthly`를 받는다.
  - `organization_user_budget_usage`는 하나뿐이고, 실행 권한은 anon·authenticated 거짓, service_role 참이다.
  - 함수를 두 기관 모두에 불러 보니 돈다. **개인 한도가 있는 직원은 지금 0명**이라 다음 예산 알림(11-05 09:00 KST)에 개인 메일은 가지 않는다.
- 가지 Preview(`f0db3e4`, `workon-e7egqjhb1`) Ready를 먼저 확인했다. Vercel 빌드가 `next build`다. 로컬 `next build`는 이번에 돌리지 않았다.
- 그 전에 확인한 것
  - 전체 시험 2,393개 통과, tsc 0.
  - 첫 커밋 `9c2337d`만 따로 둔 임시 작업 폴더에서 tsc 0, 관련 시험 105개 통과.
- 배포 뒤 확인
  - `/apps`·`/apps/builder`·`/my/stats` 200.
  - 로그인 없는 `/api/connectors` 401, `/api/cron/budget-alerts`·`/api/cron/app-schedules` 비밀값 없이 401.
  - 운영 실행기 도장 12:35:00Z, `net._http_response` 최근 4번 모두 200.
- **확인하지 못한 것**
  - 로그인한 빌더 화면에서 처리 방식·조회어·조문 칸 고르기와 실제 조회 실행. 앱 능력 범위는 그 기관이 공식 비서에서 쓰는 공공 데이터에 달려 있다.
  - 개인 한도 메일의 실제 발송. 한도가 있는 직원이 없다.
  - 법제처 호출은 로컬에서 읽기 전용 3건만 확인했다.

## 2026-11-04: 앱 예약 실행기 멈춤 감지·단계 조건 또는(OR)

- 2026-11-04 17:00 KST쯤 배포 `dpl_HbUow4tgdQ8sS45SrEP8K4CnhL6d`(커밋 `dfb8c95`, `main` fast-forward — GitHub 연동). 사용자 선택("운영 반영"). 되돌릴 때는 직전 `dpl_4cmoK59Heat6g1FTzD1t7r2CppVW`(3deae59)로 promote한다. **마이그레이션 없음**.
- 들어간 커밋: `0fefb79`·`8cc6824`(배포·실측 기록), `42e0410` 실행기 멈춤 감지(실행기 도장 + 하루 한 번 Vercel 점검·운영 기록 critical·슈퍼관리자 메일, 관리자 화면 실행기 상태·지연), `dfb8c95` 단계·갈래 조건 `{ any }`.
- 가지 Preview(`dfb8c95`) Ready를 먼저 확인했고, 그 전에 로컬 `next build`·전체 시험(141파일 2,440개)·tsc 0.
- 배포 뒤 확인: `/apps/builder`·`/apps/schedules` 200, `/admin/app-automations` 로그인 없이 307, 로그인 없는 `GET /api/admin/app-automations` 401, `/api/cron/app-schedules`·`/api/cron/budget-alerts` 비밀값 없이 401. **운영 DB에 실행기 도장 `app_schedules_runner_heartbeat` = 2026-11-04T08:00:01Z**(배포 뒤 첫 pg_cron 호출이 찍음), `net._http_response` 최근 3번 200. 켜진 예약 0개라 첫 하루 점검(11-05 09:00 KST)은 문제 없음으로 끝나야 한다.
- **확인하지 못한 것**: 점검이 실제로 문제를 찾아 메일을 보내는 경로(운영에서 일부러 멈추지 않음 — 시험으로만), 빌더의 '또는' 고르기 화면.

## 2026-11-03(밤): 앱 예약·연동 관리자 통제(0050)·연동 재시도 중복 막기(0051)

- 2026-11-03 21:15 KST쯤 배포 `dpl_4cmoK59Heat6g1FTzD1t7r2CppVW`(커밋 `3deae59`, `main` fast-forward — GitHub 연동). 사용자 선택("운영 반영"). 되돌릴 때는 직전 `dpl_GENQ1nia9PBCFKebMwjmefj8a8Ub`(5717be2)로 promote한다 — **0050·0051은 되돌리지 않는다**(칸·표 추가, 차지 함수는 옛 4인자 호출도 받는다).
- 들어간 커밋: `815cdf4`(0049 배포 기록), `922bf2e` 관리자 통제(0050 — `/admin/app-automations`, 연동 회수·예약 멈춤·잠금 풀기, 탈퇴 때 예약 삭제·연동 회수), `3deae59` 연동 `Idempotency-Key`(0051).
- **배포 전**: 운영 DB에 0050·0051 적용(`db:migrate -- 0050`, `-- 0051`). 확인: `app_webhooks.revoked_reason`·`app_schedules.admin_paused_at` 칸과 CHECK 둘, 색인 셋, `app_webhook_calls` RLS 켜짐·anon·authenticated 권한 없음, `app_webhook_claim`은 6인자 하나뿐이고 실행 권한 `service_role`(과 소유자 `postgres`)만, 없는 토큰 해시로 키 없이·키와 함께 부르면 둘 다 `invalid`. **적용 직후 아직 옛 코드(5717be2)가 돌던 운영 주소에 모르는 토큰을 보내 401** — 옛 4인자 호출이 새 함수에서 도는 것을 확인했다. 가지 Preview(`3deae59`) Ready를 확인한 뒤 `main`에 올렸다(로컬 `next build`도 통과).
- 배포 뒤 확인: `/apps/webhooks`·`/apps/schedules` 200, `/admin/app-automations` 로그인 없이 `/login?error=unauthorized`로 307, 로그인 없는 `GET /api/admin/app-automations`·`PATCH …/webhooks/[id]`·`PATCH …/schedules/[id]` 401, `POST /api/apps/webhook` 모르는 토큰 401(키 없이·키와 함께), 꼴이 틀린 `Idempotency-Key` 400, 예약 실행기 비밀값 없이 401. 배포 뒤 pg_cron `workon-app-schedules` 12:20·12:25·12:30(UTC) succeeded·200.
- 같은 날 밤 로컬 시험 Supabase(0051까지)에서 실제 라우트 처리기로 예약·연동 만들기 → 관리자 목록 → 같은 키 다시 보내기(`Idempotent-Replayed`) → 회수 → 멈춤·잠금·풀기를 끝까지 확인했다(`APP_AUTOMATION_ADMIN.md` 검증). **확인하지 못한 것**: 브라우저 화면(이 PC 메모리 부족으로 `next dev`가 죽음), 운영에서 실제 토큰 호출.

## 2026-11-03(저녁): 앱 외부 연동(Webhook, 0049)

- 2026-11-03 17:00 KST쯤 배포 `dpl_GENQ1nia9PBCFKebMwjmefj8a8Ub`(커밋 `5717be2`, `main` fast-forward — GitHub 연동). 사용자 선택("운영 반영"). 되돌릴 때는 직전 `dpl_EWnBZD8kZWjfWsRhUCL6Y4hHTjiU`(273fa40)로 promote한다 — **0049는 되돌리지 않는다**(표·함수 추가뿐).
- **배포 전**: 운영 DB에 0049 적용 — 표(칸 21개)·RLS 켜짐·anon·authenticated 표 권한 없음, `app_webhook_claim` 실행 권한은 `service_role`만(anon·authenticated 거짓), 없는 토큰 해시로 부르면 `invalid`. 가지 Preview(`5717be2`) Ready를 먼저 확인했고, 그 전에 로컬 `next build`도 통과했다.
- 배포 뒤 확인: `/`·`/apps`·`/apps/run`·`/apps/schedules`·`/apps/webhooks` 200, 로그인 없는 `GET /api/apps/webhooks`·`DELETE /api/apps/webhooks/[id]` 401, `POST /api/apps/webhook` 토큰 없음 401·**꼴이 맞는 모르는 토큰 401**(차지 함수가 운영에서 돈다 — 실패면 500), 본문 70KB 413, 예약 실행기 비밀값 없이 401. 예약 실행기 pg_cron은 그때까지 8번 모두 200.
- **확인하지 못한 것**: 로그인 화면에서 연동 만들기·토큰 한 번 표시·회수, 실제 토큰으로 앱을 한 번 실행해 `[연동]` 대화가 생기는지(모델 비용이 들고 직원 계정이 필요 — 사용자 몫).

## 2026-11-03: 단계 갈래·긴 첨부 나눠 읽기·앱 예약 실행(0048)

- 2026-11-03 15:30 KST쯤 배포 `dpl_BHdvNEhXreRn9BvUmqN1Ah65YeHy`(커밋 `ef2bcbe`, GitHub 연동 — `main` fast-forward 푸시). 사용자 선택("운영 반영"). 되돌릴 때는 직전 `dpl_7TaVhjpA6jf8jra6UQkbLdYt8FPe`(fe6fece)로 promote한다 — **0048은 되돌리지 않는다**(표 추가뿐이라 옛 코드와도 맞는다).
- 들어간 커밋: `7734e0b` 단계 갈래, `1c032a7` 긴 첨부 나눠 읽기(마이그레이션 없음), `8e395d5` 앱 예약 실행(0048), `550d9e6`·`ef2bcbe` 빌드 수정.
- **배포 전**: 운영 DB에 0048(`app_schedules`) 적용 — 표·칸 24개·CHECK 10개·색인 3개, RLS 켜짐, anon·authenticated 권한 없음, 행 0을 운영 DB에서 확인. pg_cron에는 그때 `workon-work-worker` 하나뿐이었다.
- **첫 운영 빌드가 실패했다**(`dpl_CDYHSn4k98UzpXDq7kQjA4EmNrug` Error — 운영 주소는 직전 배포 그대로였다). `next build`의 라우트 타입 검사가 `src/app/api/apps/schedules/[id]/route.ts`의 `export const PAUSED_BY_USER`를 "is not a valid Route export field"로 거절했다. 고친 뒤 가지만 푸시한 Preview 빌드도 `src/app/apps/schedules/page.tsx`가 내보낸 도움 함수(`scheduleBadge`) 때문에 실패했다. 두 값을 `src/lib/apps/schedule-spec.ts`로 옮기고, **route·page·layout 파일이 Next.js가 받는 이름 밖의 값을 내보내지 않는지 전수 검사하는 `tests/route-exports.test.ts`** 를 더했다 — `tsc --noEmit`과 vitest는 이 규칙을 보지 않는다. 그 뒤 Preview(`ef2bcbe`) Ready를 확인하고 나서 `main`에 올렸다(앞으로도 새 라우트·화면이 든 묶음은 가지 Preview를 먼저 본다).
- 배포 뒤 확인(운영 주소가 새 배포를 가리킴): `/`·`/apps`·`/apps/schedules`·`/apps/run`·`/apps/history` 200, 로그인 없는 `GET /api/apps/schedules`·`PATCH /api/apps/schedules/[id]` 401, `/api/cron/app-schedules` 비밀값 없음·틀림 401(503이 아니므로 운영에 `CRON_SECRET`이 있다), `/api/cron/budget-alerts` 401.
- **예약 실행기 등록(같은 날 이어서)**: `CRON_SECRET`이 Vercel에만 있고 Vault·`.env.local`에 없어 pg_cron이 실을 수 없었다. 비밀값을 돌리는 대신 실행기가 업무 작업자 비밀값(`WORK_WORKER_SECRET` — Vault `work_worker_secret`, 작업자 작업이 매분 200을 받아 운영 값과 맞음을 확인)도 받게 고쳐(`273fa40`, Preview Ready 확인) `dpl_EWnBZD8kZWjfWsRhUCL6Y4hHTjiU`로 배포했다. 사용자가 Supabase SQL 편집기에서 `workon-app-schedules`(jobid 3, `*/5 * * * *`)를 걸었고, **첫 호출(2026-11-03 16:35 KST)이 `cron.job_run_details` succeeded · `net._http_response` 200 `{ checked: 0, … }`** 로 끝났다.
- **아직 확인하지 못한 것**: 로그인 화면에서 예약 걸기·목록·멈추기, 실제 예약 한 건이 차례에 실행돼 `[예약]` 대화가 생기는지.

## 2026-11-02: 사용자 탈퇴 처리·표 엔진 사람 열(옆 가지 합침)

- 2026-11-02 13:20 KST쯤 배포 `dpl_82VPrkePcwcQYgyMULyhDguAu2Yz`. 사용자 선택("운영 반영")으로 `--skip-domain` 빌드 → Ready → promote. 되돌릴 때는 직전 `dpl_8NSnzYddrnAAJGwcHehPqiofdG4T`로 promote한다 — **단 0047은 되돌리지 않는다**(칸 추가뿐이라 옛 코드와도 맞는다).
- 들어간 커밋: `f63b451`(문서), `3eea05a` 표 엔진 — `(단위: 천원)` 표의 참여자·대상자 등 사람 열에 캡션 천원을 붙이지 않음, `59e349d` 사용자 삭제를 탈퇴 처리로(행은 남기고 로그인·개인 내용만 없앰, 채팅 첨부 저장소까지 정리).
- **배포 전**: 운영 DB에 0047(`users.deleted_at`) 적용 — 칸이 생긴 것을 운영 DB에서 확인(탈퇴 계정 0명·전체 5명). 로그인이 이 칸을 select 하므로 코드보다 먼저여야 했다.
- 배포 뒤 확인(운영 주소가 새 배포를 가리킴): `/`·`/apps`·`/admin/stats` 200, 로그인 없는 `/api/super/accounts/users`·`/api/cron/budget-alerts`·`/api/admin/app-overview` 401, `/api/users` 403(이 라우트는 전부터 권한 검사 문구를 먼저 낸다), 없는 계정의 로그인 시도가 500이 아니라 거절로 끝남.
- **확인하지 못한 것**: 실제 계정 로그인(비밀번호를 쓰지 않음 — 사용자가 한 번 로그인해 보면 `deleted_at` select가 운영에서 도는 것이 확정됨), 슈퍼관리자 화면에서 '계정 삭제'를 실제로 눌러 행이 남고 저장소가 비는지.

## 이전: 조건 확장·예산 알림·관리자 앱 실행 현황·현행화 N1·N2

- 2026-11-02 07:40 KST 배포 `dpl_8NSnzYddrnAAJGwcHehPqiofdG4T`. 사용자 선택("운영 반영")으로 `--skip-domain` 빌드 → Ready → promote. 되돌릴 때는 직전 배포 `dpl_6XBqcsTTXeNDsh5LCfTLtYYouCY2`로 promote한다.
- 들어간 커밋(10-31 배포 뒤 쌓인 것): `2df4e75`·`6707326` 앱 결과 HWPX 내보내기의 마크다운 표 → 실제 한글 표·열 정렬, `784cb02` 단계 조건 AND 3개·입력 종류별 비교, `559a433` 기관·부서 예산 알림 메일, `b936502` 관리자 앱 실행 현황(`/admin/stats`), `9604b88` 현행화 N1·N2.
- **배포 전**: 운영 DB에 0045(`budget_alerts`)·0046(`app_run_states`) 적용 — 표·유일 키·함수·`service_role` 실행 권한을 운영 DB에서 직접 확인했다. Vercel 운영 환경 변수 `CRON_SECRET`(새 무작위 값)·`RESEND_API_KEY`·`MAIL_FROM`(`.env.local` 값)을 넣었다.
  - 첫 빌드는 `CRON_SECRET` 값 끝의 줄바꿈 때문에 실패했다(`console.log … | vercel env add`가 줄바꿈을 그대로 넣음 — Vercel은 헤더 값의 앞뒤 공백을 거절). 셋을 지우고 `printf '%s'`로 다시 넣은 뒤 빌드했다. **파이프로 넣을 때는 줄바꿈을 떼야 한다.**
  - 그 전까지 운영에는 `CRON_SECRET`이 없어 기존 예약 작업 `/api/cron/noda-events`도 매일 503이었다 — 이번부터 401/200으로 돈다.
- 배포 뒤 확인(운영 주소 `workon-ai.vercel.app`이 새 배포를 가리킴): `/`·`/apps`·`/admin/stats` 200, 로그인 없는 `GET /api/cron/budget-alerts`·`/api/cron/noda-events`·`/api/admin/app-overview`와 `POST /api/chat` 401(예약 작업 둘이 503이 아니라 401 — 비밀값이 읽힌다).
- **확인하지 못한 것**: 예약 작업을 실제로 돌려 `budget_alerts` 행이 생기는지(비밀값을 채팅·파일로 꺼내지 않아 직접 부르지 못함 — Vercel 대시보드 Cron Jobs에서 `/api/cron/budget-alerts` Run → 200 확인은 사용자 몫, 매일 09:00 KST 자동 실행), Resend 실제 발송(`MAIL_FROM` 도메인 인증 여부), 로그인 브라우저에서 `/admin/stats` 실행 현황 표·대조 보기의 '이 글로 확인'/'작년 글 그대로 두기' 단추·조건 3개 저장.

## 이전: 결과 내보내기·업무 사용 기록·재개 조건 수정

- 2026-10-31 20:12 KST 배포 `dpl_6XBqcsTTXeNDsh5LCfTLtYYouCY2`. 사용자 요청("배포해줘")으로 `--skip-domain` 빌드 → Ready 확인 → promote. 되돌릴 때는 이전 배포 `dpl_B6mjHofZCHENbH8VtEU7zs5Ni2Gy`로 promote한다.
- 배포 전 확인: 타입 검사 오류 0, 전체 Vitest 116개 파일 2,144개 통과(시험 DB가 필요한 8개 파일 건너뜀 — 앞서 시험 DB로 124개 파일 2,212개 통과), 원격 컴파일·타입 검사·페이지 생성 통과.
- 배포 뒤 확인: `/`·`/apps`·`/apps/builder`·`/apps/run`·`/apps/history` 200, 로그인 없는 `POST /api/chat`·`/api/apps/export`·`/api/work/worker` 401. 운영 화면 코드에 앱 복사 화면과 재개 안내 문구가 들어간 것을 확인했다.
- 들어간 것:
  - 앱 결과 HWPX 내보내기에서 마크다운 기호를 빼고 글·숫자는 그대로 둔다(`src/lib/apps/markdown-text.ts`). 한글 2018 열기·다시 저장 확인.
  - 업무 모델 호출이 응답 형식 오류로 끝나도 쓴 토큰을 `usage_logs`에 `failed: true`로 한 번 남긴다(`runs/shared.ts` `callModel`).
  - 파일 첨부가 켜진 입력형 앱도 그 실행에 파일이 없었으면 멈춘 실행을 이어서 할 수 있다(`apps/resume.ts` `isInputOnlyRun`).
  - 지난 배포 뒤 작업 트리에 있던 **앱 복사해 만들기**(`/apps/builder?copy=`, `src/lib/apps/copy.ts`)가 함께 나갔다. 작업 트리 전체를 배포하는 방식이라 떼어 낼 수 없었다.
- DB 마이그레이션 없음. 로그인 브라우저에서 세 수정과 앱 복사를 눌러 보는 확인은 하지 않았다. 코드는 같은 날 `feat/s6-1-currentize`에 다섯 커밋으로 넣었다(원격 미반영).

## 최신: 입력형 앱 파일 입력

- 2026-10-31 배포 `dpl_B6mjHofZCHENbH8VtEU7zs5Ni2Gy`. 기존 회귀 86개 파일 1,704개 통과 후 추출 실패 정리 테스트를 보강해 해당 파일 7개를 다시 통과했다. 타입 검사·원격 운영 빌드도 통과했다.
- 기존 주소가 새 Ready 배포를 가리킴을 확인했다. `/apps/builder`·`/apps/run` 200, 비로그인 `/api/chat` POST 401.
- [파일 입력 범위와 검증](APP_FILE_INPUTS.md). 최대 3개·10MB/개·직렬화된 추출 자료 합계 20,000자. 별도 DB 마이그레이션 없음. 로그인 브라우저 파일 업로드부터 결과까지 클릭 검증은 미완료.

## 최신: 입력형 앱 실행·대화 기록

- 2026-10-31 배포 dpl_8eRu8dysKjK1TBAAajocPcCEFKwW. 회귀/보강 기록 테스트·원격 빌드·타입 검사 통과 후 promote.
- 기존 주소의 새 Ready 배포 연결, /apps/history 200 및 비로그인 /api/apps/history GET 401 확인.
- [기록 범위·권한·검증](APP_HISTORY.md). 현재 접근 가능한 입력형 앱의 내 대화 요약이며, 실시간 실행 상태나 고정 업무 작업함을 대체하지 않는다.

## 최신: 중단된 텍스트 앱 수동 재개

- 2026-10-31 배포 dpl_CtxSL9CDi618D33oCitkaqieVQ7A. 회귀 1,680개·실제 모델 재개 시험·타입 검사/빌드 통과 후 promote.
- 기존 주소의 새 Ready 배포 연결, 실행/빌더 200 및 비로그인 /api/chat 재개 POST 401 확인.
- [지원 조건·검증과 한계](APP_MANUAL_RESUME.md). 순수 텍스트 앱의 저장된 실패 기록 대상이며, 새 DB 마이그레이션이나 자동 백그라운드 복구는 없다.

## 최신: 선택값에 따른 단계 실행

- 2026-10-31 배포 dpl_6LwUt6uieWqeaxgrbYtUscUt9Bmj. 회귀 1,667개·빌드/타입 검사 통과 후 promote.
- 기존 주소의 새 Ready 배포 연결, 빌더/실행 화면 200 및 비로그인 내보내기 POST 401 확인.
- [조건 실행 범위·실제 모델 양쪽 경로 시험](CONDITIONAL_APP_STEPS.md). DB 조건 정의 버전 시험은 전부 롤백했고 새 마이그레이션은 없다.

## 최신: 앱 결과 HWPX 내보내기

- 배포 dpl_2uFKtKyFSyqDEBfXFKP9JSxYah8F, 원격 운영 빌드/타입 검사 및 회귀 1,659개 통과 후 promote.
- 기존 주소의 새 Ready 배포 연결 확인. /apps/run 200, 비로그인 /api/apps/export POST 401.
- 시험 DB 0044 적용. 가상 대화/파일의 실제 저장·소유권 조회·서명 다운로드·SHA-256·중복 차단·정리 확인.
- [기능/권한 계약과 검증 한계](APP_RESULT_EXPORT.md). 로그인 화면 버튼 클릭 및 한글의 페이지 배치 확인은 별도다.

## 최신: 단계형 텍스트 앱

- 배포 dpl_4qTajLtsp9mtYvgreYVCcc8fQQh8, 원격 운영 빌드/타입 검사·회귀 1,647개 통과 후 promote.
- 기존 주소가 새 Ready 배포로 해석됨을 확인. /apps/builder·/apps/run 200, 비로그인 /api/chat POST 401.
- 최대 3개 순차 단계, 중간 결과/실패 상태/사용량 보존, 정책 재검사 추가. 단계 없는 기존 앱 호환 유지.
- [기능 범위·실제 모델 시험](STAGED_APPS.md). 별도 DB 마이그레이션 없음. 로그인 브라우저 전체 실행 확인은 미완료.

## 최신: 입력형 앱 빌더

- 배포: dpl_2NpUXbv6QfVJtTFqKxSBqrLyd3xE. 운영 환경변수로 --skip-domain 빌드 후 Ready 확인과 회귀 검증을 마치고 promote했다.
- 기존 운영 주소가 새 배포로 해석됨을 inspect로 확인. /apps·/apps/builder·/apps/run HTTP 200, 비로그인 /api/chat POST 401.
- 원격 빌드/타입 검사, 기존 기능 81개 파일 1,639개 회귀, 실제 DB 버전 저장/충돌/복원 및 가상 입력의 실제 모델 응답 확인.
- 0043 적용. 시험용 비서/판은 ROLLBACK. 기존 비서는 app_definition NULL 유지.
- 범위 및 로그인 브라우저 검증의 한계: [입력형 앱 빌더 1차](FORM_APP_BUILDER.md).

## 최신: 앱 즐겨찾기·업무 분야 탐색

- 배포 ID: dpl_Ey8DJg31A3Pe3pZHH6WcoWYtWEea
- 기존 운영 주소 연결 및 Production / Ready 확인.
- /apps 200, /api/apps/favorites GET/POST 비로그인 요청 401.
- 연결 시험 DB 0042 적용 및 롤백 시험 완료. 관련 테스트 44개·타입 검사·원격 빌드 통과.
- 구현과 남은 기능: [현재 차이](CURRENT_GAPS_AND_NEXT.md).
- 로그인 후 별 클릭·새로고침의 브라우저 검증은 미완료.

## 최신 디자인 반영

사용자의 색상 수정 및 다음 작업 요청에 따라 보라색을 청록색(#087f8c)으로 바꾸고 앞서 준비한 업무 공간 디자인을 운영에 반영했다.

- 배포 ID: dpl_7nofXo5kyGGyJFyC3VrNQPh3QEbt
- 기존 운영 주소 alias 및 Production / Ready 확인.
- 홈 추천 앱·앱 목록·아이콘 메뉴·공통 카드·모바일 헤더 개선 포함.
- 로컬 타입 검사와 관련 테스트 38개 통과, 원격 빌드 완료.
- 운영 첫 화면 HTTP 200 및 연결된 CSS 2개 확인. 새 청록색 토큰과 hero 스타일 포함, 이전 보라색 토큰 미포함 확인.
- 로그인 후 브라우저 화면 검증은 미완료. HTTP/CSS 확인을 화면 검증으로 간주하지 않는다.

## 이전 배포

2026-10-30 사용자가 기존 주소에 바로 반영하도록 요청하여 운영 배포했다.

- 주소: https://workon-ai.vercel.app
- 배포 ID: dpl_Hr23xVcDgr972WzWYQpL29qPmsei
- Vercel inspect에서 Production / Ready 및 기존 주소의 alias 연결 확인.
- 운영 NEXT_PUBLIC_WORKSPACE_HOME을 정확한 apps 값으로 등록하고 빌드했다.
- 운영 NODA_API_KEY는 기존 등록 상태를 유지했다. NODA_API_URL 미설정 시 코드의 https://api.readlayer.kr 기본값을 사용한다.
- 원격 컴파일·타입 검사·페이지 생성·배포 완료.

기관 소속 로그인 사용자에게 문서 업무 바로가기와 업무 앱 목록을 첫 화면으로 제공한다. 기관 미소속 사용자의 기존 안내 흐름과 업무 실행 권한 검사는 유지한다. 로그인 후 실제 업무 실행에 대한 브라우저 검증은 아직 완료하지 않았다.

PREVIEW_DEPLOYMENT.md의 운영 미승격 설명은 이전 배포 당시의 기록이다. 이번 배포에서 운영 반영을 완료했다.
