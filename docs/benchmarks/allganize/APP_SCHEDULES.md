# 입력형 앱 예약 실행 (2026-11-03)

알리웍스 Agent Builder는 에이전트에 **스케줄(시작 시각·빈도)** 과 Webhook 트리거를 건다([REA 재분석](REA_PUBLIC_WEB_ANALYSIS_2026-10-31.md), 한국어 가이드 '워크플로우 구축하기'). WORKON에는 내부 작업자·보정 cron만 있었고 직원이 스스로 자동 실행을 걸 길이 없었다. 이번에 **스케줄 트리거**를 넣었다. Webhook 트리거(멤버 토큰·수명·회수)는 아직 없다.

## 직원이 보는 것

- 입력형 앱 실행 화면(`/apps/run`)에서 입력을 채운 뒤 **'이 입력으로 예약 실행 걸기'** → 주기(매일·평일·매주 요일·매월 1~28일)와 시각(한국 시간, 00분·30분)을 고르면 저장된다. 지금 입력값이 그대로 저장돼 매번 같은 입력으로 돈다.
- **앱 예약**(`/apps/schedules`, 왼쪽 메뉴·앱 목록 머리): 내 예약마다 설명(`매주 월요일 09:00`), 다음 실행, 실행 횟수, 마지막 결과, 저장한 입력, 멈추기·다시 켜기·지우기. 마지막 결과는 대화로 열린다.
- 실행 결과는 **그 직원의 대화**로 저장되고 제목 앞에 `[예약] `이 붙어 앱 실행 기록(`/apps/history`)에 함께 보인다. 사용량은 그 직원의 기록으로 남는다.
- 한 사람당 예약 5개(`APP_MAX_SCHEDULES_PER_USER`, 멈춘 것 포함). **파일 첨부가 필수인 앱은 예약할 수 없다**(첨부는 한 대화에 묶이고 서명 주소가 짧아 되쓸 수 없다). 첨부가 선택인 앱은 첨부 없이 돈다.

## 지키는 것

- **실행은 예약한 직원의 권한·사용량으로 한다.** 실행기는 그 직원의 세션 꼴(id·역할·부서)을 만들어 대화 실행기(`prepareTurn`·`streamTurn`)를 손으로 실행할 때와 같은 본문(`agent_id`·`app_inputs`·`app_version`)으로 태운다. 앱 사용 권한(`canUseAgent`)·기관 한도·모델 정책·금지어 검사·사용 기록·대화 저장이 모두 같다. 관리자도 남의 예약은 보거나 바꾸지 못한다(API는 `user_id = 요청자`).
- **중복 방지(DB 조건부 차지)**: 실행기는 `status='active' AND next_run_at <= now AND (claimed_at IS NULL OR claimed_at < now - 15분)`인 행만 `claimed_at`을 써서 차지하고, 한 행이 바뀐 호출만 실행한다. 두 실행기가 겹쳐 돌아도 한 번만. 끝나면 다음 시각을 **지금 뒤**로 세서 같은 시각이 두 번 돌지 않는다. 함수가 죽어 차지가 남으면 15분 뒤 다시 잡힌다(그 실행은 한 번 더 돌 수 있다 — 결과 저장 실패는 `system_logs` error).
- **멈춤·실패**
  - 바로 멈춤(이유를 적고 메일): 앱 설정이 바뀜(판 다름, 409) · 앱을 쓸 수 없음(권한·삭제, 403·404) · 직원 계정 비활성·탈퇴 · 소속 부서 바뀜.
  - 실패 뒤 다음 차례에 다시: 기관 한도(429)·입력 검사(400)·모델 오류·응답이 끝나지 않음. **연속 3회** 실패하면 멈춘다(`SCHEDULE_MAX_CONSECUTIVE_FAILURES`). 실패한 차례를 곧바로 다시 돌리지 않는다(같은 오류로 모델만 다시 부른다).
  - 실패·멈춤마다 예약한 직원에게 **메일**(`scheduleFailureMail` — 앱·예약·시각·이유·다음 실행, 입력값·결과 글은 싣지 않음). 메일이 설정돼 있지 않으면 화면의 상태 칩·이유만. 운영 기록(`system_logs` `api`)에는 예약 id·앱 id·이유만 남기고 받는 사람 주소·입력값은 남기지 않는다.
  - 화면의 **'실행 지연'**: 활성 예약의 예정 시각이 1시간 넘게 지났는데 실행되지 않았으면 표시한다(실행기가 안 도는 신호 — 관리자에게 알리라고 안내).
- **시간대는 한국 시간 고정**(직원이 고르지 않음). 날짜 계산은 UTC+9를 더한 뒤 UTC 성분을 읽는 방식이고 한국은 서머타임이 없다. 매월은 1~28일만(29~31은 건너뛰는 달이 생긴다).
- 다시 켜면 다음 시각을 **지금부터** 다시 세고 실패 수·차지를 지운다. 멈춘 사이의 차례는 돌지 않는다.
- 마이그레이션 0048(`app_schedules`) — 추가만, RLS 켜고 정책 없음(서비스 키만), 앱·사용자·부서·기관 삭제에 연쇄, `last_conversation_id`는 대화 삭제 때 NULL.

## 실행기와 운영 설정

- 라우트 `GET|POST /api/cron/app-schedules`(`maxDuration` 300). 자격은 Bearer 비밀값 하나 — **업무 작업자와 같은 `WORK_WORKER_SECRET`**(pg_cron이 Vault `work_worker_secret`으로 이미 싣는 값) 또는 `CRON_SECRET`, 상수 시간 비교. 둘 다 없으면 503(2026-11-03에 작업자 비밀값을 더했다 — `CRON_SECRET`은 Vercel에만 있고 Vault·`.env.local`에 없어 pg_cron이 실을 수 없었다. 비밀값을 새로 만들어 돌리는 대신 이미 맞는 값을 쓴다). 한 번에 예약 3개(`SCHEDULE_BATCH`)까지, 시간 예산 180초(`SCHEDULE_RUN_BUDGET_MS`)를 넘기면 남은 것은 다음 호출에(`partial`). 응답 `{ checked, completed, failed, paused, skipped, partial }`.
- **Vercel 예약 작업에는 넣지 않는다** — Hobby 요금제는 예약 작업이 2개·하루 한 번이라(이미 NODA·예산 알림이 쓴다) 시각을 맞출 수 없다. 업무 작업자(`/api/work/worker`)처럼 **Supabase pg_cron**이 부른다. 운영 설정(2026-11-03 등록함 — Vault의 `work_worker_secret`을 그대로 쓴다):
  ```sql
  select cron.schedule('workon-app-schedules', '*/5 * * * *', $$
    select net.http_post(url := 'https://workon-ai.vercel.app/api/cron/app-schedules',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'work_worker_secret')),
      timeout_milliseconds := 290000);
  $$);
  ```
  5분마다 부르므로 실제 실행은 예정 시각에서 **최대 5분** 늦는다. 한 호출이 290초를 넘기면 pg_net이 끊지만 함수는 300초까지 이어 간다.
- 확인: `cron.job_run_details`(성공)와 `net._http_response`(`/api/cron/app-schedules` 응답 200)를 본다. 비밀값 없이 부르면 401, Vercel에 두 비밀값이 모두 없으면 503.

## 코드

- `src/lib/apps/schedule-spec.ts`: 규칙 파싱(`parseScheduleSpec`)·다음 시각(`nextRunAt`)·설명(`describeSchedule`)·화면용 보기(`scheduleView`). 아무것도 import하지 않아 화면도 쓴다.
- `src/lib/apps/schedules.ts`: 실행기 — `runDueSchedules`(차지 → 실행 → 반영 → 알림)·`finishPatch`(순수)·`executeSchedule`(직원 세션 꼴로 대화 실행기 태움)·`scheduleDeps`(실제 DB·메일).
- `src/app/api/apps/schedules/route.ts`(목록·만들기), `[id]/route.ts`(멈추기·다시 켜기·지우기), `src/app/api/cron/app-schedules/route.ts`(실행기).
- `src/components/apps/AppScheduleForm.tsx`(실행 화면의 예약 걸기), `src/app/apps/schedules/page.tsx`(예약 목록), `src/lib/mailer.ts`(`scheduleFailureMail`).
- `supabase/migrations/0048_app_schedules.sql`.

## 검증

- `tests/app-schedules.test.ts`(17): 규칙 파싱·설명, 다음 시각(KST 자정 경계·평일·요일·매월·정확히 그 시각이면 다음 차례), 결과 반영(완료·실패 누적·3회 멈춤·앱 변경 멈춤), 실행기(차지 못 함·실행 던짐·저장/알림 실패 기록·시간 예산 partial, 기록에 입력값 없음), 직원 실행(세션 꼴·본문·제목 접두·계정/부서 멈춤·거절 상태 가르기·스트림 오류), 메일 글(입력값 없음·멈춤 안내), 0048·라우트·vercel.json에 없음.
- `tests/app-schedules-route.test.ts`(5): 내 예약만 조회, 만들기(지금 판 기준 입력 검사·다음 시각·`is deleted_at null`), 거절 열 가지(꼴 검사에서 거절되면 DB를 안 봄, 파일 필수 앱, 판 다름 409, 상한 5개), 멈추기·다시 켜기·지우기가 `user_id` 조건을 거침.
- `tests/app-schedules-db.test.ts`(3, 시험 DB가 있을 때만): 실제 Postgres에서 CHECK(주기·요일/날 짝·분·입력 꼴·상태), 조건부 차지(두 번 못 잡음·15분 뒤 다시·멈춘 예약은 안 잡힘), RLS·권한 회수·연쇄 삭제.
- `tests/route-auth.test.ts`가 새 라우트 셋의 인증과 실행기 라우트의 공개 이유를 본다.
- **하지 않은 것**: 실제 모델로 예약 실행을 끝까지 돌려 보지 않았다(실행 경로는 손으로 실행하는 `/api/chat`과 같은 함수). 브라우저 확인·운영 배포·pg_cron 등록은 없다. 운영 DB 0048 적용·코드 배포는 2026-11-03에 했다(`PRODUCTION_DEPLOYMENT.md`). pg_cron 등록은 아직이다.

## 배포 순서

1. 운영 DB에 0048 적용(`npm run db:migrate -- 0048`) — **코드 배포 전**. 적용하지 않으면 예약 화면·API만 503이고 다른 기능에는 영향이 없다.
2. 코드 배포. `WORK_WORKER_SECRET`·`CRON_SECRET`은 이미 운영 환경 변수에 있다.
3. Supabase SQL 편집기에서 위 Vault·pg_cron을 건다(사용자). `cron.job_run_details`에서 5분마다 200이 찍히는지, 비밀값 없이 부른 요청이 401인지 본다.
4. 직원 계정으로 앱 하나에 '매일 (몇 분 뒤) 예약'을 걸어 다음 차례에 `[예약]` 대화가 생기는지, 예약 목록의 '실행 N회'·마지막 결과가 바뀌는지 본다.

## 알려진 한계

- Webhook·이벤트 트리거 없음. 파일 입력 예약 없음. 시간대 고정(KST). 예약 편집 없음(지우고 다시 만든다). 개인 한도·실행 횟수 상한은 기관 한도와 예약 5개 상한으로만.
- 실행기가 5분마다 돌므로 예정 시각보다 최대 5분 늦는다. 실행기가 멈추면 화면의 '실행 지연'이 유일한 신호다(관리자 알림은 없다).
- 결과 저장(`finish`)이 실패하면 15분 뒤 같은 차례가 한 번 더 돈다(모델 비용 중복). `system_logs` error로 남는다.
