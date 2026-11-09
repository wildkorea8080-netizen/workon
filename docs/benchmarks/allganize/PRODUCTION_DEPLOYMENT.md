# 운영 배포: 업무 앱 중심 첫 화면

## 주의: GitHub 연동 — `main` 푸시가 곧 운영 배포다

- 2026-11-02 14:xx KST `feat/s6-1-currentize`를 푸시하고 `main`을 같은 커밋으로 fast-forward 푸시했더니 Vercel GitHub 연동이 **`main` 푸시마다 Production 배포를 만들어 Ready가 되면 운영 주소에 자동으로 붙였다**(`dpl_BYYmTTAhuh9fa232L7yES54RyogA`, 56205e4 — 바로 전 CLI 배포와 같은 코드 + 문서 커밋. 가지 푸시는 Preview 빌드). 그 전까지 운영은 CLI `--skip-domain` 빌드 → promote로만 올렸고 `main`은 10-30에 멈춰 있어 이 길이 잠들어 있었다.
- 그래서 앞으로 **`main`에 올리는 것 = 운영 배포**다. 운영 DB 마이그레이션이 먼저여야 하는 커밋은 적용 전에 `main`에 올리지 않는다. 커밋 메시지의 `[vercel skip]`은 **이 프로젝트에서 빌드를 막지 못했다**(6cc3e23을 푸시하자 Production 빌드가 또 잡혔다) — 문서만 고친 푸시도 운영을 같은 코드로 다시 배포한다는 뜻이니, 빌드를 피하려면 Vercel 프로젝트 설정의 Ignored Build Step을 따로 걸어야 한다. CLI promote 방식도 그대로 쓸 수 있다(둘 다 같은 운영 주소를 바꾼다 — 나중 것이 이긴다).

## 2026-11-09(오전): 문서 참조 관계의 거꾸로 목록('이 문서를 인용하는 문서')·참조 색인

- 2026-11-09 10:23 KST 배포 `dpl_2BooX7TA3UQytXToAKUnrdmwS7QC`(커밋 `cb225fe`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영"). 되돌릴 때는 `dpl_DaGEJQJ61yPuCeMrzh9NBgUjqwbK`(91a3ae7)로 promote한다. **마이그레이션 없음** — 참조 색인은 기존 `documents.metadata` jsonb 안 `references` 칸이라 옛 코드는 읽지 않는다.
- 들어간 커밋: `7bfbaaa`(직전 배포 기록), `004c12d` 이 문서를 인용하는 문서(문서마다 인용 이름 열쇠를 `metadata.references`에 색인, 같은 이름 열쇠로 거꾸로 찾기, 색인 범위 표시, 관리자 '색인 만들기' — [참조 관계](DOCUMENT_REFERENCES.md)), `f7a8999` 문서, `cb225fe` 색인 만들기 주소 고침.
- **한 번 고쳐 다시 배포했다**: 처음 배포 `dpl_6euvL7fPfdSxpkNVEeYs1VpU7Pch`(`f7a8999`, 10:16 KST)에서 색인 만들기 라우트가 `/api/documents/references/index`였는데, **Next.js는 `/index`로 끝나는 주소를 위 경로(`/api/documents/references`)로 308 돌려보내** 로그인 없는 점검에서 401 대신 308이 나왔다(단추가 운영에서 닿지 않음). 라우트 폴더를 `build`로 바꾸고(`POST /api/documents/references/build`) `tests/route-exports.test.ts`가 라우트·화면 폴더 이름 `index`를 막는다. 첫 배포는 7분 동안 운영이었고 그 사이 단추는 실패만 했다(데이터 변화 없음).
- **배포 전**: 가지 Preview(`f7a8999` `workon-jpndl1wf2`, `cb225fe` `workon-kwffk3u9y`) Ready를 확인한 뒤 `main`에 올렸다. 그 전에 시험 DB를 띄운 전체 시험 212파일 3,167개 통과·tsc 0(`f7a8999` 작업 트리). 고침 커밋은 관련 시험 3파일 29개만 돌렸고 tsc는 이 PC 메모리 부족으로 못 돌려 Vercel 빌드(타입 검사 포함)로 확인했다.
- 배포 뒤 확인(로그인 없이, 운영 주소): `/`·`/login` 200, `GET /api/documents/[id]/references`·`POST /api/documents/references/build` 401(옛 `/references/index`는 308 — 쓰지 않음). pg_cron 호출 200(10:21~10:24 KST), 앱 예약 실행기 heartbeat 10:20 KST.
- **확인하지 못한 것**(사용자 몫): 관리자 문서 화면 '참조 문서' 창에서 거꾸로 목록·색인 범위·'색인 만들기'를 실제 문서로 눌러 보기(브라우저로 보지 않음 — 개발 서버가 운영 DB를 씀). 운영 문서는 아직 색인이 없어 처음 열면 '…개만 색인했습니다'가 보이는 것이 정상이다.

## 2026-11-09(자정): 숫자 근거 다시 찾기·근거로 고쳐 쓰기·결과물 '대화에 올린 파일'·통합 찾기·문서 참조 관계

- 2026-11-09 00:23 KST 배포 `dpl_DaGEJQJ61yPuCeMrzh9NBgUjqwbK`(커밋 `91a3ae7`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영"). 되돌릴 때는 직전 `dpl_CVjVDhtAMJz6hjbaMeQmJLBMDWpa`(9695353)로 promote한다. **마이그레이션 없음** — 고쳐 쓴 답은 기존 `messages.source_references` jsonb 안 `revision` 칸이라 옛 코드는 읽지 않는다(되돌리면 고쳐 쓴 답이 화면에서만 안 보인다).
- 들어간 커밋: `367ab6b`(직전 배포 기록), `a0af1de` 숫자 근거 다시 찾기(문서 근거 답의 확인되지 않은 숫자가 든 문장으로 같은 찾기를 한 번 더, 문장 3개·5초, 모델 없음 — [숫자 근거 다시 찾기](NUMBER_RESEARCH.md))·근거로 고쳐 쓰기(`POST /api/messages/[id]/revise`, 답변 하나에 한 번·조건부 차지·사용 기록 `answer_revised`, 원래 답은 그대로 — [근거로 고쳐 쓰기](ANSWER_REVISE.md)), `322f558` 결과물 화면 '대화에 올린 파일'(`GET /api/attachments/mine`·`GET /api/attachments/[id]/original`)과 세 목록 통합 찾기, `506e564` 문서 참조 관계(`GET /api/documents/[id]/references`, 관리자만, 모델 없음 — [참조 관계](DOCUMENT_REFERENCES.md)), `91a3ae7` 문서.
- **배포 전**: 가지 Preview(`91a3ae7`, `workon-kkk79l4f4`) Ready를 확인한 뒤 `main`에 올렸다(그 전에 시험 DB를 띄운 전체 시험 212파일 3,159개 통과·tsc 0). 커밋마다의 타입 검사는 따로 돌리지 않았다(마지막 작업 트리로만 확인).
- 배포 뒤 확인(로그인 없이, 운영 주소): `/`·`/login`·`/files` 200, `POST /api/chat`·`GET /api/attachments/mine`·`GET /api/attachments/[id]/original`·`GET /api/documents/[id]/references`·`POST /api/messages/[id]/revise`·`GET /api/files` 401. pg_cron 호출 200, 배포 뒤 첫 앱 예약 실행기 호출(00:25 KST) 200·heartbeat 갱신.
- **확인하지 못한 것**(사용자 몫): 로그인한 직원 화면에서 숫자 근거 다시 찾기의 회색 안내·'근거로 숫자 다시 확인해 고쳐 쓰기' 단추를 실제 NODA·모델로 눌러 보기(모델 호출·비용), 결과물 화면의 '대화에 올린 파일' 목록·내려받기·통합 찾기, 관리자 문서 화면 '참조 문서' 창을 실제 문서로 열기(브라우저로 보지 않음 — 개발 서버가 운영 DB를 씀).

## 2026-11-08(저녁): 문서 찾기 평가의 답변까지 평가·갈래 건너가기와 단계 5개·예약 자동 이어 실행(0074)·실행 화면 자동 이어 실행

- 2026-11-08 19:37 KST 배포 `dpl_CVjVDhtAMJz6hjbaMeQmJLBMDWpa`(커밋 `9695353`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영"). 되돌릴 때는 직전 `dpl_7khjzWeMjGZxuB83vNdY9GwA1R16`(c11b472)로 promote한다(0074 칸은 옛 코드가 읽지 않는다. 다만 옛 코드의 빌더는 단계 4·5개 앱과 갈래의 `next`를 저장 때 거절하니, 되돌리기 전에 그런 앱이 생겼는지 본다).
- **마이그레이션 0074 운영 적용**(코드 전, `npm run db:migrate -- 0074`): `app_schedules.resume_message_id uuid`(NULL 허용)·`resume_count smallint NOT NULL DEFAULT 0`과 `app_schedules_resume_count_range`(0~10) 확인(읽기 전용), 운영 예약 0개.
- 들어간 커밋: `08582f2`(직전 배포 기록), `3b74235` 문서 찾기 일괄 평가의 답변까지 평가(질문 20개, 대화와 같은 프롬프트로 답을 한 번 만들어 인용·숫자·기대 답 핵심어를 프로그램이 판정, 사용 기록 `rag_eval_answer` — [일괄 평가](RAG_EVAL.md)), `e9a7848` 갈래의 건너가기(그래프 분기·병합 — 앞으로만)와 처리 단계 5개([조건 문서](CONDITIONAL_APP_STEPS.md)), `4b00993` 예약 실행의 자동 이어 실행(0074 — 입력만 쓰는 예약이 처리 시간에 멈추면 다음 실행기 차례에 끝난 단계부터, 한 차례 2번 — [앱 예약](APP_SCHEDULES.md)), `9695353` 실행 화면의 자동 이어 실행(처리 시간 멈춤에 오류 코드 `app_time_budget`, 화면이 끝난 단계부터 곧바로 이어 감 — 한 번 누름에 2번·진행이 늘 때만, 마이그레이션 없음)·문서.
- **배포 전**: 가지 Preview(`9695353`, `workon-5hm00fd5a`) Ready를 확인한 뒤 `main`에 올렸다(그 전에 시험 DB를 띄운 전체 시험 208파일 3,110개 통과·tsc 0, 0074는 시험 DB에 두 번 적용). 커밋마다의 타입 검사는 따로 돌리지 않았다(마지막 작업 트리로만 확인).
- 배포 뒤 확인(로그인 없이, 운영 주소): `/`·`/login`·`/apps/run`·`/apps/builder` 200, `/admin/documents` 307(로그인으로), `POST /api/admin/rag-eval` 403, `PUT /api/apps/schedules/[id]`·`POST /api/chat`·`/api/cron/app-schedules`(비밀값 없이) 401, 운영 주소가 새 배포를 가리킴, pg_cron 업무 작업자 호출 200.
- **확인하지 못한 것**(사용자 몫): 로그인한 관리자의 '답변까지 평가' 실제 실행(모델 호출·비용), 빌더에서 갈래 건너가기 고르기·5단계 앱 실행, 실제로 3분을 넘겨 멈춘 실행이 화면·예약에서 자동으로 이어 가는지(브라우저·실제 긴 실행으로 보지 않음).

## 2026-11-08(오후): 기관 예약 스위치(0070)·예약 결과 한글 파일(0071)·지방공기업 유형(0072)·결과물 파일 찾기·결과 양식 기본값·예약의 올린 파일(0073)·연동으로 파일 보내기

- 2026-11-08 16:08 KST 배포 `dpl_7khjzWeMjGZxuB83vNdY9GwA1R16`(커밋 `c11b472`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영"). 되돌릴 때는 직전 `dpl_EnripJvXGWr7bCDfHMmHoZUJDKi7`(bab42b8)로 promote한다(0070~0073 칸은 옛 코드가 읽지 않고, 0072는 값만 넓힘).
- **마이그레이션 0070·0071·0072·0073 운영 적용**(코드 전, `npm run db:migrate -- 00NN`): `organizations.app_schedules_disabled_at`·`app_schedules_disabled_reason`과 `organizations_app_schedules_switch_check`, `app_schedules.export_hwpx`(boolean NOT NULL DEFAULT false)·`files`(jsonb NOT NULL DEFAULT '[]')와 `app_schedules_files_shape`, `common_documents_org_type_check` 일곱 값('지방공기업' 포함)을 읽기 전용으로 확인. 기관 2곳 모두 예약 켜짐, 운영 예약 0개.
- 들어간 커밋: `5829303`(직전 배포 기록), `d8bb239` 결과물 '대화에서 만든 파일' 이름 찾기(`GET /api/files?q=`), `1461a6b` 기관 유형 '지방공기업'(0072 — 공통 보관함 `workon-c-lpe`), `c11b472` 기관 전체 앱 예약 스위치(0070 — [관리자 통제](APP_AUTOMATION_ADMIN.md))·예약 결과 한글 파일(0071)·앱 결과 한글 파일 기본 양식(`exportTemplateId` — [결과 내보내기](APP_RESULT_EXPORT.md))·예약의 올린 파일(0073 — [앱 예약](APP_SCHEDULES.md))·연동 호출의 `files`(마이그레이션 없음 — [앱 연동](APP_WEBHOOKS.md)).
- **배포 전**: 가지 Preview(`c11b472`, `workon-pap81f65f`) Ready를 확인한 뒤 `main`에 올렸다(그 전에 시험 DB를 띄운 전체 시험 204파일 3,053개 통과·tsc 0, 0070~0073은 시험 DB에 두 번씩 적용).
- 배포 뒤 확인(로그인 없이, 운영 주소): `/`·`/login`·`/apps/schedules`·`/apps/run`·`/apps/builder`·`/files`·`/api/system/maintenance` 200, `/admin/app-automations` 307(로그인으로), `GET /api/files?q=`·`GET /api/apps/schedules`·`PUT /api/apps/schedules/[id]`·`PUT /api/admin/app-automations/schedule-switch` 401, 토큰 없는·무효 토큰(`files` 포함) `POST /api/apps/webhook` 401, 운영 주소가 새 배포를 가리킴. 배포 뒤 첫 앱 예약 실행기 호출(pg_cron, 16:10 KST) 200·heartbeat 갱신.
- **확인하지 못한 것**(사용자 몫): 로그인한 관리자 '앱 예약·연동'에서 기관 전체 예약 끄기·켜기, 예약 '한글 파일로도 만들기'·'저장한 파일'로 실제 예약이 돌아 파일·메일이 오는지, 빌더 '결과 한글 파일 양식' 고르기, 외부 시스템이 `files`를 담아 연동을 부르는 실제 호출(브라우저·실호출로 보지 않음 — 개발 서버가 운영 DB를 씀). **지방공기업 기관이 있으면 슈퍼관리자가 기관 화면에서 유형을 '지방공기업'으로 고치고, 그 공통 문서는 공통 자료실 '지방공기업' 탭에 새로 올린다**(기존 기관 유형은 바꾸지 않았다).

## 2026-11-08(오전 2): 관리자 조치 알림 메일

- 2026-11-08 10:30 KST 배포 `dpl_EnripJvXGWr7bCDfHMmHoZUJDKi7`(커밋 `bab42b8`, `main` fast-forward — GitHub 연동). 사용자 선택("운영 반영"). 되돌릴 때는 직전 `dpl_3BimxgmcjMWRufsk8PjJsV9QZLy4`(a7dee35)로 promote한다. 마이그레이션 없음.
- 들어간 커밋: `97209e5`(직전 배포 기록), `bab42b8` 관리자가 앱 연동을 회수하거나 예약을 멈추·잠금을 풀면 주인 직원에게 사유와 함께 메일(실제로 행을 바꿨을 때만, 관리자 이름·입력값·결과·토큰 없음, 실패는 warning만 — [관리자 통제](APP_AUTOMATION_ADMIN.md)).
- **배포 전**: 가지 Preview(`bab42b8`, `workon-73m5ozuz0`) Ready를 확인한 뒤 `main`에 올렸다(그 전에 시험 DB를 띄운 전체 시험 200파일 3,012개 통과·tsc 0).
- 배포 뒤 확인(로그인 없이, 운영 주소): `/`·`/login`·`/apps/schedules`·`/api/system/maintenance` 200, `/admin/app-automations` 307(로그인으로), 관리자 연동 회수·예약 멈춤 `PATCH` 401, 운영 주소가 새 배포를 가리킴.
- **확인하지 못한 것**(사용자 몫): 관리자가 회수·멈춤·잠금 풀기를 한 뒤 직원 메일함에 알림이 오는지(실제 메일 발송 미확인).

## 2026-11-08(오전): 예약 고치기·예약 완료 메일(0069)·앱 실행 화면의 '지난 파일'

- 2026-11-08 10:09 KST 배포 `dpl_3BimxgmcjMWRufsk8PjJsV9QZLy4`(커밋 `a7dee35`, `main` fast-forward — GitHub 연동). 사용자 선택("운영 반영"). 되돌릴 때는 직전 `dpl_CJiXcrNHWRm9LReriozmHQCVgk5L`(b587269)로 promote한다(0069 칸은 옛 코드가 읽지 않는다).
- **마이그레이션 0069 운영 적용**(코드 전, `npm run db:migrate -- 0069`): `app_schedules.notify_on_success boolean NOT NULL DEFAULT false` 확인(읽기 전용 트랜잭션), 운영 예약 0개.
- 들어간 커밋: `bf58b33`(직전 배포 기록), `a7dee35` 예약 고치기(`GET`·`PUT /api/apps/schedules/[id]`, 만들기와 같은 검사 `schedule-request.ts`, 지금 앱 판·지금 부서로, 직원이 멈춘 예약은 멈춘 채·실행기가 멈춘 예약은 다시 켬, 관리자 잠금 403·실행 중 409 — [앱 예약](APP_SCHEDULES.md))·예약 완료 메일(예약마다 고름, 앱·시각·결과 보기 링크만)·입력형 앱 실행 화면의 '지난 파일'([파일 입력](APP_FILE_INPUTS.md)).
- **배포 전**: 가지 Preview(`a7dee35`, `workon-pqxtx8amu`) Ready를 확인한 뒤 `main`에 올렸다(그 전에 시험 DB를 띄운 전체 시험 199파일 3,008개 통과·tsc 0, 0069는 시험 DB에 두 번 적용).
- 배포 뒤 확인(로그인 없이, 운영 주소): `/`·`/login`·`/apps/run`·`/apps/schedules`·`/api/system/maintenance` 200, `GET /api/apps/schedules`·`GET`·`PUT /api/apps/schedules/[id]`·`GET /api/attachments/reusable` 401, 운영 주소가 새 배포를 가리킴.
- **확인하지 못한 것**(사용자 몫): 로그인한 화면에서 예약 '고치기'(입력·시각이 미리 채워지는지·저장 뒤 목록), '완료 메일 받기'를 켠 예약이 돈 뒤 메일이 오는지(실제 메일 발송 미확인), 실행 화면 '지난 파일'로 파일을 다시 붙여 실행.

## 2026-11-08(아침): 기관 전체 외부 연동 스위치(0068)·앱 결과를 기관 한글 양식에

- 2026-11-08 09:21 KST 배포 `dpl_CJiXcrNHWRm9LReriozmHQCVgk5L`(커밋 `b587269`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영"). 되돌릴 때는 직전 `dpl_6FAbRZNgt7qqtAZngysv9CMxQ1zn`(c4fdc12)로 promote한다(0068 칸은 그대로 두어도 옛 코드는 읽지 않는다).
- **마이그레이션 0068 운영 적용**(코드 전, `npm run db:migrate -- 0068`): `organizations.app_webhooks_disabled_at`·`app_webhooks_disabled_reason` 두 칸과 `organizations_app_webhooks_switch_check` 확인(읽기 전용 트랜잭션), 기관 2곳 모두 켜짐(끈 기관 0).
- 들어간 커밋: `9f64363`(직전 배포 기록), `cc92e87` 기관 전체 외부 연동 스위치(기관 전체 관리자가 사유와 함께 끄고 켬, 끄면 외부 호출은 차지 전에 403·새 연동 403·직원 목록 안내, 토큰은 그대로, 보안 로그 high — [관리자 통제](APP_AUTOMATION_ADMIN.md)), `b587269` 앱 결과를 앱 비서의 기관 한글 양식(`{{주요 내용}}`·`{{본문}}` 자리)에 담아 내보내기(마이그레이션 없음 — [결과 내보내기](APP_RESULT_EXPORT.md)).
- **배포 전**: 가지 Preview(`b587269`, `workon-ksmo7nahz`) Ready를 확인한 뒤 `main`에 올렸다(그 전에 시험 DB를 띄운 전체 시험 199파일 3,000개 통과·tsc 0, 기관 양식 결과를 한글 2018로 열기·다시 저장·PDF 1쪽 확인).
- 배포 뒤 확인(로그인 없이, 운영 주소): `/`·`/login`·`/apps/run`·`/apps/webhooks`·`/api/system/maintenance` 200, `/admin/app-automations` 307(로그인으로), `GET /api/apps/export` 401, `PUT /api/admin/app-automations/webhook-switch` 401, 무효 토큰 `POST /api/apps/webhook` 401(스위치 칸 읽기 전 거절 그대로), 운영 주소가 새 배포를 가리킴.
- **확인하지 못한 것**(사용자 몫): 로그인한 관리자 '앱 예약·연동'에서 기관 전체 끄기·켜기와 그동안 외부 호출 403, 앱 결과 내보내기의 '담을 양식' 고르기·기관 양식 파일(브라우저로 보지 않음 — 개발 서버가 운영 DB를 씀).

## 2026-11-08(새벽): 입력형 앱 입력 항목의 조건부 필수

- 2026-11-08 00:26 KST 배포 `dpl_6FAbRZNgt7qqtAZngysv9CMxQ1zn`(커밋 `c4fdc12`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영"). 되돌릴 때는 직전 `dpl_8iudnDGn2B2xk2w7exnrb5mPDFZx`(6a7d080)로 promote한다. 마이그레이션 없음.
- 들어간 커밋: `d5ec1e1`(직전 배포 기록), `c4fdc12` 입력 항목의 조건부 필수(`fields[].requiredWhen` — 다른 입력 항목 값에 따라 필수, `renderAppInput`이 판정해 실행·예약·연동 모두 거절, 빌더 '다른 항목에 따라 필수', 실행 화면의 '(필수)'·조건 안내 — [조건 문서](CONDITIONAL_APP_STEPS.md)).
- **배포 전**: 가지 Preview(`c4fdc12`, `workon-h3lsld037`) Ready를 확인한 뒤 `main`에 올렸다(그 전에 전체 시험 197파일 2,875개 통과·100개 건너뜀(시험 DB 없이)·tsc 0 — 이 PC의 다른 프로젝트가 메모리를 써서 `--maxWorkers=1`로 돌림).
- 배포 뒤 확인(로그인 없이, 운영 주소): `/`·`/login`·`/apps/run`·`/apps/builder`·`/api/system/maintenance` 200, `GET /api/files` 401, 운영 주소가 새 배포를 가리킴.
- **확인하지 못한 것**(사용자 몫): 로그인한 빌더에서 조건부 필수를 걸어 저장하고, 실행 화면에서 조건에 따라 '(필수)'가 붙고 비우면 거절되는지(브라우저로 보지 않음).

## 2026-11-07(밤): 입력형 앱 실행 전 예상 AI 호출 수

- 2026-11-07 20:54 KST 배포 `dpl_8iudnDGn2B2xk2w7exnrb5mPDFZx`(커밋 `6a7d080`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영"). 되돌릴 때는 직전 `dpl_5pvBpre1eUxByd6fj4SiaJBwUbNg`(568b1a9)로 promote한다. 마이그레이션 없음.
- 들어간 커밋: `96871fc`(직전 배포 기록), `6a7d080` 입력형 앱 실행 화면의 예상 AI 호출 수(`src/lib/apps/call-estimate.ts` — 중간·분류 단계 한 번·마지막 단계 한 번·반복은 줄 수/파일 수·조회는 AI 사용량 없이 따로·분류 결과로 갈리는 단계는 많으면에만·긴 첨부 추리기는 안내만).
- **배포 전**: 가지 Preview(`6a7d080`, `workon-r73dksska`) Ready를 확인한 뒤 `main`에 올렸다(그 전에 전체 시험 196파일 2,967개·tsc 0).
- 배포 뒤 확인(로그인 없이, 운영 주소): `/`·`/login`·`/apps/run`·`/api/system/maintenance` 200, `GET /api/files` 401, 운영 주소가 새 배포를 가리킴.
- **확인하지 못한 것**(사용자 몫): 로그인한 실행 화면에서 예상 호출 줄이 입력·파일에 따라 바뀌는지(브라우저로 보지 않음).

## 2026-11-07(오후 3): 대화에서 만든 파일·법령 근거 조사 앱·기본 세트 갱신

- 2026-11-07 15:16 KST 배포 `dpl_5pvBpre1eUxByd6fj4SiaJBwUbNg`(커밋 `568b1a9`, `main` fast-forward — GitHub 연동). 사용자 선택("운영 반영"). 되돌릴 때는 직전 `dpl_CknxZF5uXr1d92YZQ7qMWCCbNdj6`(f84f67a)로 promote한다. 마이그레이션 없음.
- 들어간 커밋: `990275b`(직전 배포 기록), 결과물 화면 '대화에서 만든 파일'(`GET /api/files` — 내 것만, 시각·id 쪽 넘기기), `568b1a9` '법령 근거 조사' 기본 앱(조회 단계 → 정리, 능력 `public_data` law)·관리자 '기본 비서·앱 세트'의 갱신(사람이 고치지 않았는데 내용이 다른 것만 `save_agent` `preset_update`, `security_logs` `preset_agents_updated`).
- **배포 전**: 가지 Preview(`568b1a9`, `workon-f1tzpuxup`) Ready를 확인한 뒤 `main`에 올렸다(그 전에 시험 DB를 띄운 전체 시험 195파일 2,960개·tsc 0). 법령 근거 조사의 두 조회(법령 검색·조문 본문)는 이 PC의 기관 자체 `LAW_API_OC`로 실호출 확인.
- 배포 뒤 확인(로그인 없이, 운영 주소): `/login`·`/chat`·`/files` 200, `GET /api/files` 401, `POST /api/admin/preset-agents`(갱신) 403, 운영 주소가 새 배포를 가리킴.
- **운영 DB는 바꾸지 않았다** — 기본 입력형 앱 여섯은 기관 전체 관리자가 관리자 비서 화면에서 설치한다.
- **확인하지 못한 것**(사용자 몫): 로그인한 결과물 화면의 대화 파일 목록·더 보기·내려받기, 관리자 패널에서 운영 기관의 기본 비서가 '최신'/'바꿀 수 있음' 중 무엇으로 보이는지와 갱신, 법령 근거 조사 앱을 운영에서 실제로 돌린 결과(운영 `LAW_API_OC` 값은 보지 않음).

## 2026-11-07(오후 2): 기본 입력형 앱 다섯·관리자 '기본 비서·앱 세트'

- 2026-11-07 14:02 KST 배포 `dpl_CknxZF5uXr1d92YZQ7qMWCCbNdj6`(커밋 `f84f67a`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영"). 되돌릴 때는 직전 `dpl_AmntxY7NErQLnEEEYxPUYxMnjZ41`(93c8cba)로 promote한다. 마이그레이션 없음.
- 들어간 커밋: `638a950`(직전 배포 기록), 기본 입력형 앱 다섯(사업 위험 검토·안내 메일 초안·과업지시서 초안·행사 안내문 초안·질의별 답변 방향 정리, 범주 '업무 앱', 능력 없음), `f84f67a` 관리자 비서 화면 '기본 비서·앱 세트'(`GET`·`POST /api/admin/preset-agents` — 설치는 기관 전체 관리자만, 이미 있는지는 기관 전체 이름으로, `security_logs` `preset_agents_installed`).
- **배포 전**: 가지 Preview(`f84f67a`, `workon-9u0nzty8d`) Ready를 확인한 뒤 `main`에 올렸다(그 전에 시험 DB를 띄운 전체 시험 194파일 2,946개·tsc 0).
- 배포 뒤 확인(로그인 없이, 운영 주소): `/login`·`/chat` 200, `/admin/agents` 307(로그인으로), `GET`·`POST /api/admin/preset-agents` 403, 운영 주소가 새 배포를 가리킴.
- **운영 DB는 바꾸지 않았다** — 기존 기관 2곳에는 아직 기본 입력형 앱이 없다. 기관 전체 관리자가 관리자 비서 화면에서 설치하거나 사용자가 `npm run seed:agents`를 돌린다. 새로 등록하는 기관은 등록 때 함께 깔린다.
- **확인하지 못한 것**(사용자 몫): 로그인한 관리자 화면에서 패널 목록·설치(설치 뒤 공식 비서 목록·직원 앱 목록에 '업무 앱'으로 나오는지), 기관 전체 관리자가 아닌 관리자에게 설치 단추가 막혀 보이는지, 다섯 앱을 실제로 돌린 답 품질.

## 2026-11-07(오후): 반복 단계 줄 단위 이어 실행·앱 실행 시간 예산

- 2026-11-07 13:30 KST 배포 `dpl_AmntxY7NErQLnEEEYxPUYxMnjZ41`(커밋 `93c8cba`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영"). 되돌릴 때는 직전 `dpl_8yP1r9js9VX6VXry6oxbsfvYUZrT`(4e45b00)로 promote한다. 마이그레이션 없음.
- 들어간 커밋: `7d73296`(직전 배포 기록), 줄마다 반복 단계의 줄 단위 이어 실행(끝난 줄을 기록 `partial`에 쌓고 이어 실행이 남은 줄만, 반복이 첫 단계여도 이어 실행 가능), `93c8cba` 앱 실행의 시간 예산(3분이 지나면 새 모델 호출 없이 멈춰 끝난 결과 저장, `/api/chat` `maxDuration = 300`, 예약 실행기는 호출 전체 마감 200초를 실행마다 넘김).
- **배포 전**: 가지 Preview(`93c8cba`, `workon-flygho353`) Ready를 확인한 뒤 `main`에 올렸다(그 전에 시험 DB를 띄운 전체 시험 192파일 2,927개·tsc 0).
- 배포 뒤 확인(로그인 없이, 운영 주소): `/login`·`/chat`·`/` 200, `POST /api/chat` 401, `/api/cron/app-schedules`(비밀값 없이) 401, 운영 주소가 새 배포를 가리킴.
- **확인하지 못한 것**(사용자 몫): 로그인한 화면에서 줄마다 반복 앱이 도중에 멈춘 뒤 '이어 실행'이 남은 줄만 도는지와 그 표시, 실제 긴 실행에서 3분 예산 안내가 뜨는지(함수 시간을 실제로 재지 않음), 다음 예약 실행(pg_cron 5분)이 평소처럼 200인지.

## 2026-11-07(낮): 앱 반복 단계를 첨부 파일마다

- 2026-11-07 12:27 KST 배포 `dpl_8yP1r9js9VX6VXry6oxbsfvYUZrT`(커밋 `4e45b00`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영"). 되돌릴 때는 직전 `dpl_CgDMdzNTPtQ7n7mnnUkFjtapvwmn`(acdc4f2)로 promote한다. 마이그레이션 없음.
- 들어간 커밋: `a71ca3a`(직전 배포 기록), `4e45b00` 입력형 앱의 중간 단계를 첨부 파일마다 반복(올린 파일 → 문서함 문서 순서, 파일마다 모델 한 번·원자료는 매번 전부, 결과는 파일 이름 머리로 이어 붙임, 긴 첨부 추리기 지시에 파일 이름을 남기라는 줄).
- **배포 전**: 가지 Preview(`4e45b00`, `workon-avf8nvyo7`) Ready를 확인한 뒤 `main`에 올렸다(그 전에 시험 DB를 띄운 전체 시험 191파일 2,912개·tsc 0).
- 배포 뒤 확인(로그인 없이, 운영 주소): `/login`·`/chat`·`/` 200, `POST /api/chat`·`GET /api/agents/favorite` 401, 운영 주소가 새 배포를 가리킴.
- **확인하지 못한 것**(사용자 몫): 앱 빌더에서 '첨부 파일마다' 고르기·저장, 파일 둘 이상으로 실행해 파일별 결과와 '반복 N개 파일' 표시, 실제 모델이 파일을 가려 쓰는지(비용 때문에 재지 않음).

## 2026-11-07(오전): 공통 기준 문서·비서 '문서' 탭·권한 구멍 셋

- 2026-11-07 10:56 KST 배포 `dpl_CgDMdzNTPtQ7n7mnnUkFjtapvwmn`(커밋 `acdc4f2`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영"). 되돌릴 때는 직전 `dpl_GMfSVYBHt43zHzY5TKrmz6n9rXiH`(04b83f1)로 promote한다. 마이그레이션 없음.
- 들어간 커밋: `288b288`(직전 배포 기록), `1d37e72` 관리자 문서 화면 '공통 기준 문서'(이 기관 유형이 지금 근거로 쓰는 정부 기준 문서, 읽기만), `a89e8e3` 비서 편집 창 '문서' 탭(주인이 읽기 상태 보기·다시 시도·지우기·더 올리기), `657f227` 화면 없는 옛 `/api/reports` 지움(직원이 자기 사용 기록을 고쳐 쓰던 PATCH), `34e6493` 슈퍼관리자 키 화면의 옛 Voyage 키 칸·확인 뺌, `ac01c1b` 키 화면 문구를 사실대로(저장한 키는 보관만, 호출은 서버 환경 변수 키), `acdc4f2` 옛 즐겨찾기 라우트는 쓸 수 있는 비서만(같은 부서 동료의 나만의 비서 설정이 새던 길).
- **배포 전**: 가지 Preview(`acdc4f2`, `workon-4rcuffua4`) Ready를 확인한 뒤 `main`에 올렸다(그 전에 시험 DB를 띄운 전체 시험 190파일 2,904개·tsc 0).
- 배포 뒤 확인(로그인 없이, 운영 주소): `/login`·`/chat`·`/` 200, `GET`·`POST /api/agents/favorite` 401, `GET /api/reports` 404, `GET /api/admin/common-documents` 403, 운영 주소가 새 배포를 가리킴.
- **확인하지 못한 것**(사용자 몫): 로그인한 화면 — 관리자 문서 화면의 '공통 기준 문서' 목록·원본 열기, 비서 편집 창 '문서' 탭의 읽기 상태·다시 시도·지우기·올리기, 슈퍼관리자 키 화면 문구, 즐겨찾기 별표 켜고 끄기.

## 2026-11-06(밤): 기관 테마 색(0067)·위쪽 막대 없이 사이드바 하나·홈에서 바로 묻기·한글 Enter

- 2026-11-06 21:13 KST 배포 `dpl_GMfSVYBHt43zHzY5TKrmz6n9rXiH`(커밋 `04b83f1`, `main` fast-forward — GitHub 연동). 사용자 선택("0067 db 적용해줘" → "운영반영"). 되돌릴 때는 직전 `dpl_52UMLxUB2xd3VuLCJbg9yiXFYJf9`(4eadd5d)로 promote한다 — 0067 칸은 옛 코드가 읽지 않아 그대로 둬도 된다.
- **배포 전**: 운영 DB 0067 적용(`npm run db:migrate -- 0067`, 읽기 전용 확인: `theme_color text` NULL 허용·CHECK `#rrggbb` 소문자·적용 기록, 기관 2곳 모두 색 없음). 가지 Preview(`04b83f1`, `workon-kkf9hxlyq`) Ready를 확인한 뒤 `main`에 올렸다(그 전에 전체 시험 2,882개·tsc 0).
- 들어간 커밋: `8fb6697`(직전 배포 기록), `4570e2b` 기관 테마 색(관리자 '기관 정보'에서 8색·직접 고르기, 흰 글 대비 4.5:1 미만 거절, 업무 틀 안 화면의 청록 197곳을 Tailwind `ws-*` 색으로), `8e05f43` 넓은 화면은 위쪽 막대 없이(로고는 사이드바 위, 사용자 메뉴는 아래), `4a4f116` 업무 홈 '바로 묻기'(질문은 이 탭의 sessionStorage로 `/chat`에 넘김) + 한글 조합 중 Enter 9곳, `6ef81f3` 마지막 브랜딩을 사람마다 기억, `ac7aa90` 낮은 창에서 사이드바 아래가 잘리지 않게, `77bd480` 기관 전용 로그인도 테마 색(서버가 먼저 읽음), `df07f67` 브랜딩 캐시를 사람·경로별로(공용 로그인 뒤 기본값이 남던 결함), `04b83f1` 0067 적용 기록.
- 배포 뒤 확인(로그인 없이, 운영 주소): `/login`·`/chat`·`/`·`/signin/{없는 경로}` 200, `POST /api/chat` 401, `GET /api/admin/organization` 403, `GET /api/branding`이 `themeColor: null`을 싣고 옴(없는 경로도 같은 꼴), `/chat` 묶음에 `workon:chat-handoff`·`workon:branding`, CSS에 `--ws-accent:8 127 140`.
- **확인하지 못한 것**(사용자 몫): 로그인한 화면 — 사이드바 위 로고·아래 사용자 메뉴(로그아웃)·접은 모양, 업무 홈 '바로 묻기' → AI 대화에서 답, 한글 입력 뒤 Enter로 보낼 때 마지막 글자가 남지 않는지, 관리자 '기관 정보'에서 테마 색 저장 → 업무 화면·기관 전용 로그인 색, 기본 청록 화면이 예전과 같은지(가까운 청록 몇 가지를 하나로 합침).

## 2026-11-06(오후): 사이드바 접기

- 2026-11-06 15:18 KST 배포 `dpl_52UMLxUB2xd3VuLCJbg9yiXFYJf9`(커밋 `4eadd5d`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영"). 되돌릴 때는 직전 `dpl_8po4buxTsHomUkTwEsa95sFiWZQv`(04f6b70)로 promote한다. 마이그레이션 없음.
- 들어간 커밋: `2bc96b1`(직전 배포 기록), `4eadd5d` 업무 틀 사이드바 접기 — 위 단추로 72px 아이콘만 남기고 접음(이름은 title·aria-label), 접으면 최근 대화 숨김, 접은 상태는 이 브라우저의 localStorage에만(`src/lib/sidebar-pref.ts`, 못 쓰면 펼침).
- **배포 전**: 가지 Preview(`4eadd5d`, `workon-l5mwu73c9`) Ready를 확인한 뒤 `main`에 올렸다(그 전에 전체 시험 2,840개·tsc 0).
- 배포 뒤 확인(로그인 없이, 운영 주소): `/login`·`/chat`·`/` 200, `POST /api/chat`·`GET /api/conversations` 401, 운영 `/chat`이 싣는 묶음(`8349-…js`)에 `workon:sidebar-collapsed`가 들어 있음.
- **확인하지 못한 것**(사용자 몫): 로그인한 화면에서 접기·펼치기, 접은 채 새로고침해도 접혀 있는지, 접은 상태의 아이콘 이름 풍선.

## 2026-11-06(낮): 사이드바 하나·비서 없이 바로 묻기

- 2026-11-06 13:10 KST 배포 `dpl_8po4buxTsHomUkTwEsa95sFiWZQv`(커밋 `04f6b70`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영"). 되돌릴 때는 직전 `dpl_CdmkaG3Fm47gK7murQXiMhXcMqr3`(a3a2f41)로 promote한다. 마이그레이션 없음.
- 들어간 커밋: `408d325`(직전 배포 기록), `a2e9124` 왼쪽을 사이드바 하나로 — 업무 틀 사이드바의 업무 메뉴 아래 '최근 대화'(대화 목록 둘째 칸 없앰, 고르면 `/chat?conv=ID`, 작은 화면은 '지난 대화' 펼치기), `04f6b70` 첫 화면 입력창에 비서를 고르지 않고 바로 묻기(답할 비서 = 고른 비서 → 이번에 쓴 비서 → 마지막 대화의 비서 → 첫 공식 비서, '답할 비서: 이름' 표시) + 적은 질문이 대화 화면으로 넘어가며 버려지던 결함.
- **배포 전**: 가지 Preview(`04f6b70`, `workon-jgg2v2n8j`) Ready를 확인한 뒤 `main`에 올렸다(그 전에 전체 시험 2,838개·tsc 0).
- 배포 뒤 확인(로그인 없이, 운영 주소): `/login`·`/chat` 200, `POST /api/chat`·`GET /api/conversations?limit=1` 401, 운영 주소가 새 배포를 가리킴.
- **확인하지 못한 것**(사용자 몫): 로그인한 화면에서 왼쪽 사이드바의 최근 대화 고르기·'+ 새 대화'·새 대화가 목록에 바로 뜨는지, 첫 화면에서 비서 없이 적은 질문이 답할 비서로 한 번 보내지는지, 작은 화면의 '지난 대화' 펼치기.

## 2026-11-06(오전): AI 대화 화면을 업무 화면과 같은 디자인으로

- 2026-11-06 10:40 KST 배포 `dpl_CdmkaG3Fm47gK7murQXiMhXcMqr3`(커밋 `a3a2f41`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영"). 되돌릴 때는 직전 `dpl_8uQLLZPMjfPCkeoqWuSYwPatVBhN`(f6d11a1)로 promote한다. 마이그레이션 없음.
- 들어간 커밋: `3a4a394`(직전 배포 기록), `a3a2f41` `/chat`을 업무 틀(WorkShell) 안에서 그리기·밝은 대화 목록·첫 화면과 비서 탭을 업무 홈 꼴로·대화 부품의 남색을 청록으로(기능 그대로, 업무 홈을 끈 기관의 `/`는 틀 없이).
- **배포 전**: 가지 Preview(`a3a2f41`, `workon-api7rxy9a`) Ready를 확인한 뒤 `main`에 올렸다(그 전에 전체 시험 2,830개·tsc 0).
- 배포 뒤 확인(로그인 없이, 운영 주소): `/login`·`/chat`·`/api/system/maintenance` 200, `POST /api/chat` 401, 운영 주소가 새 배포를 가리킴.
- **확인하지 못한 것**(사용자 몫): 로그인한 `/chat` 화면 모양(왼쪽 업무 메뉴 + 대화 목록 + 대화)·대화·공유·첨부가 그대로 되는지, 좁은 화면에서 두 목록이 나란히 있어 대화 칸이 좁지 않은지.

## 2026-11-06(아침 3): 1,000행 상한 목록 둘

- 2026-11-06 09:33 KST 배포 `dpl_8uQLLZPMjfPCkeoqWuSYwPatVBhN`(커밋 `f6d11a1`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영"). 되돌릴 때는 직전 `dpl_CJFVQsNcwwXpBPYtE1eMX2XPLbvF`(7972d66)로 promote한다. 마이그레이션 없음.
- 들어간 커밋: `1e7eac9`(직전 배포 기록), `f6d11a1` 대화 목록 첫 메시지 미리보기(대화마다 한 줄·쪽 크기 검사)·슈퍼관리자 직원 목록의 부서·기관 끝까지 읽기(기관으로 거를 때 직원이 빠지던 것)·보안 기록 개수 `head`([1,000행 상한](USAGE_ROW_CAP.md)).
- **배포 전**: 가지 Preview(`f6d11a1`, `workon-9c5x95rre`) Ready를 확인한 뒤 `main`에 올렸다(그 전에 전체 시험 2,826개·tsc 0).
- 배포 뒤 확인(로그인 없이, 운영 주소): `/login`·`/api/system/maintenance` 200, `GET /api/conversations?limit=abc`·`/api/super/accounts/users`·`/api/security-logs` 401.
- **확인하지 못한 것**(사용자 몫): 로그인한 대화 목록·슈퍼관리자 직원 목록의 기관 거르기.

## 2026-11-06(아침 2): 날짜를 한국 시간으로

- 2026-11-06 09:06 KST 배포 `dpl_CJFVQsNcwwXpBPYtE1eMX2XPLbvF`(커밋 `7972d66`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영"). 되돌릴 때는 직전 `dpl_UWCH75NDrx4mKisQqPUtPJKeHNc9`(59a9585)로 promote한다. 마이그레이션 없음.
- 들어간 커밋: `4db1d62`(직전 배포 기록), `7972d66` UTC 날짜 셈으로 한국 00:00~09:00 기록이 전날로 가던 곳 — 내 사용현황(일별·연속 사용일·달 경계), 슈퍼관리자 대시보드·사용량(시간별 표 9시간 밀림·고른 끝 날 하루가 빠짐)·기관 사용량·접속/시스템 로그·경보·API 키·계정, 감사·이용통계 기본 기간, 계약·기관 시작일 기본값, DART·나라장터 검색 끝 날(`src/lib/kst-time.ts`).
- **배포 전**: 가지 Preview(`7972d66`, `workon-pqbc1c6j3`) Ready를 확인한 뒤 `main`에 올렸다(그 전에 전체 시험 2,822개·tsc 0).
- 배포 뒤 확인(로그인 없이, 운영 주소): `/login`·`/api/system/maintenance` 200, `GET /api/my/stats`·`/api/super/usage?period=today`·`/api/super/dashboard` 401, `GET /api/admin/audit-logs` 403.
- **알아 둘 것**: 슈퍼관리자 화면의 '이번 달'·'오늘' 숫자와 일별·시간별 표가 한국 날짜 기준으로 바뀌어 배포 전과 다르게 보일 수 있다(전에는 오전 0~9시 기록이 전날·지난달로 묶였다). 한도·예산 판정은 원래 한국 시간이라 바뀌지 않았다.
- **확인하지 못한 것**(사용자 몫): 로그인한 화면에서 시간별 표·일별 차트·감사 기본 기간이 한국 날짜로 보이는지.

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
