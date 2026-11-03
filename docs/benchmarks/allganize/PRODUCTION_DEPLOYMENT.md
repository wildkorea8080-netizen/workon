# 운영 배포: 업무 앱 중심 첫 화면

## 주의: GitHub 연동 — `main` 푸시가 곧 운영 배포다

- 2026-11-02 14:xx KST `feat/s6-1-currentize`를 푸시하고 `main`을 같은 커밋으로 fast-forward 푸시했더니 Vercel GitHub 연동이 **`main` 푸시마다 Production 배포를 만들어 Ready가 되면 운영 주소에 자동으로 붙였다**(`dpl_BYYmTTAhuh9fa232L7yES54RyogA`, 56205e4 — 바로 전 CLI 배포와 같은 코드 + 문서 커밋. 가지 푸시는 Preview 빌드). 그 전까지 운영은 CLI `--skip-domain` 빌드 → promote로만 올렸고 `main`은 10-30에 멈춰 있어 이 길이 잠들어 있었다.
- 그래서 앞으로 **`main`에 올리는 것 = 운영 배포**다. 운영 DB 마이그레이션이 먼저여야 하는 커밋은 적용 전에 `main`에 올리지 않는다. 커밋 메시지의 `[vercel skip]`은 **이 프로젝트에서 빌드를 막지 못했다**(6cc3e23을 푸시하자 Production 빌드가 또 잡혔다) — 문서만 고친 푸시도 운영을 같은 코드로 다시 배포한다는 뜻이니, 빌드를 피하려면 Vercel 프로젝트 설정의 Ignored Build Step을 따로 걸어야 한다. CLI promote 방식도 그대로 쓸 수 있다(둘 다 같은 운영 주소를 바꾼다 — 나중 것이 이긴다).

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
