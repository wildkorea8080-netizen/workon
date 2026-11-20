# 운영 배포: 업무 앱 중심 첫 화면

## 주의: GitHub 연동 — `main` 푸시가 곧 운영 배포다

- 2026-11-02 14:xx KST `feat/s6-1-currentize`를 푸시하고 `main`을 같은 커밋으로 fast-forward 푸시했더니 Vercel GitHub 연동이 **`main` 푸시마다 Production 배포를 만들어 Ready가 되면 운영 주소에 자동으로 붙였다**(`dpl_BYYmTTAhuh9fa232L7yES54RyogA`, 56205e4 — 바로 전 CLI 배포와 같은 코드 + 문서 커밋. 가지 푸시는 Preview 빌드). 그 전까지 운영은 CLI `--skip-domain` 빌드 → promote로만 올렸고 `main`은 10-30에 멈춰 있어 이 길이 잠들어 있었다.
- 그래서 앞으로 **`main`에 올리는 것 = 운영 배포**다. 운영 DB 마이그레이션이 먼저여야 하는 커밋은 적용 전에 `main`에 올리지 않는다. 커밋 메시지의 `[vercel skip]`은 **이 프로젝트에서 빌드를 막지 못했다**(6cc3e23을 푸시하자 Production 빌드가 또 잡혔다) — 문서만 고친 푸시도 운영을 같은 코드로 다시 배포한다는 뜻이니, 빌드를 피하려면 Vercel 프로젝트 설정의 Ignored Build Step을 따로 걸어야 한다. CLI promote 방식도 그대로 쓸 수 있다(둘 다 같은 운영 주소를 바꾼다 — 나중 것이 이긴다).

## 2026-11-20(낮): 읽기 실패를 '없음'으로 보이지 않기·멈춘 기관의 나머지 길(0187~0205) — 마이그레이션 없음

- 코드 배포 `dpl_GdYysCAjynAb5YYrHxCq8UhNcUyY`(커밋 `77f47c0`, 2026-11-20 14:11 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `835418f`(밤 2 기록), `92dcab8` 열아홉 묶음 — API 키 검증 셋 판정·저장한 시스템 키를 서버가 풀어 확인(0187), 슈퍼관리자 예상 비용을 모든 활동의 원가로(0188), 기한 지난 활성 계약 표시(0189), 정지·종료한 기관에 가입 막기·도메인 가입은 소속 먼저(0190·0191), 비서·요청자 범위 읽기 실패 503 — `actorScopeOr503` 라우트 38곳(0192·0193·0199), 즐겨찾기 읽기 실패에 덮어쓰지 않음·행 잠그는 DB 함수(0194·0195), 쓰지 않던 `POST /api/conversations` 지움(0196), 공지 띠 기관 읽기 실패 503(0197), 브랜딩 읽기 실패를 기본값으로 꾸미지 않음(0198), 종료 기관 문서 올리기 안내·기관 통계 API 403(0200), 멈춘 기관의 예약은 넘김(0201)·연동 호출은 차지 전 403(0202)·직원 목록이 까닭을 가름(0203), 이용통계 이름 사전·문서 붙이기·지우기 읽기 실패 503(0204), 일괄 실행 결과 엑셀이 보낸 기록·앱을 못 읽으면 503(0205). `77f47c0` 문서. 가지 Preview(`workon-khc4rx60p`) Ready 뒤 `main`. 배포 전 전체 시험 359파일 4,527개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_5wWJuXLMqTCdoVDp5CVK6ekg6mcP`(f54b260)로 promote.
- 배포 전 운영 확인(읽기만): 새 칸·표 없음. 새 코드가 쓰는 함수 `set_user_app_favorite`(0042)·`organization_chat_tokens`·`user_spend_krw`·`department_spend_krw`와 칸 `organizations.status`·`allowed_ips`·`app_webhooks_disabled_at`·`app_schedules_disabled_at`·`app_outbound_deliveries.receipt_ref` 모두 있음. 운영 기관 2곳 모두 활성(이번 배포로 막히는 기관 없음), 기한 지난 활성 계약 0건.
- 배포 뒤 확인: `/login`·`/super/login`·`/api/system/maintenance`·`/api/branding` 200, 인증 없는 앱 이력·예약·연동·일괄 실행 엑셀·기관 통계 API·슈퍼관리자 대시보드 401(관리자 이용통계 403·공지 빈 목록 — 원래 그렇다). 실행기 호출 14:12~14:16 KST 모두 200(heartbeat 14:15), 최근 24시간 critical 0건·20분 warning 이상 0건. 바꾼 화면은 브라우저로 눌러 보지 않았다(시험·원본 확인만).

## 2026-11-19(밤 2): 대리 접근은 최상위 부서의 관리자부터·읽기 실패 503 — 마이그레이션 없음

- 코드 배포 `dpl_5wWJuXLMqTCdoVDp5CVK6ekg6mcP`(커밋 `f54b260`, 2026-11-19 21:14 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `71eaadc`(밤 기록), `637d6ed` 대리 접근이 가장 먼저 만든 관리자(5명 중)로 들어가 하위 부서 관리자면 그 부서 아래만 보이던 것 — `pickImpersonationTarget`(`src/lib/impersonation-target.ts`)이 최상위 부서의 관리자부터, 없으면 하위 부서 관리자로 들어가되 응답 `warning`·`data.wholeOrganization`(화면이 알림), 부서·관리자 읽기 실패는 '없습니다'(404) 대신 503(토큰 없음), 후보 200명까지. `f54b260` 문서. 가지 Preview(`workon-drg83btjb`) Ready 뒤 `main`. 배포 전 전체 시험 340파일 4,423개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_C4A8mVLNEsSx3gdWtzTabSN2CjBp`(c29e946)로 promote.
- 배포 전 운영 확인(읽기만): 새 칸·표 없음. 운영 기관 2곳 모두 활성 관리자가 한 명이고 최상위 부서 소속 — 예전과 같은 관리자로 들어간다(이번 배포로 바뀌는 대리 접근 없음).
- 배포 뒤 확인: `/login`·`/super/login`·`/api/system/maintenance`·`/api/branding` 200, 인증 없는 대리 접근·기관 목록 401. 업무 작업자·실행기 호출 21:17~21:21 KST 모두 200(실행기 heartbeat 21:20), 최근 24시간 critical 0건·20분 warning 이상 0건. 대리 접근은 실제로 눌러 보지 않았다(시험·원본 확인만).

## 2026-11-19(밤): 슈퍼관리자 기관 화면의 종료 상태 표시·정지 단추 확인 — 마이그레이션 없음

- 코드 배포 `dpl_C4A8mVLNEsSx3gdWtzTabSN2CjBp`(커밋 `c29e946`, 2026-11-19 20:52 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `e046f88`(저녁 2 기록), `7afb6e4` 기관 목록·상세가 '기관 종료'한 기관을 '활성'으로 보이던 것 — 상태 이름 `orgStatusLabel`(체험·활성·정지·종료, `src/lib/org-status.ts`), 목록 상태 거르기에 체험·종료, 대시보드 '정지·종료 N개'(`STOPPED_ORG_STATUSES`), 정지 단추 셋(목록·상세 위험 구역·사용량 초과 '서비스 정지')은 먼저 묻고(`orgSuspendConfirmText`) `requestOrgStatusChange`로 보내 실패·계약 경고를 알림(예전엔 응답을 보지 않거나 실패해도 말이 없었다), 기관 목록을 못 읽으면 '등록된 기관이 없습니다' 대신 그렇다고. `c29e946` 문서. 가지 Preview(`workon-dkuutpc1w`) Ready 뒤 `main`. 배포 전 전체 시험 339파일 4,415개 통과·tsc 0(시험 DB 폴더가 임시 폴더 정리로 깨져 다시 만든 뒤).
- 되돌릴 때는 직전 `dpl_AhJ9rXZTvLvazc2zD9Jun33QiJ7m`(0cb3bfb)로 promote.
- 배포 전 운영 확인: 새 칸·표 없음(화면·대시보드 세기만 바뀜).
- 배포 뒤 확인: `/login`·`/super/login`·`/api/system/maintenance`·`/api/branding` 200, 인증 없는 기관 목록·대시보드·사용량·기관 상태 바꾸기 401. 업무 작업자·실행기 호출 20:57~21:01 KST 모두 200(실행기 heartbeat 21:00), 최근 24시간 critical 0건·20분 warning 이상 0건. 바꾼 화면은 브라우저로 눌러 보지 않았다(시험·원본 확인만). 문서 올리기 거절 문구는 종료한 기관에도 '정지되어…' 그대로.

## 2026-11-19(저녁 2): 슈퍼관리자 새 기관 등록의 입력 검사·계약 저장 실패 알림 — 마이그레이션 없음

- 코드 배포 `dpl_AhJ9rXZTvLvazc2zD9Jun33QiJ7m`(커밋 `0cb3bfb`, 2026-11-19 18:03 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `bf8be46`(저녁 기록), `438035a` 새 기관 등록 입력을 아무것도 만들기 전에 검사 `parseOrgCreateInput`(기관명·로그인 경로·관리자 이메일·유형·요금제·날짜·한도·이용료 1억 원 미만·메모 — 틀리면 400, 예전엔 틀린 날짜가 기관을 만든 뒤 던져 반쪽 기관 500), 계약 저장 실패는 `org_contract_create` 경고(예전엔 `console.warn`뿐), 기관 목록 예비 길의 읽기 실패는 500·숫자 아닌 page·limit은 기본값, 등록 화면은 실패 응답을 알림. `0cb3bfb` 문서. 가지 Preview(`workon-cr9cunsxl`) Ready 뒤 `main`. 배포 전 전체 시험 338파일 4,405개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_8aoZ8eqH6LQnd6iV3uKGmtP84ekr`(8bd886d)로 promote.
- 배포 전 운영 확인: 새 칸·표 없음.
- 배포 뒤 확인: `/login`·`/super/login`·`/api/system/maintenance`·`/api/branding` 200, 인증 없는 기관 목록·등록 401. 업무 작업자·실행기 호출 18:05~18:07 KST 모두 200, 최근 24시간 critical 0건·20분 warning 이상 0건. 등록 화면은 브라우저로 눌러 보지 않았다(시험·원본 확인만). 등록 화면의 요금제 프리셋 숫자가 `plans.ts`와 다른 것은 그대로(가격 결정 필요).

## 2026-11-19(저녁): '기관 종료'한 기관을 정지처럼 막기·종료할 때 계약 해지 — 마이그레이션 없음

- 코드 배포 `dpl_8aoZ8eqH6LQnd6iV3uKGmtP84ekr`(커밋 `8bd886d`, 2026-11-19 17:14 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `cdd41bf`(오후 기록), `c1e6c7c` 대화 한도·문서 올리기·예산 알림이 정지(`suspended`)만 보아 종료(`terminated`)한 기관의 직원이 AI를 계속 쓰던 것 — 판정 한 곳 `isStoppedOrgStatus`(`src/lib/org-status.ts`), 종료면 `org_terminated`·'기관 이용이 종료되었습니다', 기관 종료도 정지처럼 active 계약 해지(실패면 `contract_cancel_after_org_terminate` 경고), 기관 PATCH의 깨진 요청·상태 값·메모(1,000자, 빈 글은 지움) 400·못 읽으면 503·없으면 404(GET도). `8bd886d` 문서. 가지 Preview(`workon-ou4q13h67`) Ready 뒤 `main`. 배포 전 전체 시험 337파일 4,397개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_BoeE8gAMWRQrTs8SzyCo13W1ASWR`(f6444a6)로 promote.
- 배포 전 운영 확인(읽기만): 새 칸·표 없음. 기관 2곳 모두 `active` — 종료·정지 기관이 없어 이번 배포로 막히는 기관 없음, 멈춘 기관의 active 계약 0.
- 배포 뒤 확인: `/login`·`/super/login`·`/api/system/maintenance`·`/api/branding` 200, 인증 없는 기관 조회·고치기·대화 401. 업무 작업자·실행기 호출 17:19~17:21 KST 모두 200, 최근 24시간 critical 0건·20분 warning 이상 0건. 슈퍼관리자 화면은 브라우저로 눌러 보지 않았다(시험·원본 확인만). 문서 올리기 거절 문구는 종료한 기관에도 '정지되어…' 그대로.

## 2026-11-19(오후): 슈퍼관리자 공지의 만료일·입력 검사·발행 시각 — 마이그레이션 없음

- 코드 배포 `dpl_BoeE8gAMWRQrTs8SzyCo13W1ASWR`(커밋 `f6444a6`, 2026-11-19 15:31 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `c7a2701`(낮 3 기록), `a81f3f4` 공지 만들기·고치기 입력 검사 `parseNoticeInput`(만료일은 그날 한국 23:59:59까지 — 예전엔 그날 UTC 0시 = 한국 오전 9시에 내려감, 중요도 셋·대상 둘만, '특정 기관'은 기관 하나 이상, 기관 id는 uuid, 제목 200자·본문 20,000자 — 틀리면 400), 발행 시각은 새로 발행할 때만·발행 취소는 비움, 고치기·지우기는 없으면 404·못 읽으면 503, 화면은 만료일을 한국 날짜로 읽고 발행·삭제·저장 실패를 알림. `f6444a6` 문서. 가지 Preview(`workon-oejy61glv`) Ready 뒤 `main`. 배포 전 전체 시험 336파일 4,387개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_CjcKFLYS28gS6RUXraE3ipXzq9NE`(a142e9c)로 promote.
- 배포 전 운영 확인: 새 칸·표 없음.
- 배포 뒤 확인: `/login`·`/super/login`·`/api/system/maintenance` 200, 인증 없는 공지 목록·만들기 401. 업무 작업자·실행기 호출 15:34~15:36 KST 모두 200, 최근 24시간 critical 0건·20분 warning 이상 0건. 이미 저장된 공지의 만료 시각은 바꾸지 않았다(다시 저장하면 하루 끝으로). 공지 화면은 브라우저로 눌러 보지 않았다(시험·원본 확인만).

## 2026-11-19(낮 3): 계약 갱신·해지의 입력 검사·끝난 계약 — 마이그레이션 없음

- 코드 배포 `dpl_CjcKFLYS28gS6RUXraE3ipXzq9NE`(커밋 `a142e9c`, 2026-11-19 13:53 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `116a33a`(낮 2 기록), `84448e2` 계약 갱신·해지(`PATCH /api/super/contracts/[id]`) 입력 검사 `parseContractPatch`(상태는 해지만·요금제 표 안만·이용료 0~99,999,999 정수·날짜·메모·연간 예산·경고 비율 1~100 정수 — 틀리면 400), 새 계약의 월 이용료 상한도 99,999,999(price_per_month numeric(10,2)), 계약을 못 읽으면 503·없으면 404·종료일이 시작일보다 앞서면 400, 이미 끝난 계약 해지 409(기관 정지 안 함), 요금제 변경은 계약 행 한도도 맞추고 기관 한도는 지금 계약일 때만, 갱신 창은 빈 메모를 보내지 않음·실패 이유 표시. `a142e9c` 문서. 가지 Preview(`workon-eksln2mgh`) Ready 뒤 `main`. 배포 전 전체 시험 335파일 4,375개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_AunQ48ZvbNSp2mp2AeAAyS3KWPTS`(4e5def0)로 promote.
- 배포 전 운영 확인: 새 칸·표 없음(계약 행 한도 칸은 계약 만들기가 이미 쓰는 칸).
- 배포 뒤 확인: `/login`·`/super/login`·`/api/system/maintenance`·`/api/branding` 200, 인증 없는 계약 목록·계약 바꾸기 401. 업무 작업자·실행기 호출 13:59~14:01 KST 모두 200, 최근 24시간 critical 0건·20분 warning 이상 0건. 계약 화면은 브라우저로 눌러 보지 않았다(시험·원본 확인만).

## 2026-11-19(낮 2): 슈퍼관리자 기관 상세 탭·API 키·업무 화면 설정의 읽기 실패 — 마이그레이션 없음

- 코드 배포 `dpl_AunQ48ZvbNSp2mp2AeAAyS3KWPTS`(커밋 `4e5def0`, 2026-11-19 13:28 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `180d7c6`(낮 기록), `3553696` 기관 사용자·초대 링크는 부서를 못 읽으면 503(빈 목록이 아님)·사용자 탭 부서는 쪽마다 끝까지, 기관·시스템 API 키는 키를 못 읽으면 503·풀지 못하는 암호문은 '(풀지 못함)', 기관 API 키 저장은 깨진 요청·글이 아닌 키 400·앞뒤 공백 뗌, 업무 화면 설정은 기관을 못 읽으면 503·저장소 오류는 한국어 500, 화면은 실패를 따로 보이고 '보관 안 함'은 응답을 봄. `4e5def0` 문서. 가지 Preview(`workon-rad04r13g`) Ready 뒤 `main`. 배포 전 전체 시험 334파일 4,363개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_Dj63VYQG1U3XtMvRHvSyfNBmTtmk`(feb4afd)로 promote.
- 배포 전 운영 확인: 새 칸·표 없음.
- 배포 뒤 확인: `/login`·`/super/login`·`/api/system/maintenance`·`/api/branding` 200, 인증 없는 기관 사용자·초대 링크·API 키·시스템 API 키·업무 화면 설정 401. 업무 작업자·실행기 호출 13:29~13:31 KST 모두 200, 최근 24시간 critical 0건·20분 warning 이상 0건. 화면은 브라우저로 눌러 보지 않았다(시험·원본 확인만).

## 2026-11-19(낮): 슈퍼관리자 추가가 기존 계정을 덮어쓰지 않게·슈퍼관리자가 0명이 되지 않게 — 마이그레이션 없음

- 코드 배포 `dpl_Dj63VYQG1U3XtMvRHvSyfNBmTtmk`(커밋 `feb4afd`, 2026-11-19 12:51 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `db0bfda`(오전 기록), `a418ad2` 슈퍼관리자 추가 — 등록 여부를 못 읽으면 503·있으면 409·users는 insert로만·실패하면 이번에 만든 Auth 계정 지움·Auth 계정 찾기는 쪽마다 끝까지·비밀번호 바꾸기 실패 503(첫 설정도 같은 찾기), 슈퍼관리자 사용 중지 — `isActive` 꼴 검사·대상 없으면 404·끈 뒤 다시 세어 0명이면 되돌리고 409, 직원 계정 PATCH는 슈퍼관리자 계정을 받지 않음·전 값을 못 읽으면 503, 계정 화면은 응답을 보고 실패 문구. `feb4afd` 문서. 가지 Preview(`workon-5oi7n1gkw`) Ready 뒤 `main`. 배포 전 전체 시험 333파일 4,350개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_4cb9K1K1xGziF98ex2gFzKp2KHsJ`(9f619d5)로 promote.
- 배포 전 운영 확인: 새 칸·표 없음(`password_must_change`는 0093).
- 배포 뒤 확인: `/login`·`/super/login`·`/api/system/maintenance` 200, 인증 없는 슈퍼관리자 추가·사용 중지·직원 계정 PATCH 401. 업무 작업자·실행기 호출 12:54~12:56 KST 모두 200, 최근 24시간 critical 0건·20분 warning 이상 0건. 슈퍼관리자 계정 화면은 브라우저로 눌러 보지 않았다(시험·원본 확인만).

## 2026-11-19(오전): CSV 수식 막기·이력/일괄 실행 읽기 실패·대화 이름 바꾸기/지우기·기관 상세 새 계약 — 마이그레이션 없음

- 코드 배포 `dpl_4cb9K1K1xGziF98ex2gFzKp2KHsJ`(커밋 `9f619d5`, 2026-11-19 10:14 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `7e30ca7`(밤 11 기록), `88fc940` ① CSV 칸을 `csvCell`·`csvLine` 한 곳으로 — `=`·`+`·`-`·`@`·탭·CR로 시작하는 칸이 엑셀에서 수식으로 실행되던 것(감사 기록·이용통계·도입 현황·평가·직원 등록 결과·슈퍼관리자 로그·사용량, 직원 등록 결과는 쉼표가 든 이름이 칸을 밀던 것도) ② 이어지는 대화의 이력을 못 읽으면 답하지 않음(503 — 빈 이력으로 앞 대화 없이 답하던 것), 대화 준비의 비서·대화 읽기 실패와 일괄 실행 묶음·줄 읽기 실패도 '없음' 대신 503 ③ 대화 이름 바꾸기·지우기는 서버가 한 것만 화면에(실패해도 바뀐 척하던 것), 이름 1~100자, 남의·없는 대화 404·읽기 실패 503 ④ 슈퍼관리자 기관 상세의 '새 계약'이 계약 만들기로(요금제 이름만 바꾸고 계약이 바뀐 척하던 것), 계약 만들기는 표 밖 요금제·틀린 이용료·날짜를 지금 계약을 끝내기 전에 400. `9f619d5` 문서. 가지 Preview(`workon-hxjj367r8`) Ready 뒤 `main`. 배포 전 전체 시험 331파일 4,325개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_3AnWpx8Xxc7mmEKnArJEQJM8TpgD`(741371b)로 promote.
- 배포 전 운영 확인: 새 칸·표 없음.
- 배포 뒤 확인: `/login`·`/super/login`·`/api/branding`·`/api/system/maintenance`·`/api/notices` 200, 인증 없는 계약 만들기·대화 열기 401. 업무 작업자·실행기 호출 10:19~10:21 KST 모두 200, 최근 24시간 critical 기록 없음·최근 20분 warning 이상 없음. 기관 상세 계약 창은 브라우저로 눌러 보지 않았다(시험·원본 확인만).

## 2026-11-18(밤 11): 양식·나만의 비서·앱 시험 판의 읽기 실패 — 마이그레이션 없음

- 코드 배포 `dpl_3AnWpx8Xxc7mmEKnArJEQJM8TpgD`(커밋 `741371b`, 2026-11-18 23:06 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `17c1daa`(밤 10 기록), `7776830` 비서 양식 더하기가 지금 양식을 못 읽으면 파일을 올리지도 저장하지도 않음(예전엔 빈 목록으로 보아 `template_ids`를 새 양식 하나로 덮어써 있던 양식이 모두 비서에서 빠졌다), 양식 목록·빼기의 읽기 실패 503, 나만의 비서 저장·앱 시험 판 저장·배포도 지금 값을 못 읽으면 503. `741371b` 문서. 가지 Preview(`workon-1wpah29jz`) Ready 뒤 `main`. 배포 전 전체 시험 327파일 4,282개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_AUKCRVfShdJWhyitHMU74ZKmma4n`(76ca53b)로 promote.
- 배포 전 운영 확인: 새 칸·표 없음.
- 배포 뒤 확인: `/login`·`/super/login`·`/api/branding`·`/api/system/maintenance`·`/api/notices`·`/apps` 200, 인증 없는 양식 목록·나만의 비서 저장·앱 시험 판 저장 401. 업무 작업자·실행기 호출 23:08~23:10 KST 모두 200, 최근 24시간 critical 0건·20분 warning 이상 0건. 실패 경로는 운영에서 일으킬 수 없어 시험으로 대신.

## 2026-11-18(밤 10): 관리자의 공개 링크 목록·중단 — 마이그레이션 없음

- 코드 배포 `dpl_AUKCRVfShdJWhyitHMU74ZKmma4n`(커밋 `76ca53b`, 2026-11-18 22:50 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `9d5a8d1`(밤 9 기록), `554909c` 관리자 설정 화면 '공개 링크로 공유 중인 대화'(`SharedLinksPanel`) + `GET /api/admin/shared-conversations`(관리 범위 부서의 공유 중인 대화 200건 — 누가·어느 부서·언제 공유했는지만, 제목·내용·링크 주소 없음, 못 읽으면 503) + `DELETE /api/admin/shared-conversations/[id]`(사유 5~300자, 관리 범위·공유 중일 때만, 주소와 `shared_at`을 버림, 보안 로그 `conversation_unshared_by_admin` high). `76ca53b` 문서. 새 라우트가 든 묶음이라 가지 Preview(`workon-1oyc5vdkd`) Ready를 먼저 본 뒤 `main`. 배포 전 전체 시험 326파일 4,274개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_DFS9DRhxSm5GbsBfx9s3RFx2CDwo`(6eadcf7)로 promote.
- 배포 전 운영 확인: 새 칸·표 없음(밤 9 확인에서 `conversations` 칸 확인, 공유 중인 대화 0 — 배포해도 목록은 비어 있다).
- 배포 뒤 확인: `/login`·`/super/login`·`/api/branding`·`/api/system/maintenance`·`/api/notices` 200, `/admin/settings`는 로그인으로 보냄, 인증 없는 `GET`·`DELETE /api/admin/shared-conversations` 403. 업무 작업자·실행기 호출 22:53~22:55 KST 모두 200, 최근 24시간 critical 0건·20분 warning 이상 0건. **새 패널이 든 설정 화면은 브라우저로 보지 못했다**(관리자 로그인 없음) — 배치는 사용자가 한 번 열어 확인.

## 2026-11-18(밤 9): 대화 공개 공유의 범위·기록 — 마이그레이션 없음

- 코드 배포 `dpl_DFS9DRhxSm5GbsBfx9s3RFx2CDwo`(커밋 `6eadcf7`, 2026-11-18 22:30 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `ab82251`(밤 8 기록), `23f2ffb` 대화 공개 공유 — 공유한 때(`conversations.metadata.shared_at`)까지의 메시지만 공개 조회에 보임(`messagesUntil`, 옛 공유는 전부), '공유 링크 복사'를 다시 누르면 같은 주소로 범위만 갱신, 공유·중단을 보안 로그에(`conversation_shared`·`conversation_unshared` — 대화 id만), 대화 주인의 계정이 사용 중지·탈퇴면 공개 조회 404(확인하지 못해도 404), 공개 응답은 정해 둔 칸만, 사이드바 안내. `6eadcf7` 문서. 가지 Preview(`workon-nrbk549lg`) Ready 뒤 `main`. 배포 전 전체 시험 325파일 4,263개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_sAUYewNmggAicGfuP8J9a38fJ4M5`(dcbf8c1)로 promote.
- 배포 전 운영 확인(읽기 전용): `conversations`에 코드가 쓰는 칸(`share_token`·`is_shared`·`metadata`·`user_id`·`department_id`)이 있음. 대화 14개 중 공유 중 0·토큰만 남은 대화 0·주인 없는 대화 0 — 옛 방식(전체가 보이는)으로 열려 있는 링크는 없다.
- 배포 뒤 확인: `/login`·`/super/login`·`/api/branding`·`/api/system/maintenance`·`/api/notices` 200, 없는 토큰의 공개 조회 `GET /api/shared/{token}` 404(공유 화면 껍데기는 200), 인증 없는 공유 시작·중단 401. 업무 작업자·실행기 호출 22:33~22:35 KST 모두 200, 최근 24시간 critical 0건·20분 warning 이상 0건. 실제로 공유해 범위가 잘리는 것은 운영에서 해 보지 못했다(로그인 없음·운영에 쓰지 않음) — 시험으로 대신.

## 2026-11-18(밤 8): 필터에 걸린 것의 보안 로그·카드번호·주민등록번호 꼴 — 마이그레이션 없음

- 코드 배포 `dpl_sAUYewNmggAicGfuP8J9a38fJ4M5`(커밋 `dcbf8c1`, 2026-11-18 22:14 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `24982af`(밤 7 기록), `23705c7` 대화 준비가 필터에 사람 id를 넘김(`actor.userId` — 예전 `undefined`라 대화에서 걸린 금지어·개인정보가 보안 로그에 한 번도 남지 않았다), 값을 한 번 더 보는 개인정보 규칙(`CHECKED_PATTERNS` — 붙여 쓰거나 띄어 쓴 카드번호는 발급사 첫 자리·Luhn, 띄어 쓴 주민등록번호는 날짜 꼴·뒤 첫 자리 1~8), 겹친 주민등록번호 규칙 하나로, 걸린 글 목록 겹침 없이, 감사 화면 상세 '개인정보 꼴 N곳'. `dcbf8c1` 문서. 가지 Preview(`workon-se7rcs0mv`) Ready 뒤 `main`. 배포 전 전체 시험 324파일 4,246개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_E2pcX6eQJyK4C8nGdW3HorkkbZCy`(f24e063)로 promote.
- 배포 전 운영 확인(읽기 전용): 보안 로그(`security_logs`) 0건 — 대화에서 걸린 것이 남은 적이 없다. 새 칸·표 없음.
- 배포 뒤 확인: `/login`·`/super/login`·`/api/branding`·`/api/system/maintenance`·`/api/notices` 200, `/admin/audit`는 로그인으로 보냄, 인증 없는 `POST /api/chat` 401·`GET /api/admin/audit-logs` 403. 업무 작업자·실행기 호출 22:13~22:15 KST 모두 200, 최근 24시간 critical 0건·20분 warning 이상 0건. 대화에서 실제로 걸려 보안 로그에 남는 것은 운영에서 해 보지 못했다(로그인 없음) — 시험으로 대신. 다음에 누가 금지어·개인정보에 걸리면 `security_logs`에 첫 줄이 생긴다.
- 그대로 둔 것(결정 필요): 긴 숫자 규칙이 나라장터 공고번호(`20261112345-00`)를 막는 것, 사업자등록번호 꼴(`123-45-67890`)을 막는 것.

## 2026-11-18(밤 7): 입력 필터의 읽기 실패·보이지 않는 글자·금지어 저장 — 마이그레이션 없음

- 코드 배포 `dpl_E2pcX6eQJyK4C8nGdW3HorkkbZCy`(커밋 `f24e063`, 2026-11-18 21:53 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `255bd2a`(밤 6 기록), `84376d3` 대화 입력 필터(`src/lib/filter.ts`·`forbidden-match.ts`) — 금지어를 읽지 못해도 개인정보 패턴 검사는 그대로(예전엔 함께 꺼짐), 금지어 검사만 건너뛰고 `system_logs`(error·security, 부서마다 10분에 한 번), 맞춰 볼 때 보이지 않는 서식 글자(`\p{Cf}`)를 금지어·글·개인정보 패턴 검사에서 뺌, 금지어 저장은 다듬어서 2~50자·설명 200자·부서마다 300개, 설정 화면은 켜고 끈 응답을 앞 값에 합침. `f24e063` 문서. 가지 Preview(`workon-pq5xwrgdi`) Ready 뒤 `main`. 배포 전 전체 시험 323파일 4,234개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_8Pphjv5nwFC6wwE6kzcQZZu6iMyH`(11b53f2)로 promote.
- 배포 전 운영 확인(읽기 전용): 금지어 6개(모두 켜짐), 한 글자 금지어 0·50자 넘는 금지어 0·보이지 않는 글자가 든 금지어 0, 부서마다 가장 많은 곳 2개 — 새 규칙에 걸리는 기존 금지어 없음.
- 배포 뒤 확인: `/login`·`/super/login`·`/api/branding`·`/api/system/maintenance`·`/api/notices` 200, `/admin/settings`는 로그인으로 보냄, 인증 없는 `GET`·`POST /api/forbidden-words`·`POST /api/chat` 401. 업무 작업자·실행기 호출 21:53~21:55 KST 모두 200, 최근 24시간 critical 0건·20분 warning 이상 0건. 대화에서 금지어·개인정보가 실제로 걸리는지는 운영에서 해 보지 못했다(로그인 없음) — 시험으로 대신.

## 2026-11-18(밤 6): 내 사용현황에 이번 달 부서 한도 — 마이그레이션 없음

- 코드 배포 `dpl_8Pphjv5nwFC6wwE6kzcQZZu6iMyH`(커밋 `11b53f2`, 2026-11-18 21:38 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `bcd75ae`(밤 5 기록), `d89e604` 내 사용현황(`/my/stats`)에 부서 월 한도 카드 — `myDepartmentBudget`(내 부서의 `monthly_budget_krw`와 `department_spend_krw`, 판정의 부서 부분과 같은 규칙·한국 시간 이번 달, 부서 합계만), 한도가 없으면 카드 없음·못 읽으면 `departmentBudgetUnknown`. `11b53f2` 문서. 가지 Preview(`workon-f6n6q9lwy`) Ready 뒤 `main`. 배포 전 전체 시험 322파일 4,216개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_2yrkLUa3M4EPoHNb7EAtDnxgQr62`(9e6068e)로 promote.
- 배포 전 운영 확인(읽기 전용): `department_spend_krw(uuid, timestamptz, timestamptz)`가 있고 `service_role`이 실행할 수 있으며 실제 호출이 값을 돌려줌. 부서 4개 중 부서 한도를 정한 곳 0·1인당 기본값을 정한 곳 0(당장 이 카드가 보이는 직원은 없다).
- 배포 뒤 확인: `/login`·`/super/login`·`/api/branding`·`/api/system/maintenance`·`/api/notices`·`/my/stats` 200, 인증 없는 `/api/my/stats` 401. 업무 작업자·실행기 호출 21:38~21:40 KST 모두 200, 최근 24시간 critical 0건·20분 warning 이상 0건. 카드가 실제로 보이는 모습은 확인하지 못했다(로그인 없음·운영에 부서 한도가 없음) — 시험으로 대신.

## 2026-11-18(밤 5): 본인 부서 옮기기 막기·관리자 지정/해제 단추 — 마이그레이션 없음

- 코드 배포 `dpl_2yrkLUa3M4EPoHNb7EAtDnxgQr62`(커밋 `9e6068e`, 2026-11-18 21:22 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `3c2bf98`(밤 4 기록), `c9fbd8a` 사용자 관리 — `PATCH /api/users/[id]`가 본인의 소속 부서 옮기기를 400으로 막음(옮기는 순간 관리 범위가 줄어 스스로 되돌릴 수 없다 — 같은 부서 다시 보내기·본인 한도는 그대로), 깨진 요청 400, `GET /api/users` 응답에 `me`, 화면은 본인 줄 '(나)'·부서 드롭다운 막기, **'관리자로 지정/관리자 해제' 단추**(본인·사용 중지 계정 제외, 확인 뒤 `role` — API는 있었지만 화면에 없었다). `9e6068e` 문서. 가지 Preview(`workon-ql5zzthj4`) Ready 뒤 `main`. 배포 전 전체 시험 321파일 4,209개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_49o5bixFccnvZZza3MZsrjcckDr9`(b21851d)로 promote.
- 배포 전 운영 확인: 새 칸·표 없음.
- 배포 뒤 확인: `/login`·`/super/login`·`/api/branding`·`/api/system/maintenance`·`/api/notices` 200, `/admin/users`는 로그인으로 보냄, 인증 없는 `GET /api/users`·`PATCH /api/users/{id}` 403. 업무 작업자·실행기 호출 21:23~21:25 KST 모두 200, 최근 24시간 critical 0건·20분 warning 이상 0건. **새 단추가 든 사용자 관리 화면은 브라우저로 보지 못했다**(관리자 로그인 없음) — 줄 배치는 사용자가 한 번 열어 확인.

## 2026-11-18(밤 4): 기관 업무 설정 권한·업무 현황 범위 — 마이그레이션 없음

- 코드 배포 `dpl_49o5bixFccnvZZza3MZsrjcckDr9`(커밋 `b21851d`, 2026-11-18 21:07 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `8483edc`(밤 3 기록), `fa048d3` 기관 업무 관리(`src/lib/work/admin.ts`) — 바꾸는 일 여섯(업무 켜고 끄기·기관 양식 등록·시험 생성·확인 기록·사용 중지·대화 양식 가져오기)은 기관 전체 관리자만(`requireWholeOrgWorkAdmin`, `WorkActor.managesWholeOrganization`), 보기는 관리자 누구나(양식 목록 `canManage`·화면은 단추를 막고 안내, 대화 비서의 양식 목록은 기관 전체 관리자에게만), 업무 현황은 관리 범위로(`workStats(org, since, departmentIds)` — Postgres 직결·Supabase 두 저장소). `b21851d` 문서. 가지 Preview(`workon-4631ktaop`) Ready 뒤 `main`. 배포 전 전체 시험 320파일 4,201개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_C2rRASFhYB8q2r5hT2RJCBhiVUGn`(37306a9)로 promote.
- 배포 전 운영 확인: 새 칸·표 없음(`work_tasks.department_id`는 저녁 확인에서 부서 외래 키로 확인, 활성 관리자 4명 모두 최상위 부서 소속 — 이번 변경으로 막히는 관리자 없음).
- 배포 뒤 확인: `/login`·`/super/login`·`/api/branding`·`/api/system/maintenance`·`/api/notices` 200, `/admin/work`는 로그인으로 보냄, 인증 없는 업무 관리 API 넷(목록 둘·현황·켜고 끄기) 403, 비밀값 없는 업무 작업자 401. 업무 작업자(1분)·실행기(5분) 호출 21:08~21:10 KST 모두 200, 최근 24시간 critical 0건·20분 warning 이상 0건. 업무 관리 화면은 운영에서 해 보지 못했다(관리자 로그인 없음·운영에 쓰지 않음) — 시험으로 대신.

## 2026-11-18(밤 3): 비서 공식 등록 신청·반려 기록 — 마이그레이션 없음

- 코드 배포 `dpl_C2rRASFhYB8q2r5hT2RJCBhiVUGn`(커밋 `37306a9`, 2026-11-18 20:50 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `34743d4`(밤 2 기록), `c268fde` 공식 등록 신청(`POST /api/agents/personal/[id]/request-approval`)·반려(`POST /api/admin/agents/[id]/reject`) — 신청(누가·어느 판·메모)과 반려(누가·사유)를 비서 변경 기록에(`agent_history` `kind: 'tier'`의 `detail.event` — `official_requested`·`official_rejected`, 기록 탭 문장 `describeHistoryItem`), 반려는 아직 승인 대기일 때만(`.eq('approval_status', 'pending')` — 바뀐 줄이 없으면 409, 예전엔 그 사이 승인된 비서의 상태를 '반려'로 덮었다), 반려 응답은 id·상태·사유만, 사유 500자·깨진 요청 400, 신청은 그 사이 지워졌으면 404. `37306a9` 문서. 가지 Preview(`workon-mlmlk9rjs`) Ready 뒤 `main`. 배포 전 전체 시험 319파일 4,185개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_77Wdbgq97AYnzQDe8ePJcDGJihPg`(8a4680a)로 promote.
- 배포 전 운영 확인(읽기 전용): `agent_history.kind` CHECK에 `tier`가 있고(판 번호 없는 종류라 사본 CHECK도 통과), 코드가 쓰는 칸이 모두 있음. 지우지 않은 비서 42개 모두 승인 상태 없음(NULL — 신청·반려가 한 번도 없었다), 변경 기록은 `migrated` 42·`settings` 3·`document_added` 2·`document_removed` 1.
- 배포 뒤 확인: `/login`·`/super/login`·`/api/branding`·`/api/system/maintenance`·`/api/notices` 200, `/admin/agents`는 로그인으로 보냄, 인증 없는 반려 403·신청 401. 실행기 호출 20:55 KST 200, 최근 24시간 critical 0건·20분 warning 이상 0건. 신청·반려는 운영에서 해 보지 못했다(로그인 없음·운영에 쓰지 않음) — 시험으로 대신.

## 2026-11-18(밤 2): 기관 정보 저장 응답·접속 허용 IP 변경 기록 — 마이그레이션 없음

- 코드 배포 `dpl_77Wdbgq97AYnzQDe8ePJcDGJihPg`(커밋 `8a4680a`, 2026-11-18 20:33 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `4132125`(밤 기록), `2766a87` 기관 정보 저장(`PATCH /api/admin/organization`) — 저장 응답을 조회와 같은 칸으로(`organizationPayload`·`ORG_COLUMNS` — 예전 응답에는 `allowed_ips`·`currentIp`·`availableModels`가 없어 저장 뒤 IP 칸이 비고 모델 목록이 사라졌고, 그대로 한 번 더 저장하면 접속 허용 IP가 지워졌다), 화면은 응답을 앞 값에 합침, 접속 허용 IP 변경 `org_access_ips_changed`(high·전후 목록)·기관 정보 변경 `organization_updated`(low)를 보안 로그에, 모델 정책 이력은 실제로 달라졌을 때만, 고치기 전 값·요청자 부서를 못 읽으면 저장하지 않음(503). `8a4680a` 문서. 가지 Preview(`workon-10zn56i71`) Ready 뒤 `main`. 배포 전 전체 시험 318파일 4,174개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_CXxWfXxohUxHi4bmbxsP7bj2rvKJ`(268f32d)로 promote.
- 배포 전 운영 확인(읽기 전용): `organizations`에 코드가 읽는 칸 열둘이 모두 있음. 기관 2곳 중 접속 허용 IP를 정한 곳 0·허용 모델을 정한 곳 1·로고 1. 모델 정책 이력 2줄 중 전후가 같은 줄 1(이름만 고쳐도 쌓이던 것). 기관 정보 보안 로그 0.
- 배포 뒤 확인: `/login`·`/super/login`·`/api/branding`·`/api/system/maintenance`·`/api/notices` 200, `/admin/organization`은 로그인으로 보냄, 인증 없는 `GET`·`PATCH /api/admin/organization` 403. 실행기 호출 20:35 KST 200, 최근 24시간 critical 0건·20분 warning 이상 0건. 기관 정보 화면의 저장은 운영에서 해 보지 못했다(관리자 로그인 없음·운영에 쓰지 않음) — 시험으로 대신.

## 2026-11-18(밤): CSV 일괄 등록 관리 범위·계정 만들기 기록 — 마이그레이션 없음

- 코드 배포 `dpl_CXxWfXxohUxHi4bmbxsP7bj2rvKJ`(커밋 `268f32d`, 2026-11-18 20:18 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `c8c8285`(저녁 기록), `3125c45` CSV 일괄 등록(`POST /api/admin/bulk-register`) — 있는 부서·상위로 적은 부서는 관리 범위 안일 때만(예전엔 기관 안의 아무 부서나 이름으로 찾아, 하위 부서 관리자가 기관 직속 부서에 관리자 계정을 만들 수 있었다), 새 부서는 기관 직속 관리자가 아니면 자기 부서 아래로, 부서·등록 여부 읽기 실패는 그 줄만 실패·요청자 부서 읽기 실패는 503. 계정 만들기를 보안 로그에 — `POST /api/users`는 `user_created`(관리자 high·직원 low), 일괄 등록은 관리자 계정마다 `user_created` + 수만 한 줄 `users_bulk_created` + 새 부서마다 `department_created`(이메일·임시 비밀번호 없음). 대리 접근 중 관리자 계정 만들기는 두 길 모두 막음. `POST /api/users`는 등록 여부 읽기 실패 500·이메일 꼴·겹침(23505) 안내. `268f32d` 문서. 가지 Preview(`workon-b41mt8az5`) Ready 뒤 `main`. 배포 전 전체 시험 317파일 4,157개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_8DFX87UKzpcaU6mZJRAUhJVZNwbu`(5ab8efb)로 promote.
- 배포 전 운영 확인: 새 칸·표 없음(저녁 배포 전 확인에서 `departments.parent_id`·`security_logs` 칸 확인, 활성 관리자 4명 모두 최상위 부서 소속 — 관리 범위 검사로 막히는 관리자 없음).
- 배포 뒤 확인: `/login`·`/super/login`·`/api/branding`·`/api/system/maintenance`·`/api/notices` 200, `/admin/users`는 로그인으로 보냄, 인증 없는 `GET`·`POST /api/users`·`POST /api/admin/bulk-register` 403. 실행기 호출 20:20 KST 200, 최근 24시간 critical 0건·20분 warning 이상 0건. 일괄 등록·직원 등록은 운영에서 해 보지 못했다(관리자 로그인 없음·운영에 쓰지 않음) — 시험으로 대신.

## 2026-11-18(저녁): 비서 카테고리 바꾸기 권한·부서 삭제 판정·부서 변경 기록 — 마이그레이션 없음

- 코드 배포 `dpl_8DFX87UKzpcaU6mZJRAUhJVZNwbu`(커밋 `5ab8efb`, 2026-11-18 19:52 KST, `main` fast-forward, 사용자 "운영반영"). 세 묶음을 모아 한 번에. 들어간 커밋: `c4c9941`(오후 4 기록), `ed74ac6` 비서 카테고리(`/api/admin/agent-categories`) — 바꾸기(추가·이름·순서·삭제)는 기관 전체 관리자만(목록은 관리자 누구나·응답 `canEdit`으로 화면이 단추를 숨김), 이름만 바뀌고 비서를 못 옮기면 이름을 되돌림(예전엔 '다시 시도'가 아무 일도 안 하고 성공), 순서 저장이 카테고리를 못 읽으면 성공 대신 500, 묶인 비서 수는 지운 비서·나만의 비서를 빼고 못 세면 null, 부서·대상 읽기 실패는 503, 이름 다듬기. `48a4b0d` 부서(`/api/departments`·`[id]`) — 삭제는 `checkDepartmentDelete`가 남은 것을 본 뒤에만(못 세면 503 — 예전엔 조회 오류가 '없음'이 되어 지웠다, 이 부서로 남은 기록이 있으면 409), 부서 목록의 직원·비서 수는 탈퇴 계정·지운 비서를 빼고 못 세면 null, 부서 만들기·고치기(실제로 달라진 것만 전후 값 — 상위 부서 high·한도 medium·이름 low)·삭제를 보안 로그에(`department_created`·`department_updated`·`department_deleted`)·감사 화면 상세. `5ab8efb` 문서. 가지 Preview(`workon-khhh755dr`) Ready 뒤 `main`. 배포 전 전체 시험 316파일 4,140개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_BjmJPSzP3fM9BtJ2CboRGnzS15Uj`(9b188c9)로 promote.
- 배포 전 운영 확인(읽기 전용): 새 코드가 읽는 칸(부서·비서·카테고리·직원·초대·보안 로그, 기록 표 열둘의 `department_id`)이 모두 있음. 부서를 가리키는 외래 키 표 18개가 시험 DB와 같고 다루지 않는 표 없음. 부서 4개 모두 최상위, 활성 관리자 4명 모두 최상위 부서 소속(카테고리를 못 바꾸게 되는 하위 부서 관리자 0), 카테고리 11개(기관 2), 예전 검사로 지울 수 있던 부서 0, 부서 사건 보안 로그 0.
- 배포 뒤 확인: `/login`·`/super/login`·`/api/branding`·`/api/system/maintenance`·`/api/notices` 200, `/admin/departments`·`/admin/agents`는 로그인으로 보냄, 인증 없는 `GET /api/departments`·`DELETE /api/departments/{id}`·`GET /api/admin/agent-categories`·`PATCH /api/admin/agent-categories/{id}` 403. 실행기 호출 19:55 KST 200, 최근 24시간 critical 0건·20분 warning 이상 0건. 카테고리 창·부서 화면·감사 화면의 새 기록은 운영에서 해 보지 못했다(관리자 로그인 없음·운영에 쓰지 않음) — 시험으로 대신.

## 2026-11-18(오후 4): 기관 관리자의 직원 초대·취소 기록 — 마이그레이션 없음

- 코드 배포 `dpl_BjmJPSzP3fM9BtJ2CboRGnzS15Uj`(커밋 `9b188c9`, 2026-11-18 17:10 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `40214be`(오후 3 기록), `a7900f9` 기관 관리자의 직원 초대(`/api/admin/invite`) — 만들기 `user_invited`(관리자 초대는 high, 초대 열쇠 없음)·취소 `user_invite_canceled`를 보안 로그에, 취소는 수락하지 않은 초대만(지운 것이 없으면 404 — 예전엔 수락된 초대까지 지워 마지막 흔적이 사라짐), 대리 접근 중 관리자 초대 403, 가입·초대 여부 읽기 실패는 '없음' 대신 500, 이메일 꼴·권한 값 확인, 사용자 수 상한에 닿았으면 만들지 않음(확인을 못 하면 만듦), 목록·취소는 관리 범위, 화면은 취소 응답을 봄, `9b188c9` 문서. 가지 Preview(`workon-bwsptrs84`) Ready 뒤 `main`. 배포 전 전체 시험 313파일 4,080개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_EH3VYyvDUeGMRXVRVcQegmqwYbVm`(ea162a1)로 promote.
- 배포 전 운영 확인(읽기 전용): `invitations`에 코드가 쓰는 칸(id·email·department_id·role·token·invited_by·expires_at·accepted_at·created_at)이 모두 있고 CHECK 없음, 1행(수락된 관리자 초대 — 이제 취소로 지워지지 않는다), 부서 없는 초대 0.
- 배포 뒤 확인: `/login`·`/super/login`·`/api/branding`·`/api/system/maintenance`·`/api/notices` 200, 인증 없는 `GET /api/admin/invite`·`DELETE /api/admin/invite/{id}` 403·`/admin/users`는 로그인으로 보냄. 실행기 호출 17:15 KST 200, 최근 24시간 critical 0건·20분 warning 이상 0건. 사용자 관리 화면의 초대는 운영에서 해 보지 못했다(관리자 로그인 없음·운영에 쓰지 않음) — 시험으로 대신.

## 2026-11-18(오후 3): 설정 화면 보안 이벤트 로그가 기록 원문을 내보내지 않음 — 마이그레이션 없음

- 코드 배포 `dpl_EH3VYyvDUeGMRXVRVcQegmqwYbVm`(커밋 `ea162a1`, 2026-11-18 15:51 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `1f13ed5`(오후 2 기록), `e98c53b` 관리자 설정 화면 '보안 이벤트 로그'(`GET /api/security-logs`)가 기록 원문(`details` — 금지어 기록에는 직원 질문 앞 100자)을 싣지 않고 사건 이름·심각도(한국어)와 상세 한 줄(`securityDetailParts`)만, 범위는 관리 범위(예전엔 자기 부서만), 수·대상 이름을 못 읽으면 500, 화면은 원문 펼치기를 없애고 실패를 '없음'으로 보이지 않음, 이름표는 감사 화면과 한 곳(`SECURITY_EVENT_LABELS` — `src/lib/security-event-text.ts`), `ea162a1` 문서. 가지 Preview(`workon-7yqdlzpgk`) Ready 뒤 `main`. 배포 전 전체 시험 312파일 4,060개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_6jyTpmPu3uyQoLuuVxWWbDT76nhj`(7f9e2b4)로 promote.
- 운영 `security_logs`는 0행(오후 2 배포 전 확인) — 운영에서 이 길로 보인 질문은 없다.
- 배포 뒤 확인: `/login`·`/super/login`·`/api/branding`·`/api/system/maintenance`·`/api/notices` 200, 인증 없는 `/api/security-logs` 401·`/api/admin/audit-logs` 403·`/admin/settings`는 로그인으로 보냄. 실행기 호출 15:55 KST 200, 최근 24시간 critical 0건·20분 warning 이상 0건. 설정 화면은 운영에서 보지 못했다(관리자 로그인 없음) — 시험으로 대신.

## 2026-11-18(오후 2): 직원 권한·부서·한도 변경 기록과 감사 화면 보안 이벤트 — 마이그레이션 없음

- 코드 배포 `dpl_6jyTpmPu3uyQoLuuVxWWbDT76nhj`(커밋 `7f9e2b4`, 2026-11-18 15:06 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `049dc26`(오후 기록), `0e4e1de` 기관 관리자의 직원 정보 수정(`PATCH /api/users/[id]`)이 권한(`user_role_changed`, high)·부서(`user_department_changed`)·개인 월 한도(`user_budget_changed`)를 전후 값과 함께 보안 로그에(달라진 것만, 부서는 그때의 이름도), 슈퍼관리자·탈퇴 계정은 대상에서 빼고 대상을 못 읽으면 500, 대리 접근 중 권한 변경 403, 너무 큰 한도 400. 감사 화면 '보안 이벤트' 이름표를 실제 사건 종류에 맞추고(금지어·개인정보 감지·업로드 차단·IP 차단 등이 코드 그대로 보였다) 상세에 대상 이름(관리 범위 안만)·사유·전후 값(`securityDetailParts`), `7f9e2b4` 문서. 가지 Preview(`workon-g3h8yxp1e`) Ready 뒤 `main`. 배포 전 전체 시험 311파일 4,049개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_GPk4kTymvDyFnv1jDxNM1EBVgcfs`(c7f9d5f)로 promote.
- 배포 전 운영 DB(읽기 전용): `security_logs`에 사건 종류·심각도를 막는 CHECK 없음(기본 키·외래 키 둘뿐) — 새 사건 종류가 거절되지 않는다. `users.is_super_admin`·`deleted_at`·`monthly_budget_krw` 있음. `security_logs`는 0행(표가 2026-11-16에 생김).
- 배포 뒤 확인: `/login`·`/super/login`·`/api/branding`·`/api/system/maintenance`·`/api/notices` 200, 인증 없는 `/api/admin/audit-logs`·`PATCH /api/users/{id}` 403·`/admin/audit`은 로그인으로 보냄. 실행기 호출 15:10 KST 200, 최근 24시간 critical 0건·20분 warning 이상 0건. 감사 화면·실제 기록은 운영에서 보지 못했다(관리자 로그인 없음, 운영 DB에 쓰지 않음) — 시험으로 대신.

## 2026-11-18(오후): 관리자 대시보드·통계 첫 카드를 관리 범위로 — 마이그레이션 없음

- 코드 배포 `dpl_GPk4kTymvDyFnv1jDxNM1EBVgcfs`(커밋 `c7f9d5f`, 2026-11-18 14:45 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `d11067d`(낮 3 기록), `52bfeb0` 기관 관리자 대시보드(`/admin`)·통계(`/admin/stats`)의 첫 카드(`GET /api/stats`)를 관리 범위(자기 부서 + 하위, 기관 직속 부서 관리자는 기관 전체)로 — 문서(지난 판 제외)·비서(지운 비서·나만의 비서 제외)·사용자(사용 중·탈퇴 안 함)·대화·메시지, 토큰은 이번 달(한국 시간)만(`monthlyTokens`), 읽기 실패는 0 대신 503, 옛 보고서 템플릿 수·늘 '정상'인 시스템 상태 카드 뺌, 최근 활동 이름표 채움(`chat_message` 등), '사용량 추이'(`/api/stats/usage`)도 읽기 실패는 503·토큰은 숫자만, `c7f9d5f` 문서. 가지 Preview(`workon-86urez0i0`) Ready 뒤 `main`. 배포 전 전체 시험 310파일 4,031개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_6iEpMy1WjCq3uS8anZMFsczfrAHd`(85801e7)로 promote.
- 배포 전 운영 DB(읽기 전용, 수만): 새 코드가 읽는 칸(`documents.retired_at`·`agents.deleted_at`·`agents.tier`·`users.deleted_at`·`users.is_active`) 있음. 부서 3곳인 기관의 최상위 부서 관리자 기준 — 비서 21(옛 규칙: 자기 부서·지운 것 포함) → 23(새 규칙: 기관 전체·지운 것·나만의 비서 제외), 문서 3·사용자 4·대화 14는 같음, 토큰을 세는 기록은 전 기간 36건 → 이번 달 2건. 부서 1곳인 기관은 같음(비서 19·사용자 1).
- 배포 뒤 확인: `/login`·`/super/login`·`/api/branding`·`/api/system/maintenance`·`/api/notices` 200, 인증 없는 `/api/stats` 401·`/api/stats/usage` 403·`/admin`은 로그인으로 보냄. 실행기 호출 14:50 KST 200, 최근 24시간 critical 0건·20분 warning 이상 0건. 관리자 화면은 운영에서 보지 못했다(관리자 로그인 없음) — 시험으로 대신.

## 2026-11-18(낮 3): 내 사용현황에 이번 달 개인 한도 — 마이그레이션 없음

- 코드 배포 `dpl_6iEpMy1WjCq3uS8anZMFsczfrAHd`(커밋 `85801e7`, 2026-11-18 13:20 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `10813ef`(낮 2 기록), `5a842ea` 직원 '내 사용현황'에 이번 달 개인 한도 카드(사용액 / 한도·%·한도에 닿으면 멈춤 안내 — `myMonthlyBudget`, 판정과 같은 규칙: 개인 값 우선·부서 기본값·`user_spend_krw`), 한도가 없으면 카드 없음, 못 읽으면 0원 대신 '확인하지 못함'(나머지 통계는 그대로), `85801e7` 문서. 가지 Preview(`workon-10qa2vl2n`) Ready 뒤 `main`. 배포 전 전체 시험 309파일 4,013개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_6AqakBC6XY5X6mVXEedxDMzSb2eL`(79dec02)로 promote.
- 배포 전 운영 DB(읽기 전용): `users.monthly_budget_krw`·`departments.user_monthly_budget_krw`·함수 `user_spend_krw`(service_role 실행 권한) 있음. **개인 한도·부서 기본값·부서 한도를 정한 곳이 0** — 지금은 누구에게도 카드가 뜨지 않는다.
- 배포 뒤 확인: `/login`·`/super/login`·`/api/branding`·`/api/system/maintenance`·`/api/notices`·`/my/stats` 200, 인증 없는 `/api/my/stats` 401. 실행기 호출 13:20 KST 200, 최근 24시간 critical 0건·20분 warning 이상 0건. 카드가 뜬 모습은 운영에서 보지 못했다(한도가 걸린 직원 없음·직원 로그인 없음) — 시험으로 대신.

## 2026-11-18(낮 2): 내 사용현황 토큰을 기록한 실제 사용량으로 — 마이그레이션 없음

- 코드 배포 `dpl_6AqakBC6XY5X6mVXEedxDMzSb2eL`(커밋 `79dec02`, 2026-11-18 13:06 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `9d22865`(낮 기록), `f8d836e` 직원 '내 사용현황'(`/api/my/stats`)의 토큰을 대화 글자 수 ÷ 4 어림 대신 본인의 사용 기록(`usage_logs` — 토큰을 쓴 모든 활동, `sumMyTokens`)으로, 비서별 토큰도 기록(`details.agent_id`) 기준, 메시지 글 전체를 읽던 두 조회를 없앰, 읽기 실패는 0건·0토큰 대신 503, `79dec02` 문서. 가지 Preview(`workon-lmnxb2q39`) Ready 뒤 `main`. 배포 전 전체 시험 308파일 4,002개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_F1HKP3VcGiJyYbQWeVqYMAjyrD8y`(f307d8c)로 promote.
- 배포 뒤 확인: `/login`·`/super/login`·`/api/branding`·`/api/system/maintenance`·`/api/notices`·`/my/stats` 200, 인증 없는 `/api/my/stats` 401. 실행기 호출 13:07 KST 200, 최근 24시간 critical 0건·20분 warning 이상 0건. 운영 DB(읽기 전용·숫자만): 이번 달 쓴 직원 1명 — 기록한 토큰 10,820, 옛 어림(글자 수 ÷ 4)으로는 135(약 80분의 1로 보였다). 직원 화면은 직원 로그인이 없어 직접 보지 않았다.

## 2026-11-18(낮): 사용량 화면 한도 사용률을 이번 달 토큰으로 — 마이그레이션 없음

- 코드 배포 `dpl_F1HKP3VcGiJyYbQWeVqYMAjyrD8y`(커밋 `f307d8c`, 2026-11-18 12:48 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `ec764f0`(오전 2 기록), `8a3f4af` 슈퍼관리자 사용량 화면의 기관별 한도 사용률을 고른 기간이 아니라 이번 달 토큰(`loadChatTokensByOrg` — 한도 판정과 같은 셈)으로, 기관 목록을 못 읽으면 '알 수 없음'·'한도 없음' 대신 500·화면 안내, 실시간 카드는 못 읽으면 503·토큰은 숫자만, `f307d8c` 문서. 가지 Preview(`workon-fu3gzazob`) Ready 뒤 `main`. 배포 전 전체 시험 307파일 3,993개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_DCXztmSDQj7d7t1kuAFVDLN6cpgf`(7817c3b)로 promote.
- 배포 뒤 확인: `/login`·`/super/login`·`/api/branding`·`/api/system/maintenance`·`/api/notices` 200, 인증 없는 `/api/super/usage`·`/realtime` 401. 실행기 호출 12:49 KST 200, 최근 24시간 critical 0건·20분 warning 이상 0건. 슈퍼관리자 화면(읽기만): 열 이름 '이번 달 한도 사용률', '이번 달' 기본 기관 10,697토큰 = 한도 판정 값(1%), 직접 고른 2026-09-01~11-18은 기간 토큰 582,825(옛 셈이면 58%)인데 이제 이번 달 10,697로 1%, 실시간 200.

## 2026-11-18(오전 2): 한도를 읽지 못해 연 것을 알림 — 마이그레이션 없음

- 코드 배포 `dpl_DCXztmSDQj7d7t1kuAFVDLN6cpgf`(커밋 `7817c3b`, 2026-11-18 11:08 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `9fb9f77`(오전 기록), `4fa5c28` 사용 한도 판정이 읽기 실패로 허용한 단계를 `unverified`로 돌려주고 운영 기록(error·payment, 부서·단계만)에 부서마다 10분에 한 번(`reportLimitGaps`) — 예전엔 부서·기관·계약·부서/개인 한도 읽기 오류를 보지 않아 기관 미연결·한도 없음과 같게 열었고(기관 정지 확인도 건너뜀) 어디에도 안 남았다. 관리자 예산 현황은 그때 사용 0 대신 503·화면 안내, 예산 알림(`organizationBudgetStatus`)은 계약을 못 읽으면 던짐(보내지 않음). 대화는 그대로 막지 않음. `7817c3b` 문서. 가지 Preview(`workon-nl5lwlkb4`) Ready 뒤 `main`. 배포 전 전체 시험 306파일 3,985개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_7KeC2mmXRnKkKFQrGtxciFNGpwsC`(9926c19)로 promote.
- 배포 뒤 확인: `/login`·`/super/login`·`/api/branding`·`/api/system/maintenance`·`/api/notices` 200, 인증 없는 `/api/admin/budget` 403. 실행기 호출 11:08 KST 200, 최근 24시간 critical 0건·20분 warning 이상 0건(새 '한도를 확인하지 못해' 기록 없음). 읽기 실패 경로는 운영에서 일부러 일으킬 수 없어 시험으로 대신.

## 2026-11-18(오전): 계약 화면 요약 카드 — 마이그레이션 없음

- 코드 배포 `dpl_7KeC2mmXRnKkKFQrGtxciFNGpwsC`(커밋 `9926c19`, 2026-11-18 10:17 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `dea6cce`(아침 3 기록), `2441df0` 슈퍼관리자 계약 화면 요약 카드를 대시보드와 같은 규칙으로(`contractsSummary` — 활성 = 끝날 날이 지나지 않은 활성 계약, 만료 임박 = 그중 30일 안, '이번 달 매출' = 이번 달(한국 시간)에 유효했던 계약, 쪽마다 끝까지 읽고 못 읽으면 503; 예전엔 상태가 활성인 계약을 모두 세고 더해 끝난·시작 전 계약까지 들고 이번 달 해지 계약은 빠졌으며 못 읽으면 0), `9926c19` 문서. 가지 Preview(`workon-3ary45kn4`) Ready 뒤 `main`. 배포 전 전체 시험 305파일 3,972개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_G5DN9XFYxVgHuimNaDQKptXsFu69`(28eb99d)로 promote.
- 배포 뒤 확인: 운영 브라우저(슈퍼관리자) 계약 화면 요약 2건·0건·1,090,000원('이번 달 매출'), API `summary` 같음 — 운영 계약 둘 다 끝날 날 없는 활성이라 고치기 전과 숫자가 같다. 인증 없는 `/api/super/contracts` 401. `/login`·`/super/login`·`/api/branding`·`/api/system/maintenance`·`/api/notices` 200. 실행기 호출 10:27 KST 200, 최근 24시간 critical 0건·20분 warning 이상 0건.

## 2026-11-18(아침 3): 여러 턴 대화 이력 순서 — 마이그레이션 없음

- 코드 배포 `dpl_G5DN9XFYxVgHuimNaDQKptXsFu69`(커밋 `28eb99d`, 2026-11-18 08:54 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `0b01488`(아침 2 기록), 고침 — 한 턴의 질문·답은 `created_at`이 같아(운영 10턴 모두) 시각만으로 줄 세우면 이력(`loadHistory`)이 질문1 → 답2처럼 한 칸씩 밀린 채 모델에 가던 것(첫 답은 빠짐, 오류 없음)을 같은 시각이면 역할로 가르게(이력은 `created_at desc, role asc`, 대화 열기·공유 화면은 `created_at asc, role desc`), `28eb99d` 문서. 가지 Preview(`workon-duw73khce`) Ready 뒤 `main`. 배포 전 전체 시험 304파일 3,962개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_J2XTcvJ7F4QPhGx7R1VQSRZX4gTy`(f0e4b22)로 promote.
- 배포 전 확인(운영, 읽기 전용): 옛 순서로 3턴 대화 최신순이 `uauaua`(= 뒤집으면 밀림), 새 순서로 이력·화면 모두 `uauaua` 시간순(질문 → 그 답). 배포 뒤: `/login`·`/super/login`·`/api/branding`·`/api/system/maintenance`·`/api/notices` 200, 없는 공유 토큰 404. 실행기 호출 08:54 KST 200, 최근 24시간 critical 0건·20분 warning 이상 0건. 운영에 공유된 대화가 없어 공유 화면은, 직원 로그인이 아니라 대화 열기는 실제로 보지 못함(배포 전 같은 조회로 확인).

## 2026-11-18(아침 2): 읽기 실패를 판정에 쓰지 않기 — 마이그레이션 없음

- 코드 배포 `dpl_J2XTcvJ7F4QPhGx7R1VQSRZX4gTy`(커밋 `f0e4b22`, 2026-11-18 08:40 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `b655395`·`87a2e74`(아침 기록·화면 확인), 고침 — 부서 이동 순환 검사가 하위 부서를 `departmentDescendantsStrict`로 읽어 못 읽으면 503(예전엔 실패가 '하위 없음'이 되어 자기 하위 밑으로 옮기는 이동을 통과), 관리자 부서 읽기 실패 503, 비서 설정 저장은 지금 값을 못 읽으면 503(예전엔 빈 값으로 보고 판정), 슈퍼관리자 공지 목록 못 읽으면 503, `f0e4b22` 문서. 가지 Preview(`workon-b24umiz5y`) Ready 뒤 `main`. 배포 전 전체 시험 303파일 3,958개 통과·tsc 0(시험 DB가 꺼져 있어 다시 켜고 돌림).
- 되돌릴 때는 직전 `dpl_43V145QjanEUdrj9w9azsA12v2nK`(e12fc62)로 promote.
- 배포 뒤 확인: 운영 브라우저(슈퍼관리자)에서 공지 목록 API 200·1건·대시보드 200. `/login`·`/super/login`·`/api/branding`·`/api/system/maintenance`·`/api/notices` 200. 실행기 호출 08:40 KST 200, 최근 24시간 critical 0건·20분 warning 이상 0건. 부서 이동·비서 저장은 운영 데이터를 바꾸는 일이라 돌려 보지 않음(시험으로 대신).

## 2026-11-18(아침): 한도 증량 저장·직원 공지·찾기 글 감싸기 — 마이그레이션 없음

- 코드 배포 `dpl_43V145QjanEUdrj9w9azsA12v2nK`(커밋 `e12fc62`, 2026-11-18 08:09 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `66b6c1f`(새벽 2 기록), `bc2d881` 사용량 화면 '한도 증량' 저장(기관 PATCH `monthly_token_limit` 0~1조 정수·조작 기록 전·후, 요금제 값 검사, 화면 실패 이유, 사용량 CSV 감싸기·수식 주입 막기), `7bf4fc4` 직원 공지가 보이게(`/api/notices`가 대상 칸을 고르지 않은 채 그 칸으로 걸러 모든 공지가 빠지던 것 — 대상·발행·기한을 DB 조회에서, 못 읽으면 503), `5d6bb01` 찾기 글을 PostgREST 필터에 큰따옴표로 감싸 넣기(`src/lib/postgrest-search.ts` — 슈퍼관리자 계정 관리·기관 상세 사용자 찾기가 쉼표 하나로 깨지던 것)·업무 작업 목록 커서 ISO 시각·uuid만·기관 상세 사용량 예상 비용은 기록한 원가, `e12fc62` 문서. 가지 Preview(`workon-pihkcw6ho`) Ready 뒤 `main`. 배포 전 전체 시험 302파일 3,952개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_DwrauwuDzH3dQfgFeheSbTYc1Jn5`(c3934c1)로 promote.
- 배포 전 확인(운영, 읽기 전용): 발행된 전체 공지 1건('제목 테스트', 2026-04-27)·읽음 0건 — 배포로 모든 직원 화면 띠에 뜬다. 큰따옴표 감싼 `.or()` 필터를 운영 PostgREST에 직접 — 옛 꼴(`email.ilike.%a,b%`) 오류, 새 꼴은 쉼표·점·괄호가 든 값도 정상(점 5건·쉼표 0건·괄호 0건).
- 배포 뒤 확인: `/login`·`/super/login`·`/api/branding`·`/api/system/maintenance` 200, `/api/notices` 무인증 200 빈 목록. 실행기 호출 08:10 KST 200, 최근 24시간 critical 0건·20분 warning 이상 0건. 사용자가 다시 로그인한 뒤 운영 브라우저(읽기 전용): 계정 관리 찾기 `a,b`·`x)y(` 200(0건, 예전엔 오류)·`.` 3건(이메일 점 그대로 찾힘)·한글 이름 1건, 기관 상세 사용자 찾기 `.` 4건, 기관 목록 찾기 `기본,` 200, 기관 상세 사용량 비용 $0.0381·10,697 토큰(사용량 모니터링과 같음), 사용량 화면 정상. '한도 증량' 창은 경고·초과 기관이 없어 열리지 않았고, 잘못된 값으로 PATCH를 보내 400을 보려던 확인은 운영 쓰기 요청이라 권한 확인에서 막혀 하지 않았다(시험 `batch-0146`으로 대신). 직원 공지 띠는 직원 로그인이 아니라 보지 못했다.

## 2026-11-18(새벽 2): 슈퍼관리자 대시보드·사용량 숫자 — 마이그레이션 없음

- 코드 배포 `dpl_DwrauwuDzH3dQfgFeheSbTYc1Jn5`(커밋 `c3934c1`, 2026-11-18 00:31 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `b9aadd5`(새벽 기록), `0531f21` 고침 — 대시보드 '오늘 활성'은 서로 다른 사람 수(예전엔 오늘 대화 기록 수)·'전체 사용자'·'이번달 신규'에서 탈퇴 처리한 계정 빼기·예상 비용은 기록한 원가(`sumCostUsd`, 대시보드·사용량 모니터링 전체·기관별)·토큰은 숫자만, `c3934c1` 문서. 가지 Preview(`workon-hkb93udq8`) Ready 뒤 `main`. 배포 전 전체 시험 299파일 3,934개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_2ub3GC9uiwqUkM5Wa5dvi3vbmkEq`(4f35c77)로 promote.
- 배포 뒤 확인(운영 브라우저, 읽기 전용): 대시보드 전체 사용자 3·오늘 활성 0·이번 달 토큰 10,697·예상 비용 $0.0381, 사용량 모니터링 요약·기관별(기본 기관 10,697 토큰·$0.0381)과 같음. `/login`·`/super/login`·`/api/branding`·`/api/system/maintenance` 200, 대시보드 무인증 401. 실행기 호출 00:31 KST 200, 최근 24시간 critical 0건·20분 warning 이상 0건.

## 2026-11-18(새벽): 계약 매출 한 규칙 — 마이그레이션 없음

- 코드 배포 `dpl_2ub3GC9uiwqUkM5Wa5dvi3vbmkEq`(커밋 `4f35c77`, 2026-11-18 00:13 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `ea79c0a`(밤 7 기록), `272f891` 고침 — `src/lib/contract-revenue.ts`(그달(한국 시간)에 하루라도 유효했던 계약, 해지는 해지한 때까지)를 대시보드 '이번달 매출'·계약 '매출 현황'(그해 전 시작한 계약도·앞날의 달 제외)이 씀, `4f35c77` 문서. 가지 Preview(`workon-gbiewb644`) Ready 뒤 `main`. 배포 전 전체 시험 298파일 3,929개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_AoKf6kr9rKLfze2UaYSuNrgRVRcB`(0456e86)로 promote.
- 배포 뒤 확인(운영 브라우저, 읽기 전용): 대시보드 이번 달·지난달 매출 1,090,000원(배포 전 0원)·전월 대비 0%. 2026년 매출 현황 4~11월 각 1,090,000원·12월 0(앞날)·연간 8,720,000원. `/login`·`/super/login`·`/api/branding`·`/api/system/maintenance` 200, 매출 API 무인증 401. 실행기 호출 00:12 KST 200, 최근 24시간 critical 0건·20분 warning 이상 0건.

## 2026-11-17(밤 7): 기관 이번 달 토큰 한 규칙 — 마이그레이션 없음

- 코드 배포 `dpl_AoKf6kr9rKLfze2UaYSuNrgRVRcB`(커밋 `0456e86`, 2026-11-17 23:24 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `8ecd0bb`(밤 6 기록), `38d5da6` 고침 — `src/lib/org-chat-tokens.ts`(한도 판정 `organization_chat_tokens`와 같은 셈)를 기관 목록(뷰 값 대신)·대시보드(이번 달 기록 한 번만)·사용량 경보(못 읽으면 503)가 씀, `0456e86` 문서. 가지 Preview(`workon-25uucghc7`) Ready 뒤 `main`. 배포 전 전체 시험 297파일 3,920개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_4EWKm6dRupvwBLysu5yMZfpdfpaF`(c157bcd)로 promote.
- 배포 뒤 확인(운영 브라우저, 읽기 전용): 기관 목록·기관 상세·대시보드 Top 5의 이번 달 토큰이 같음 — '기본 기관' 10,697(배포 전 목록은 10,820)·'해외농업자원개발협회' 0, 사용량 경보 200. `/login`·`/super/login`·`/api/branding`·`/api/system/maintenance` 200, 경보 무인증 401. 실행기 호출 23:25 KST 200, 최근 24시간 critical 0건·20분 warning 이상 0건.

## 2026-11-17(밤 6): 기관 로그인 경로(slug) — 마이그레이션 없음

- 코드 배포 `dpl_4EWKm6dRupvwBLysu5yMZfpdfpaF`(커밋 `c157bcd`, 2026-11-17 23:13 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `564e5ce`(밤 5 기록), `a68394e` 고침 — 슈퍼관리자 기관 등록이 입력한 Slug를 `organizations.slug`에 저장(규칙 `org-slug.ts` — 기관 관리자와 같음, 다른 기관과 겹치면 409), 기관 상세 '로그인 주소'가 `/signin/{slug}`를 보이고 복사(예전 `/org/{slug}`는 404), `c157bcd` 문서. 가지 Preview(`workon-f1s8rcw6p`) Ready 뒤 `main`. 배포 전 전체 시험 296파일 3,913개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_EY692sfSYSj5TwDU87L5PFeQwYsg`(998ad99)로 promote.
- 배포 뒤 확인: 운영 브라우저의 기관 상세 '로그인 주소'가 `/signin/org-eb36b9e4`. `/signin/org-eb36b9e4`·`/signin/org-101488a4` 200·브랜딩 응답이 그 기관, 옛 `/org/org-eb36b9e4`는 404(그래서 고침). `/login`·`/super/login`·`/api/branding` 200. 실행기 호출 23:14 KST 200, 최근 24시간 critical 0건·20분 warning 이상 0건. 실제 기관 등록은 돌려 보지 않음(운영 기관이 생기므로). 운영 두 기관의 로그인 경로는 0020 자동 값(`org-…`) 그대로.

## 2026-11-17(밤 5): 슈퍼관리자 임시 비밀번호는 바꾸기부터 — 마이그레이션 없음

- 코드 배포 `dpl_EY692sfSYSj5TwDU87L5PFeQwYsg`(커밋 `998ad99`, 2026-11-17 23:00 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `f1db76d`(밤 4 기록), `6363bb2` 기능 — '슈퍼관리자 추가'가 `generateTempPassword`·`password_must_change: true`로 만들고, 미들웨어가 `superMustChange`면 `/super/password`·비밀번호 바꾸기 API·로그인·로그아웃만 열고(화면은 그리로, API는 403 `password_change_required`), 기억보다 새 토큰이면 다시 읽음, `998ad99` 문서. 가지 Preview(`workon-52h2a4wo1`) Ready 뒤 `main`. 배포 전 전체 시험 295파일 3,904개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_H28ezMrbGx8At6ZZMs518gxnFnV4`(7bea09f)로 promote.
- 배포 전 확인(읽기 전용): 운영 슈퍼관리자 둘 다 `password_must_change` 거짓 — 배포로 막히는 사람 없음. 배포 뒤: 운영 브라우저에서 `/super/password` 화면(지금 비밀번호·새 비밀번호·확인·규칙 글) 보임, 기존 로그인은 `/super`에 그대로·대시보드 API 200(다른 곳으로 보내지 않음). `/login`·`/super/login`·`/api/branding`·`/api/system/maintenance` 200, `/super/password` 무인증 307(로그인으로). 실행기 호출 23:00 KST 200, 최근 24시간 critical 0건·20분 warning 이상 0건. 실제 슈퍼관리자 추가는 돌려 보지 않음(운영 계정이 생기므로).

## 2026-11-17(밤 4): 슈퍼관리자 본인 비밀번호 바꾸기 — 마이그레이션 없음

- 코드 배포 `dpl_H28ezMrbGx8At6ZZMs518gxnFnV4`(커밋 `7bea09f`, 2026-11-17 22:33 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `9ae2667`(밤 3 기록), `0a5daab` 기능 — `/api/super/accounts/me/password`가 직원과 같은 `changeOwnPassword`(`scope: 'super'` — 규칙·틀리면 슈퍼관리자 로그인 실패로 셈·Auth와 `password_hash` 둘 다·바꾼 때 0092), 미들웨어가 그보다 앞서 받은 슈퍼관리자 토큰(`iat`)을 끝냄(`readSuperAdminState`·`superTokenIat`), 이 브라우저 쿠키 지우고 로그인으로, 조작 기록 `super_admin_password_changed`, `7bea09f` 문서. 가지 Preview(`workon-l2zz85q8i`) Ready 뒤 `main`. 배포 전 전체 시험 294파일 3,897개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_G7i219ExoNDhz8P5PCxvVh3QxNFu`(e7d808d)로 promote.
- 배포 뒤 확인: 운영 브라우저의 기존 슈퍼관리자 로그인이 끊기지 않음(대시보드·조작 기록 API 200 — 바꾼 때가 토큰보다 앞섬). `/login`·`/super/login`·`/api/branding`·`/api/system/maintenance` 200, 비밀번호 바꾸기 무인증 401. 실행기 호출 22:34 KST 200, 최근 24시간 critical 0건·20분 warning 이상 0건. 실제 비밀번호 바꾸기는 돌려 보지 않음(운영 계정 비밀번호를 바꾸게 되므로).

## 2026-11-17(밤 3): 비밀값 암호화 v2(GCM) — 마이그레이션 없음

- 코드 배포 `dpl_G7i219ExoNDhz8P5PCxvVh3QxNFu`(커밋 `e7d808d`, 2026-11-17 22:18 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `b684db9`(밤 2 기록), `0c0b133` 기능 — `src/lib/crypto.ts` 새 암호문 `v2:`(AES-256-GCM), 옛 CBC 꼴은 `ENCRYPTION_KEY` → 옛 비밀값 순으로 그대로 읽음, 운영에서 키가 없으면 고정 값으로 저장하지 않고 저장 세 곳 503, `@ts-nocheck` 뺌, `e7d808d` 문서(운영 `ENCRYPTION_KEY`가 비었다던 기록 정정). 가지 Preview(`workon-lcskbi2y0`) Ready 뒤 `main`. 배포 전 전체 시험 293파일 3,885개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_2n69VVcVvepfqhXPcqkq3GZo8H21`(af8bc96)로 promote — 단 이 배포 뒤에 저장한 키(v2)는 옛 코드가 못 푼다(그때는 다시 저장).
- 배포 전 확인(읽기 전용): 운영 암호문은 시스템 Anthropic 키 1건(옛 CBC 꼴)·보낼 곳 비밀값 0건. 그 1건은 고정 키·로컬 키로 안 풀리고 운영 런타임은 푼다 → 운영 `ENCRYPTION_KEY`는 Sensitive 변수로 실제 값이 있다(`vercel env pull --environment=production`이 빈 값을 줌).
- 배포 뒤 확인: 새 코드가 그 옛 꼴 키를 푼다(슈퍼관리자 API 키 화면 가린 값이 `sk-`로 시작 — 운영 브라우저). `/login`·`/super/login`·`/api/branding`·`/api/system/maintenance` 200. 실행기 호출 22:20 KST 200, 최근 24시간 critical 0건·20분 warning 이상 0건.

## 2026-11-17(밤 2): 계약·API 키·공지·초대 링크 조작 기록 — 마이그레이션 없음

- 코드 배포 `dpl_2n69VVcVvepfqhXPcqkq3GZo8H21`(커밋 `af8bc96`, 2026-11-17 21:49 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `022eb26`(밤 배포 기록), `2f5b0e4` 기능 — 계약 등록·변경·해지(달라진 칸만), 시스템·기관 API 키 교체(키 값 없음), 공지 작성·수정·삭제(본문 없음), 관리자 초대 링크 만들기(초대 열쇠 없음), 기관 종료(`org_terminated`)를 `super_admin_logs`에, 초대 링크 역할 ADMIN·USER만·최상위 부서·부서 없으면 400·주소 config 경유, 기관 상태 넷만, '기관 삭제' 단추 응답 확인, `af8bc96` 문서. 가지 Preview(`workon-fqkawkph7`) Ready 뒤 `main`. 배포 전 전체 시험 292파일 3,873개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_ArbBFS648gWr3oZDNwFjrsCG8o1j`(ae708b6)로 promote.
- 배포 뒤 확인(읽기 전용): 운영 슈퍼관리자 창에서 조작 기록 API·계약 목록·기관 초대 링크 목록 200(초대 주소 호스트 `workon-ai.vercel.app`). `/login`·`/super/login`·`/api/branding`·`/api/system/maintenance` 200, 슈퍼관리자 API 무인증 401. 실행기 호출 21:50 KST 200, 최근 24시간 critical 0건.
- 관찰: 배포 전 21:36 KST 운영 기록에 `시스템 API 키 변경: anthropic`(warning) — 슈퍼관리자 화면에서 시스템 키를 바꾼 것으로 보인다. 옛 코드라 조작 기록에는 없다. 이 화면에 저장한 키는 모델 호출에 쓰이지 않는다(호출은 서버 환경 변수 `ANTHROPIC_API_KEY`), (운영 `ENCRYPTION_KEY`가 비어 있다고 적었던 것은 틀렸다 — 아래 '오후 7' 항목의 정정.)

## 2026-11-17(밤): 슈퍼관리자 조작 기록 보이기 — 마이그레이션 없음

- 코드 배포 `dpl_ArbBFS648gWr3oZDNwFjrsCG8o1j`(커밋 `ae708b6`, 2026-11-17 21:33 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `5df4a0b`(오후 7 기록), `c38cd1d` 기능 — `GET /api/super/logs/admin`(`super_admin_logs`를 처음으로 읽음 — 종류 거르기·쪽 나누기·대상 기관·계정 이름·짧은 요약, 못 읽으면 503)·로그 관리 '관리자 조작' 탭·설정 보안 탭 최근 10건(예전엔 없는 `/api/super/logs`를 불러 늘 비어 있었다)·계정 사용 중지·권한 변경·슈퍼관리자 추가·사용 중지 기록·세 로그 API는 못 읽으면 503, `ae708b6` 문서. 가지 Preview(`workon-34opn69sz`) Ready 뒤 `main`. 배포 전 전체 시험 291파일 3,857개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_HNEfiab9vYKWmVt8ULBhTL1giz6B`(2f23775)로 promote.
- 배포 전·뒤 확인(읽기 전용): 운영 `super_admin_logs` 칸·외래 키 이름(`super_admin_logs_admin_user_id_fkey`)이 새 조회와 같음, 기록 11건(업무 화면 전환 10·기관 등록 1). 운영 브라우저(슈퍼관리자 로그인)에서 '관리자 조작' 탭 11건 — '업무 화면 전환 · 기관 · 기본 기관 · 업무 홈 끔 · 새 작업 켬', '기관 등록 · 해외농업자원개발협회 · 요금제 enterprise' — 과 설정 보안 탭 최근 10건을 봄. `/login`·`/super/login`·`/api/branding`·`/api/system/maintenance` 200, 새 API 무인증 401. 실행기 하트비트 21:35 KST·pg_cron 호출 200, 최근 24시간 critical 0건·20분 warning 이상 0건.
- 좁은 창에서는 표 칸이 좁아 대상 글이 글자마다 줄바뀜(다른 로그 탭과 같은 꼴 — 가로 넘김 없음).

## 2026-11-17(오후 7): 운영 SUPER_JWT_SECRET 넣기 — 코드·마이그레이션 없음

- **발견**: 운영 슈퍼관리자 로그인이 "서버 오류가 발생했습니다"(500). Vercel 함수 로그 `[super/auth/login] Error: SUPER_JWT_SECRET이 설정되지 않았습니다.` — `vercel env ls`에는 이름이 있었지만(206일 전) `vercel env pull`로 길이만 재 보니 0. 2026-11-13 `super-secret.ts`가 운영의 빈 값을 거절하게 바꾼 뒤(`dpl_3xSQhSMwhu3xd55PV9peH1QBLkXJ`)부터 슈퍼관리자 로그인이 막혀 있었다. 그 전에는 소스의 고정 값으로 서명했다(토큰을 누구나 만들 수 있는 상태였음). 기관 관리자 로그인(NextAuth — `NEXTAUTH_SECRET` 44자)은 그대로였다.
- **조치**(사용자 "넣고 다시 배포"): Production `SUPER_JWT_SECRET`을 지우고 64자 무작위 16진수(화면·기록에 찍지 않음)로 다시 넣음, 길이 64 확인. `2f23775`(오후 6 배포 기록)를 가지 Preview(`workon-9tqigpwy2`) Ready 뒤 `main`으로 올려 `dpl_HNEfiab9vYKWmVt8ULBhTL1giz6B`(2026-11-17 17:05 KST)로 다시 배포. 살아 있던 슈퍼관리자 토큰이 없어 끊긴 사람은 없다.
- 되돌릴 때 이 값을 비우면 다시 로그인이 막힌다(코드가 빈 값을 거절) — 되돌리지 않는다.
- **같이 비어 있는 값**: `SUPER_ADMIN_SETUP_KEY`(비면 최초 설정이 막힘 — 안전), `ENCRYPTION_KEY`(비면 `crypto.ts`가 소스의 고정 키로 API 키·보낼 곳 서명 비밀값을 암호화 — 넣으려면 기존 암호문을 다시 암호화해야 한다, 다음 묶음). Preview 환경의 `SUPER_JWT_SECRET`은 넣지 않았다. — **정정(2026-11-17 밤)**: 두 값은 Sensitive 변수라 `vercel env pull`이 빈 값으로 내려준 것이다. 운영 런타임이 저장한 API 키를 풀고(슈퍼관리자 API 키 화면의 가린 값이 `sk-`로 시작) 그 암호문은 고정 키로 안 풀리므로 운영 `ENCRYPTION_KEY`에는 진짜 키가 있다. 다시 암호화할 일은 없다.

## 2026-11-17(오후 6): 대시보드 사용자 수 상한 띠 — 마이그레이션 없음

- 코드 배포 `dpl_GxDGprJJbhLgkyAwVLFHSbg3qdpK`(커밋 `2a61316`, 2026-11-17 16:41 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `3045cd6`(오후 5 배포 기록), `c60bf59` 기능 — 슈퍼관리자 대시보드 `alerts.seats`(`seatAlerts` — 활성 기관 상한 + 활성·탈퇴 안 한 계정의 기관을 `pagedRows`로, 닿은 기관 먼저·90% 이상 가까움, 못 읽으면 null)와 띠(기관 상세로 잇기), `2a61316` 문서. 가지 Preview(`workon-b2bxc72c5`) Ready 뒤 `main`. 배포 전 전체 시험 290파일 3,841개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_5EDGrJuuzjnB5YMcZJKyDeHQgdK8`(2133e2b)로 promote.
- 배포 전·뒤 확인(읽기 전용): 새 계정 쿼리(`departments!inner(organization_id)`)를 운영에 그대로 돌려 기관별 4·1명(상한 20·200 — 띠가 뜨지 않는 것이 맞음). `/login`·`/super/login`·`/api/branding`·`/api/system/maintenance` 200, 대시보드 API 무인증 401. 실행기 하트비트 16:45 KST·pg_cron 호출 200. 최근 24시간 critical 0건·최근 20분 warning 이상 0건. 같은 날 앞 배포의 기관 관리자 '사용자 관리' 머리 줄('기관 사용자 4 / 20명 · 16명 더 만들 수 있음')을 운영 브라우저에서 확인.

## 2026-11-17(오후 5): 슈퍼관리자 응답의 DB 원문 — 마이그레이션 없음

- 코드 배포 `dpl_5EDGrJuuzjnB5YMcZJKyDeHQgdK8`(커밋 `2133e2b`, 2026-11-17 16:21 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `31b2c05`(오후 4 배포 기록), `c0ba81b` 기능 — 슈퍼관리자 라우트 26곳의 `error: err.message`를 `dbErrorText`(`src/lib/db-error-text.ts` — Postgres 코드 23505·23503·23514·23502·22P02로 가른 한국어, 그 밖은 기본 문구)로, DB 오류를 `new Error(x.message)`로 감싸던 던지기를 그대로 던지기로(코드가 남게), 최초 설정·대리 접근 기관 조회 실패도 안내로, `tests/batch-0133.test.ts`가 `src/app/api` 전체를 훑음. `2133e2b` 문서. 가지 Preview(`workon-3k84drub0`) Ready 뒤 `main`. 배포 전 전체 시험 289파일 3,837개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_EvfGkrqnpGtHQDAxY4Bp6U6hLyGg`(f308c5a)로 promote.
- 배포 뒤 확인(로그인 없이 + 읽기 전용): `/login`·`/forgot-password`·`/super/login`·`/api/branding`·`/api/system/maintenance` 200, `/api/super/dashboard`·`/organizations`·`/contracts` 무인증 401, `/api/super/auth/setup` 키 없이 403(한국어 안내). 실행기 하트비트 16:25 KST·pg_cron 호출 200. 최근 24시간 critical 0건·최근 20분 warning 이상 0건.
- **확인하지 못한 것**: 실제 DB 오류 때의 슈퍼관리자 화면 문구(로그인·오류가 필요).

## 2026-11-17(오후 4): 응답에 오류 원문을 싣지 않음 — 마이그레이션 없음

- 코드 배포 `dpl_EvfGkrqnpGtHQDAxY4Bp6U6hLyGg`(커밋 `f308c5a`, 2026-11-17 15:33 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `f4d7411`(오후 3 배포 기록), `d866563` 기능 — 대화·문서 라우트의 `details: error`, 가입의 Auth 영문 원문(`authErrorMessage`), 일괄 등록 줄 원문(`RowError`만 보임), 대화·문서 붙이기·공지 읽음의 원문을 한국어 안내로, 가입 리디렉트 주소는 `config.ts` `APP_URL`, `tests/batch-0133.test.ts`가 슈퍼관리자 밖 라우트 전체를 훑음. `f308c5a` 문서. 가지 Preview(`workon-247vtpoak`) Ready 뒤 `main`. 배포 전 전체 시험 289파일 3,835개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_GpFMCBkM1e6Ug3M7e5nM74pncVjp`(a42e8fe)로 promote.
- 배포 뒤 확인(로그인 없이 + 읽기 전용): `/login`·`/forgot-password`·`/signup`·`/super/login`·`/api/branding`·`/api/system/maintenance` 200, `/api/conversations`·`/api/documents` 무인증 401, `/api/signup` 빈 몸 400(한국어 안내). 실행기 하트비트 15:35 KST·pg_cron 호출 200. 최근 24시간 critical 0건·최근 20분 warning 이상 0건.
- **확인하지 못한 것**: 실제 DB·Auth 오류 때의 화면 문구(오류가 나야 보임). 슈퍼관리자 라우트 26곳은 그대로.

## 2026-11-17(오후 3): 인원 상한을 화면에 — 마이그레이션 없음

- 코드 배포 `dpl_GpFMCBkM1e6Ug3M7e5nM74pncVjp`(커밋 `a42e8fe`, 2026-11-17 15:18 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `c0bed11`(오후 2 배포 기록), `b3859b0` 기능 — 사용자 목록 API에 `seats`(`seatUsage` — 기관 전체 활성 계정·상한, 못 읽으면 null)·'사용자 관리' 머리에 N / M명·남은 자리, 슈퍼관리자 기관 상세 `user_count`(활성 계정)·`agent_count`(지우지 않은 비서 — 예전 막대는 부서 수)·`tokens_this_month`(`organization_chat_tokens`), 못 읽으면 '—'. `a42e8fe` 문서. 가지 Preview(`workon-i7qvtixkt`) Ready 뒤 `main`. 배포 전 전체 시험 288파일 3,830개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_kzNfFha36aZruJP67ZubjPmZGPbe`(b9e7670)로 promote.
- 배포 전·뒤 확인(읽기 전용): 새 PostgREST 읽기(비서 수 head count·토큰 RPC)를 운영에 그대로 돌려 SQL 수와 같음(비서 23·19). `/login`·`/forgot-password`·`/super/login`·`/api/branding`·`/api/system/maintenance` 200, `/api/users` 무인증 403·슈퍼관리자 기관 상세 401. 실행기 하트비트 15:20 KST·pg_cron 호출 200. 최근 24시간 critical 0건·최근 20분 warning 이상 0건.
- **확인하지 못한 것**: 로그인한 두 화면('사용자 관리' 머리·슈퍼관리자 기관 상세 한도 막대).

## 2026-11-17(오후 2): 기관의 사용자 수 상한 — 마이그레이션 없음

- 코드 배포 `dpl_kzNfFha36aZruJP67ZubjPmZGPbe`(커밋 `b9e7670`, 2026-11-17 13:56 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `e6f4d6d`(오후 배포 기록), `8b04f6f` 기능 — `src/lib/user-seats.ts` `checkUserSeats`가 그 기관 부서의 활성·탈퇴 안 한 계정을 세어 `organizations.max_users`를 넘으면 403 `SEAT_LIMIT`·못 세면 503 `SEAT_UNKNOWN`. 관리자 등록(역할 USER·ADMIN만·오류 원문 `details` 뺌)·CSV 일괄 등록(남은 자리만큼·500명 상한)·초대 가입 두 곳(초대 차지 전에, 도메인 가입은 users 행 전에)·기관 관리자의 다시 사용(꺼진 계정을 켤 때). `b9e7670` 문서. 가지 Preview(`workon-n6km8vhvv`) Ready 뒤 `main`. 배포 전 전체 시험 287파일 3,826개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_8hqF9MAuMMi2t2XRG1pujY4XEyyr`(30eb188)로 promote.
- 배포 전·뒤 확인(읽기 전용): 새 PostgREST 읽기 둘(부서 → 기관 상한 내장, `departments!inner` 계정 수 head count)을 운영에 그대로 돌려 SQL로 센 값과 같음 — 기관 두 곳 4/20·1/200(지금 막히는 기관 없음). `/login`·`/forgot-password`·`/super/login`·`/signup`·`/api/branding`·`/api/system/maintenance` 200, `POST /api/users`·`/api/admin/bulk-register` 무인증 403, `/api/register` 빈 몸 400. 실행기 하트비트 14:00 KST·pg_cron 호출 200. 최근 24시간 critical 0건·최근 20분 warning 이상 0건.
- **확인하지 못한 것**: 실제 상한에 닿았을 때의 등록 화면(상한에 닿은 기관이 없고, 운영 DB에 계정을 만들지 않는다). 비서 수 상한(`max_agents`)은 아직 지키지 않는다(한 기관 23/10).

## 2026-11-17(오후): 시스템 설정을 사실대로 — 마이그레이션 없음

- 코드 배포 `dpl_8hqF9MAuMMi2t2XRG1pujY4XEyyr`(커밋 `30eb188`, 2026-11-17 13:07 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `e9a669d`(낮 배포 기록), `0dc4b03` 기능 — 슈퍼관리자 '시스템 설정' 저장을 `system-settings-spec.ts`의 다섯 열쇠만(실행기 자리 덮어쓰기 막음)·값 꼴 검사·바꿀 때마다 `super_admin_logs` `system_setting_changed`(전·후 값), 읽기 실패 503, 쓰이지 않던 '로그인 실패 허용 횟수'·'허용 IP 목록'·'세션 유지 시간'·'최대 파일 크기'·'신규 기관 기본 플랜'을 빼고 실제 로그인 보호 규칙을 읽기 전용으로, 바깥 IP 조회(api.ipify.org) 뺌, `30eb188` 문서. 가지 Preview(`workon-hk80abnrn`) Ready 뒤 `main`. 배포 전 전체 시험 286파일 3,815개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_26PQ9QqBjGrE4jqo353Mw2P6qoZv`(d31ac4b)로 promote.
- 배포 뒤 확인(로그인 없이 + 읽기 전용): `/login`·`/forgot-password`·`/super/login`·`/api/branding`·`/api/system/maintenance` 200, `/api/super/settings` GET·PATCH 무인증 401. 실행기 하트비트 13:10 KST·pg_cron 호출 200. 최근 24시간 critical 0건·최근 20분 warning 이상 0건.
- **확인하지 못한 것**: 로그인한 슈퍼관리자 화면(설정 탭 셋·저장·감사 기록) — 슈퍼관리자 로그인이 필요하다. DB의 옛 설정 행 다섯은 그대로 남아 있다(읽는 곳 없음).

## 2026-11-17(낮): IP 잠금을 운영자가 알게 — 마이그레이션 없음

- 코드 배포 `dpl_26PQ9QqBjGrE4jqo353Mw2P6qoZv`(커밋 `d31ac4b`, 2026-11-17 11:21 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `2eb1650`(오전 배포 기록), 기능 커밋 — 실패를 남긴 뒤 그 IP의 30분 창 실패가 꼭 30번이면 `system_logs` warning·security `IP_LOCK_STARTED`(가린 IP·범위만), 슈퍼관리자 대시보드 '지금 로그인이 막힌 인터넷 주소(IP) N곳' 띠(30분 창 실패의 IP 해시를 `pagedRows`로 끝까지 읽어 30번 넘은 것 — `lockedIpCount`, 최근 잠긴 가린 IP 다섯, 계정 관리로 잇기), `d31ac4b` 문서. 가지 Preview(`workon-nz4unlhjq`) Ready 뒤 `main`. 배포 전 전체 시험 285파일 3,806개 통과·tsc 0(첫 전체 시험에서 `.limit(10000)`을 `paged-select` 시험이 잡아 `pagedRows`로 고침).
- 되돌릴 때는 직전 `dpl_EtSZZgfcf6GPewyg9NcXaUxcKove`(41cd36d)로 promote.
- 배포 뒤 확인(로그인 없이 + 읽기 전용): `/login`·`/forgot-password`·`/super/login`·`/api/branding`·`/api/system/maintenance` 200, 대시보드 API 무인증 401. 운영 DB 최근 30분 IP 실패 0줄·잠긴 IP 0(띠가 뜨지 않는 것이 맞음). 실행기 하트비트 11:25 KST·pg_cron 호출 200. 최근 24시간 critical 0건·최근 20분 warning 이상 0건.
- **확인하지 못한 것**: 실제 IP 잠금 때의 기록·대시보드 띠(로그인한 화면, 잠금이 걸려야 보임).

## 2026-11-17(오전): IP 잠금 안내 — 마이그레이션 없음

- 코드 배포 `dpl_EtSZZgfcf6GPewyg9NcXaUxcKove`(커밋 `41cd36d`, 2026-11-17 10:10 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `38b2e67`(아침 5 배포 기록), 기능 커밋 — `signInLock`(무엇이 잠겼나 `'ip'`·`'account'`, 둘 다면 `'ip'`)·직원 로그인은 IP 잠금이면 `IP_LOCKED`(로그인 화면이 '이 인터넷 주소에서 … 서비스 운영자에게 잠금 풀기를 요청' 안내)·슈퍼관리자 로그인도 같은 갈래·접속 기록 `details.lock`, `41cd36d` 문서. 가지 Preview(`workon-2gwmwwu52`) Ready 뒤 `main`. 배포 전 전체 시험 284파일 3,800개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_GWdyh7rShbk74VtYfQcfhVmBBef4`(cd377ec)로 promote.
- 배포 뒤 확인(로그인 없이 + 읽기 전용): `/login`·`/forgot-password`·`/super/login`·`/api/branding`·`/api/system/maintenance` 200, 운영 로그인 화면 JS 묶음에 `IP_LOCKED` 갈래가 들어 있음. 실행기 하트비트 10:15 KST(배포 뒤 첫 차례)·pg_cron 호출 200. 최근 24시간 critical 0건·최근 20분 warning 이상 0건.
- **확인하지 못한 것**: 실제 IP 잠금 때 화면에 안내가 뜨는 것(30번 틀려야 걸린다 — 운영에서 일부러 걸지 않음).

## 2026-11-17(아침 5): 슈퍼관리자 IP 로그인 잠금 확인·풀기 — 마이그레이션 없음

- 코드 배포 `dpl_GWdyh7rShbk74VtYfQcfhVmBBef4`(커밋 `cd377ec`, 2026-11-17 09:45 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `7b74b83`(아침 4 배포 기록), 기능 커밋 — `GET`·`DELETE /api/super/sign-in-ip-lock`(슈퍼관리자만, IP를 넣어 30분 안 실패 수·풀리는 때를 보고 그 IP 해시의 실패 기록을 지움, `super_admin_logs` `sign_in_ip_unlocked`에 가린 IP·지운 수만), 계정 관리 화면 위 'IP 로그인 잠금' 칸, `normalizeIp`·`maskIp`(잎 파일), `cd377ec` 문서. 가지 Preview(`workon-ag8y9nvq1`) Ready 뒤 `main`. 배포 전 전체 시험 283파일 3,796개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_43gfqdms1idttRnmDfb9ndj1GYJe`(01ef727)로 promote.
- 배포 뒤 확인(로그인 없이 + 읽기 전용): `/login`·`/forgot-password`·`/super/login`·`/api/branding`·`/api/system/maintenance` 200, IP 잠금 GET·DELETE 무인증 401, `/super/accounts` 무인증 307. 실행기 하트비트 09:50 KST(배포 뒤 첫 차례)·pg_cron 호출 200. 최근 24시간 critical 0건·최근 20분 warning 이상 0건.
- **확인하지 못한 것**(사용자 몫): 슈퍼관리자 계정 관리 화면의 'IP 로그인 잠금' 칸(로그인한 화면) — 아무 IP나 넣고 '확인'(읽기만).

## 2026-11-17(아침 4): 대리 접근 기록 없이는 들어가지 않음 — 마이그레이션 없음

- 코드 배포 `dpl_43gfqdms1idttRnmDfb9ndj1GYJe`(커밋 `01ef727`, 2026-11-17 09:21 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `12d1fa6`(아침 3 배포 기록), 기능 커밋 — 대리 접근은 `impersonation_logs`를 못 남기면 503(쿠키·세션 토큰 전에 끝냄, security·error 기록), 기관 만들기에서 기본 부서를 못 만들면 소속 없는 초대를 만들지 않고 경고(`org_default_department`, payment·critical), 일괄 실행 묶음 멈춤·마침 쓰기 오류를 던짐(멈춤을 못 쓰면 줄을 건너뛰지 않음), 결과를 받되 `error`를 받지 않는 쓰기(`const { data } = await …`)도 찾개가 잡음(`tests/batch-0126.test.ts`), `01ef727` 문서. 가지 Preview(`workon-gusp1akyy`) Ready 뒤 `main`. 배포 전 전체 시험 282파일 3,787개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_7vPwJSM4mH2qRXgqb6BQTrdcWbuu`(1499495)로 promote.
- 배포 뒤 확인(로그인 없이 + 읽기 전용): `/login`·`/forgot-password`·`/super/login`·`/api/branding`·`/api/system/maintenance` 200, 대리 접근·기관 만들기 무인증 401. 실행기 하트비트 09:25 KST(배포 뒤 첫 차례)·pg_cron 호출 200. 최근 24시간 critical 0건·최근 20분 warning 이상 0건.
- **확인하지 못한 것**(사용자 몫): 슈퍼관리자 화면에서 대리 접근이 평소처럼 들어가는지(기록이 남는 정상 경로) — 로그인한 화면.

## 2026-11-17(아침 3): 결과를 버리는 DB 쓰기 막기 — 마이그레이션 없음

- 코드 배포 `dpl_7vPwJSM4mH2qRXgqb6BQTrdcWbuu`(커밋 `1499495`, 2026-11-17 08:58 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `b2c04f9`(아침 2 배포 기록), `df1de00` — `tests/batch-0125.test.ts`가 `src` 전체에서 `await supabaseAdmin.from(…).insert|update|upsert|delete(…)` 문장(결과를 버림)을 찾아(`tests/helpers/discarded-writes.ts`) 이유를 적은 8곳 밖이면 실패, 끝낸 일괄 실행의 기다리던 줄 건너뛰기(`skipPendingItems` — 그만두기·실행기 멈춤·관리자 멈춤, 한 번 더·실패면 warning), 공지 읽음 저장 실패 500, 시스템 API 키 저장은 옛 키를 못 끄면 넣지 않음·오류 원문 대신 안내, 배포한 시험 판 비우기 실패 warning, `1499495` 문서. 가지 Preview(`workon-4csokexa9`) Ready 뒤 `main`. 배포 전 전체 시험 281파일 3,782개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_3rgAiWRjn4tBnoBkRfFFnfnD4BwD`(da13300)로 promote.
- 배포 뒤 확인(로그인 없이 + 읽기 전용): `/login`·`/forgot-password`·`/super/login`·`/api/branding`·`/api/system/maintenance` 200, 공지 읽음·시스템 키·일괄 실행 무인증 401. 실행기 하트비트 09:00 KST(배포 뒤 첫 차례)·pg_cron 호출 200(08:58~09:00 KST). 최근 24시간 critical 0건·최근 20분 warning 이상 0건.
- **확인하지 못한 것**: 새 기록·오류 응답은 해당 쓰기가 실패해야 나온다.

## 2026-11-17(아침 2): 로그인·비밀번호 쓰기 실패를 운영 기록에 — 마이그레이션 없음

- 코드 배포 `dpl_3rgAiWRjn4tBnoBkRfFFnfnD4BwD`(커밋 `da13300`, 2026-11-17 08:42 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `bf93de8`(아침 배포 기록), `d8537b3` — 로그인 실패 기록(`sign_in_failures`) 쓰기 실패를 `system_logs` security·error로(예전엔 돌려준 오류를 보지 않아 쓰기가 막히면 **잠금이 조용히 꺼졌다**), 성공 뒤 실패 기록 지우기 실패 warning, 마지막 로그인 시각을 못 적음 auth·error(장기 미접속 잠금이 잘못 걸릴 수 있음), 비밀번호 재설정 뒤 남은 링크를 못 끝냄·실패 뒤 열쇠를 못 돌려놓음·초대 차지를 못 풂 auth·warning(사람 id만), 슈퍼관리자 기관 API 키 저장은 세 쓰기 중 하나라도 실패하면 500, `logSystem`이 `system_logs`마저 못 쓰면 함수 로그(문구·코드만), `da13300` 문서. 가지 Preview(`workon-gstx96urt`) Ready 뒤 `main`. 배포 전 전체 시험 280파일 3,775개 통과·tsc 0(첫 전체 시험은 도중 시험 DB가 꺼져 업무 흐름 시험 32개가 연결 거부로 실패 — 다시 띄워 다시 돌림).
- 되돌릴 때는 직전 `dpl_2BwTFMpkQMfZBuhyi6UqxNF7Nwfs`(2d80737)로 promote.
- 배포 뒤 확인(로그인 없이 + 읽기 전용): `/login`·`/forgot-password`·`/super/login`·`/api/branding`·`/api/system/maintenance` 200, 슈퍼관리자 기관 API 키 PATCH 무인증 401, `/api/users` 403, 잘못된 재설정 링크 400. 실행기 하트비트 08:45 KST(배포 뒤 첫 차례)·pg_cron 호출 200(08:41~08:44 KST). 최근 24시간 critical 0건·최근 20분 warning 이상 0건.
- **확인하지 못한 것**: 새 운영 기록은 해당 쓰기가 실패해야 남는다(지금 운영에는 실패 없음).

## 2026-11-17(아침): 조용히 사라지던 쓰기 실패를 운영 기록에·슈퍼관리자 critical 알림 — 마이그레이션 없음

- 코드 배포 `dpl_2BwTFMpkQMfZBuhyi6UqxNF7Nwfs`(커밋 `2d80737`, 2026-11-17 08:02 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `7c118f4`(새벽 2 배포 기록), `d2304ff` — 사용 기록 쓰기 실패를 `system_logs` critical·payment로(`writeUsageLog`·업무 `writeUsage`, 비서·금지어 라우트가 직접 쓰던 곳도), 슈퍼관리자 조작·모델 정책 변경·로그인 기록 쓰기는 `writeAuditRow`(돌려준 오류를 실패로), 계약·기관 맞추기(옛 계약을 끝내지 못하면 새 계약 안 만듦·맞추기 실패는 화면 경고와 critical·다시 활성화는 계약 하나만·초대 저장 실패 안내), 앱 결과 보내기의 결과 기록 실패는 한 번 더·그래도 안 되면 critical, 대리 접근 끝낸 때 기록 오류, 슈퍼관리자 대시보드 최근 24시간 critical 띠·운영 기록 화면 주소 거르기(payment 카테고리), 5분 실행기의 critical 메일 알림(`src/lib/critical-alert.ts` — 한 시간에 한 번까지, `system_settings` `critical_log_alert` 조건부 차지), `2d80737` 문서. 가지 Preview(`workon-2tl7ofjqs`) Ready 뒤 `main`. 배포 전 전체 시험 279파일 3,763개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_GdB3cPcMcp3CrPmkEvKRU3uo4CuP`(688b022)로 promote.
- 배포 뒤 확인(로그인 없이 + 읽기 전용): `/login`·`/forgot-password`·`/super/login`·`/api/branding`·`/api/system/maintenance` 200, `/api/super/dashboard`·`/api/cron/app-schedules`·`/api/chat` 무인증 401. 실행기 하트비트 08:10 KST(배포 뒤 첫 차례)·pg_cron 호출 200(08:10~08:13 KST). 최근 24시간 critical 기록 0건이라 알림 행(`critical_log_alert`)은 아직 없음(보낼 것이 없어 차지하지 않음 — 기대대로), 최근 20분 warning 이상 0건.
- **확인하지 못한 것**(사용자 몫): 슈퍼관리자 대시보드 띠·운영 기록 화면 주소 거르기·계약/기관 화면 경고(로그인한 화면), critical 알림 메일의 실제 도착(critical 기록이 생겨야 감).

## 2026-11-17(새벽 2): 보안 로그 한 곳·실패를 운영 기록에·설정 화면 보안 로그 조회 고침 — 마이그레이션 없음

- 코드 배포 `dpl_GdB3cPcMcp3CrPmkEvKRU3uo4CuP`(커밋 `688b022`, 2026-11-17 00:27 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `3e54a07`(새벽 배포 기록), `08168fe` 보안 로그를 `logSecurityEvent`(`src/lib/security-log.ts`) 한 곳으로(직접 insert 11곳 — 돌려준 `{ error }`를 보지 않아 `security_logs`가 없던 동안 모두 조용히 버려졌다), 실패하면 `system_logs`(security, error)에 종류·코드, IP 차단 기록은 실제로 남겼을 때만 `logged:true`, 관리자 설정 화면 '보안 로그' 조회가 없는 `users.name`을 고르던 것을 `full_name`으로, 코드 쪽 스키마 검사가 내장 관계 칸·여러 줄 백틱 select도 봄, `688b022` 문서. 가지 Preview(`workon-p27ja38y0`) Ready 뒤 `main`. 배포 전 전체 시험 273파일 3,724개 통과·tsc 0(처음 돌린 전체 시험에서 원문 문자열을 보던 옛 시험 4개가 걸려 고친 뒤 다시 돌림).
- 되돌릴 때는 직전 `dpl_Hm5NiTn73wmwCUCJ7UDB9g1MZJH9`(48d3a0e)로 promote.
- 배포 뒤 확인(로그인 없이 + 읽기 전용): `/`·`/login`·`/forgot-password`·`/api/system/maintenance`·`/api/branding` 200, `/admin` 307, `/api/users` 403, `/api/security-logs` 401. 운영 DB에서 새 조회(`users:user_id (full_name, email)`)는 됨, 옛 조회(`name`)는 42703 — 이 화면은 늘 실패했었다. 0097 뒤 보안 로그 0행·기록 실패 0. pg_cron 호출 200(00:26~00:28 KST).
- **확인하지 못한 것**(사용자 몫): 관리자 설정 화면의 '보안 로그' 목록이 실제로 뜨는지, 보안 사건(비밀번호 바꾸기 등) 뒤 감사 화면에 쌓이는지 — 로그인한 화면.

## 2026-11-17(새벽): 코드 쪽 스키마 이름 검사 — 시험·문서만, 마이그레이션 없음

- 코드 배포 `dpl_Hm5NiTn73wmwCUCJ7UDB9g1MZJH9`(커밋 `48d3a0e`, 2026-11-17 00:08 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `43bb96b`(밤 8 배포 기록), `869097c` 시험 `tests/batch-0116.test.ts`·`tests/helpers/code-schema-refs.ts`(코드가 부르는 표·칸·함수가 시험 DB = 마이그레이션 전부에 있는지 — 앱 동작은 바뀌지 않음), `48d3a0e` 문서. 가지 Preview(`workon-7xypgwk4p`) Ready 뒤 `main`. 배포 전 전체 시험 272파일 3,715개 통과·tsc 0. 시험 DB에서 `users.password_hash`를 빼 보면 이 시험이 그 칸과 쓰는 파일을 짚고 실패하는 것을 확인(다시 넣음).
- 되돌릴 때는 직전 `dpl_8Up8xsGcuas2fgoKa5PczKJNEYtf`(bef20e7)로 promote.
- 배포 뒤 확인(로그인 없이): `/`·`/login`·`/forgot-password`·`/api/system/maintenance`·`/api/branding` 200, `/admin` 307, `/api/users` 403. pg_cron 호출 200(00:06~00:09 KST).

## 2026-11-16(밤 8): 운영 스키마 어긋남 검사(db:drift) — 마이그레이션 없음

- 코드 배포 `dpl_8Up8xsGcuas2fgoKa5PczKJNEYtf`(커밋 `bef20e7`, 2026-11-16 23:57 KST, `main` fast-forward, 사용자 "운영반영"). 들어간 커밋: `fa4f63f`(0097 파일·재발 방지 시험 — 운영 DB에는 밤 7에 이미 적용), `5484b00`(밤 7 배포 기록), `d42e7f9` `npm run db:drift`(`src/lib/schema-drift.ts`·`scripts/db-drift.mjs` — 운영자 명령, 앱 동작은 바뀌지 않음), `bef20e7` 문서. 가지 Preview(`workon-dmodhs442`) Ready 뒤 `main`. 배포 전 전체 시험 271파일 3,711개 통과·tsc 0.
- 되돌릴 때는 직전 `dpl_Fkt8PfjRqM4kQWLDhNHKmvacyjEB`(72e4551)로 promote.
- 배포 뒤 확인(로그인 없이): `/`·`/login`·`/forgot-password`·`/reset-password`·`/api/system/maintenance`·`/api/branding` 200, `/admin` 307, `/api/users` 403, 잘못된 링크의 재설정 400. **`npm run db:drift`**(시험 DB를 `work:testdb -- reset`으로 마이그레이션 97개 전부로 다시 만든 뒤): 기준·운영 모두 표·뷰 61·칸 798·함수 33, 빠진 것·형식 다름·RLS 꺼짐·운영에만 있는 것 모두 없음. pg_cron 호출 200(23:56~23:59 KST).
- **확인하지 못한 것**(사용자 몫, 밤 7과 같음): 실제 직원 주소로 비밀번호 찾기 메일·링크, 로그인한 화면의 비밀번호 바꾸기·관리자 재발급·직원 등록, 감사 화면 '보안 이벤트'.

## 2026-11-16(밤 7): 직원 비밀번호 찾기(0096) + 운영 스키마 어긋남 메우기(0097)

- **먼저 운영 DB에 0096 적용**(23:40 KST, 사용자 "운영반영"). 확인(읽기 전용): `password_reset_requests` 칸 일곱·꼴/해시 CHECK·색인 둘·RLS 켜짐·정책 0·anon 권한 없음·0행.
- 코드 배포 `dpl_Fkt8PfjRqM4kQWLDhNHKmvacyjEB`(커밋 `72e4551`, 23:42 KST, `main` fast-forward). 들어간 커밋: `1215990`(직전 배포 기록), `489e841` 비밀번호 찾기(로그인 화면 링크·`/forgot-password`·`/reset-password`·`POST /api/password-reset`·`/confirm`), `72e4551` 문서. 가지 Preview(`workon-bpxyiqilm`) Ready 뒤 `main`. 배포 전 전체 시험 269파일 3,700개 통과·tsc 0.
- **배포 뒤 확인에서 찾은 것**: 없는 주소로 비밀번호 찾기를 부르자 500. 원인은 이번 코드가 아니라 **운영 DB와 코드의 오래된 어긋남 두 곳** — ① `users.password_hash` 칸이 없었다(만드는 마이그레이션이 처음부터 없었고 시험 DB에도 없음 — 단위 시험은 가짜 DB라 못 잡음), ② 0002의 `security_logs` 표가 운영에 없었다. 그래서 운영에서는 내 비밀번호 바꾸기(사용자 읽기 실패)·관리자/슈퍼관리자 임시 비밀번호 재발급(**Auth 비밀번호만 바뀌고 해시 저장에서 오류 — 임시 비밀번호가 화면에 안 나옴**)·관리자 직원 등록·일괄 등록(이 칸에 씀)이 실패했을 것으로 보이고(코드·DB로 판단, 로그인해서 재현하지 않음), **모든 보안 로그가 조용히 버려졌고** 감사 화면 '보안 이벤트'는 읽지 못했다.
- **운영 DB에 0097 적용**(23:46 KST, 사용자 "0097 운영 적용") — `users.password_hash text` 추가(값은 모두 NULL)·`security_logs`를 0002 꼴로 만듦(RLS 켜짐·정책 0·anon 권한 없음). 코드는 바꾸지 않았다(배포 없음). 확인: 칸·표·RLS·anon users/security_logs 권한 없음·적용 기록.
- 0097 뒤 다시 확인(로그인 없이): 없는 주소·꼴이 아닌 주소의 비밀번호 찾기 요청 모두 같은 안내 200(세기용 줄 2개만 — 계정·열쇠 없음), 잘못된·무작위 링크의 재설정 400 '만료되었거나 이미 쓰였습니다', `/`·`/login`·`/forgot-password`·`/reset-password`·`/api/system/maintenance` 200, pg_cron 호출 200(23:44~23:46, 하트비트 23:45).
- 되돌릴 때는 직전 `dpl_2A4EFi272R697p988fngEwKxmx3r`(be7968f)로 promote(0096·0097은 남겨도 해가 없다 — 0097은 오히려 남겨야 한다).
- **확인하지 못한 것**(사용자 몫): 실제 직원 주소로 메일이 오고 링크로 비밀번호가 바뀌는 끝까지의 흐름, 0097 뒤 '내 비밀번호 바꾸기'·관리자 '비밀번호 재발급'·직원 등록이 실제로 되는지(로그인한 화면 — 0097 전 재발급을 눌렀던 직원이 있으면 그 직원의 비밀번호는 알 수 없는 임시 값이니 다시 재발급해야 한다), 보안 로그가 감사 화면에 쌓이는지.
- **0097 파일·시험(`tests/batch-0114.test.ts`)은 로컬 커밋만**이다 — 다음 배포 때 함께 올라간다(코드 변화 없음).

## 2026-11-16(밤 6): 장기 미접속 계정 잠금(0095, 기관이 켤 때만)·기관 정보는 기관 전체 관리자만

- **배포 전 운영 확인(읽기 전용)**: 기관 정보 수정을 기관 전체 관리자만으로 좁혀 잃는 사람이 있는지 — 두 기관 모두 최상위 부서 관리자 1명·하위 부서 관리자 0명(잃는 사람 없음).
- **먼저 운영 DB에 0095 적용**(2026-11-16 23:22 KST, 사용자 "운영반영"). 적용 뒤 확인(읽기 전용): `organizations.dormant_lock_days` smallint·`dormant_lock_since` timestamptz·`users.reactivated_at` timestamptz, CHECK(30~365·켤 때 켠 때 필수), 켠 기관 0, 두 표 RLS 켜짐, anon 읽기 권한 없음, 적용 기록 있음.
- 그다음 코드 배포 `dpl_2A4EFi272R697p988fngEwKxmx3r`(커밋 `be7968f`, 2026-11-16 23:24 KST, `main` fast-forward — GitHub 연동). 되돌릴 때는 직전 `dpl_6MHzJw12fr5g1zyYMusMxTiAGJ9Q`(c77acd2)로 promote한다(0095는 남겨도 옛 코드가 읽지 않는다 — 잠금이 다시 꺼지고, 기관 정보 수정이 하위 부서 관리자에게도 다시 열린다).
- 들어간 커밋: `23e06f4`(직전 배포 기록), `c5ebae6` 장기 미접속 잠금(기관 전체 관리자 '기관 정보' 화면에서 30~365일로 켬·켠 때부터 셈, 직원 로그인 두 길이 비밀번호 확인 뒤 기간이 지났으면 사용 중지로 돌리고 `ACCOUNT_DORMANT`, '다시 사용'은 `reactivated_at`부터 다시 셈) + 기관 정보 PATCH는 기관 전체 관리자만, `be7968f` 문서.
- **배포 전**: 가지 Preview(`be7968f`, `workon-3hxm9ytee`) Ready를 확인한 뒤 `main`에 올렸다. 시험 DB(0001~0095)를 띄운 전체 시험 268파일 3,685개 통과·tsc 0.
- 배포 뒤 확인(로그인 없이, 운영 주소): `/`·`/login`·`/api/system/maintenance`·`/api/branding` 200, `/admin/organization` 307, `GET·PATCH /api/admin/organization`·`PUT /api/admin/organization/dormant-lock` 403, 없는 계정으로 직원 로그인 401(로그인 길이 그대로 돎). pg_cron 호출 200(23:24~23:26 KST, 실행기 하트비트 23:25).
- **확인하지 못한 것**(사용자 몫): 로그인한 화면을 브라우저로 보지 않았다 — 평소 로그인이 그대로 되는지(가장 중요 — 성공 로그인마다 잠금 확인 한 번), 기관 정보 화면의 '장기 미접속 계정 잠금' 켜기·끄기. 잠금이 실제로 걸리는 것은 기간(최소 30일)이 지나야 보인다 — 자동 시험만.

## 2026-11-16(밤 5): 기관 관리자의 계정 사용 중지·다시 사용

- 2026-11-16 23:11 KST 배포 `dpl_6MHzJw12fr5g1zyYMusMxTiAGJ9Q`(커밋 `c77acd2`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영"). 마이그레이션 없음. 되돌릴 때는 직전 `dpl_Faj9374W424prRDUKK44tmWyRbKu`(c9a7f4c)로 promote한다(기관 관리자의 사용 중지·다시 사용 단추만 빠진다 — 이미 끈 계정은 꺼진 채, 슈퍼관리자가 켤 수 있다).
- 들어간 커밋: `876298b`(직전 배포 기록), `e51b873` 기관 관리자의 계정 사용 중지·다시 사용(`POST /api/users/[id]/active` — 관리 범위 직원만·본인 안 됨·대리 접근 막음·슈퍼관리자 계정 제외·끌 때 사유·보안 로그 high, 사용자 관리 목록 '사용 중지됨'·단추·거르기(사용 중지·90일 넘게 로그인 안 함·기록 없음)), `c77acd2` 문서.
- **배포 전**: 가지 Preview(`c77acd2`, `workon-hgf4oj41f`) Ready를 확인한 뒤 `main`에 올렸다. 시험 DB(0001~0094)를 띄운 전체 시험 267파일 3,673개 통과·tsc 0.
- 배포 뒤 확인(로그인 없이, 운영 주소): `/`·`/login`·`/api/system/maintenance`·`/api/branding` 200, `GET /api/users` 403, `POST /api/users/{id}/active` 403. pg_cron 호출 200(23:12·23:13 KST, 실행기 하트비트 23:10).
- **확인하지 못한 것**(사용자 몫): 관리자로 로그인해 시험 계정을 '사용 중지'하면 그 계정의 열린 로그인이 30초 안에 끝나고 다시 로그인이 막히는지, '다시 사용'으로 되돌아오는지, 목록 거르기를 브라우저로 보지 않았다.

## 2026-11-16(밤 4): 내 로그인 기록

- 2026-11-16 23:00 KST 배포 `dpl_Faj9374W424prRDUKK44tmWyRbKu`(커밋 `c9a7f4c`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영"). 마이그레이션 없음. 되돌릴 때는 직전 `dpl_GLbdYZDaKuAn5VhAuzxCfFdLo7vj`(f40aad7)로 promote한다(내 로그인 기록 화면만 빠진다).
- 들어간 커밋: `b7b4d62`(직전 배포 기록), `ff9be64` 내 로그인 기록(사용자 메뉴 '비밀번호·로그인 기록' 아래 최근 90일·30건 — `GET /api/my/sign-ins` 세션 본인만·대리 접근 403·브라우저 정보는 '윈도우 · 크롬' 같은 짧은 꼴만, 최근 30일 실패 수 경고, 임시 비밀번호로 묶인 동안은 숨김), `c9a7f4c` 문서.
- **배포 전**: 가지 Preview(`c9a7f4c`, `workon-ez8j0zxx5`) Ready를 확인한 뒤 `main`에 올렸다. 시험 DB(0001~0094)를 띄운 전체 시험 266파일 3,667개 통과·tsc 0.
- 배포 뒤 확인(로그인 없이, 운영 주소): `/`·`/login`·`/my/password`·`/api/system/maintenance`·`/api/branding` 200, `GET /api/my/sign-ins` 401. pg_cron 호출 200(23:00~23:02 KST, 실행기 하트비트 23:00).
- **확인하지 못한 것**(사용자 몫): 로그인해서 '비밀번호·로그인 기록' 화면 아래 내 최근 로그인이 기기·IP와 함께 보이는지 브라우저로 보지 않았다(기록은 0094 배포 뒤 로그인부터 남는다).

## 2026-11-16(밤 3): 직원 접속 기록(0094)

- **먼저 운영 DB에 0094 적용**(2026-11-16 22:46 KST, 사용자 "운영반영"). 적용 뒤 확인(읽기 전용): `access_logs.department_id` uuid(부서 외래 키 — 지우면 비움)·색인 `access_logs_department_created_idx`, `users.last_sign_in_at` timestamptz, 두 표 RLS 켜짐, anon 읽기 권한 없음, 적용 기록 있음.
- 그다음 코드 배포 `dpl_GLbdYZDaKuAn5VhAuzxCfFdLo7vj`(커밋 `f40aad7`, 2026-11-16 22:48 KST, `main` fast-forward — GitHub 연동). 되돌릴 때는 직전 `dpl_BiMX4HKJTBX3uLw8Af2rtRvFT8Gc`(cdec0d8)로 promote한다(0094는 남겨도 옛 코드가 읽지 않는다 — 직원 접속 기록만 다시 안 남는다).
- 들어간 커밋: `ab6f624`(직전 배포 기록), `9f00146` 직원 접속 기록(로그인 두 길의 성공·실패·잠김·거절을 `access_logs`에 사람·부서·기관·IP·브라우저로, 성공이면 `users.last_sign_in_at`, 입력한 이메일은 남기지 않음, 기관 관리자 감사 '접속 기록(로그인)'·사용자 목록 '최근 로그인'), `f40aad7` 문서.
- **배포 전**: 가지 Preview(`f40aad7`, `workon-2jhenebra`) Ready를 확인한 뒤 `main`에 올렸다. 시험 DB(0001~0094)를 띄운 전체 시험 265파일 3,661개 통과·1개 실패(`batch-0103`이 바뀐 줄 모양을 글자 그대로 찾던 것 — 시험만 고쳐 통과, 동작은 같음)·tsc 0.
- 배포 뒤 확인(로그인 없이, 운영 주소): `/`·`/login`·`/api/system/maintenance`·`/api/branding` 200, `GET /api/users`·`/api/admin/audit-logs?kind=access` 403. **없는 계정(`nobody-check@example.invalid`)으로 직원 로그인 한 번**(NextAuth credentials, 401) → 운영 `access_logs`에 `login_failed`·사람 없음·부서 없음·IP 있음·`/login` 한 줄(이메일은 남지 않음 — 그 이메일 해시의 로그인 실패 한 줄도 `sign_in_failures`에 남고 하루 뒤 정리). pg_cron 호출 200(22:49·22:50 KST, 실행기 하트비트 22:50).
- **확인하지 못한 것**(사용자 몫): 실제 계정으로 로그인한 뒤 관리자 감사 화면 '접속 기록(로그인)'에 그 로그인이 보이는지, 사용자 관리 목록에 '최근 …'이 보이는지 브라우저로 보지 않았다.

## 2026-11-16(밤 2): 임시 비밀번호는 비밀번호부터 바꾸기·슈퍼관리자 재발급(0093)

- **먼저 운영 DB에 0093 적용**(2026-11-16 22:32 KST, 사용자 "운영반영"). 적용 뒤 확인(읽기 전용): `users.password_must_change` boolean·NOT NULL·기본 false, 참인 행 0(소급 없음), `users` RLS 켜짐, anon 읽기 권한 없음, 적용 기록 있음.
- 그다음 코드 배포 `dpl_BiMX4HKJTBX3uLw8Af2rtRvFT8Gc`(커밋 `cdec0d8`, 2026-11-16 22:34 KST, `main` fast-forward — GitHub 연동). 되돌릴 때는 직전 `dpl_HbaCwRm7YpZFn21ZSpeCSXtvSvSo`(d464175)로 promote한다(0093은 남겨도 옛 코드가 읽지 않는다 — 임시 비밀번호로도 다른 화면이 다시 열린다).
- 들어간 커밋: `3904ae6`(직전 배포 기록), `30b9c5e` 임시 비밀번호 표시(관리자 등록·CSV 일괄 등록·재발급이 켜고 본인 바꾸기가 끔 — 켜진 동안 미들웨어가 비밀번호 바꾸기 화면·API·로그인 화면·점검·브랜딩만 열고 화면은 `/my/password?required=1`, API는 403, 대리 접근은 묶지 않음) + 슈퍼관리자 '비밀번호 재발급'(`POST /api/super/accounts/users/[id]/password-reset` — 직원 계정만·비활성 막음·`super_admin_logs`), `cdec0d8` 문서.
- **배포 전**: 가지 Preview(`cdec0d8`, `workon-66zxayl8j`) Ready를 확인한 뒤 `main`에 올렸다. 시험 DB(0001~0093)를 띄운 전체 시험 264파일 3,653개 통과·tsc 0.
- 배포 뒤 확인(로그인 없이, 운영 주소): `/`·`/login`·`/my/password`·`/api/system/maintenance`·`/api/branding` 200, `GET /api/users` 403, `POST /api/users/{id}/password-reset` 403, `POST /api/super/accounts/users/{id}/password-reset` 401, `POST /api/my/password` 401. pg_cron 호출 200(22:35·22:36 KST, 실행기 하트비트 22:35).
- **확인하지 못한 것**(사용자 몫): 로그인한 화면을 브라우저로 보지 않았다 — 평소 로그인이 그대로 쓰이는지, 임시 비밀번호(새로 등록하거나 재발급한 시험 계정)로 들어오면 '비밀번호 바꾸기'로 가고 다른 화면·API가 막히는지, 바꾼 뒤 새 비밀번호로 다시 들어오면 평소처럼 쓰이는지, 슈퍼관리자 '비밀번호 재발급'이 임시 비밀번호를 보이는지.

## 2026-11-16(밤): 비밀번호를 바꾸면 모든 로그인 끝내기·관리자 임시 비밀번호 재발급(0092)

- **먼저 운영 DB에 0092 적용**(2026-11-16 22:16 KST, 사용자 "운영반영"). 적용 뒤 확인(읽기 전용): `users.password_changed_at` timestamptz·비어도 됨, `users` RLS 켜짐, anon 읽기 권한 없음, 값이 있는 행 0, 적용 기록 있음.
- 그다음 코드 배포 `dpl_HbaCwRm7YpZFn21ZSpeCSXtvSvSo`(커밋 `d464175`, 2026-11-16 22:18 KST, `main` fast-forward — GitHub 연동). 되돌릴 때는 직전 `dpl_Dejdo6yJErcBCcvPZZ99vz2Q8jrS`(2fc3776)로 promote한다(0092는 남겨도 옛 코드가 읽지 않는다 — 바꾼 뒤 다른 기기 끊기·재발급만 빠진다).
- 들어간 커밋: `0704ba9`(직전 배포 기록), `867ecd5` 비밀번호 바꾼 때(본인 바꾸기·관리자 재발급이 적고 미들웨어가 그보다 앞 초에 로그인한 토큰을 끝냄 — 로그인한 때는 토큰 `authAt`, 옛 토큰은 `iat`) + 관리자 '비밀번호 재발급'(`POST /api/users/[id]/password-reset` — 관리 범위·본인/대리 접근/비활성 막음, Auth·해시 둘 다, 잠금 풀기, 안내 메일, 응답에 한 번만, 보안 로그 high), `d464175` 문서.
- **배포 전**: 가지 Preview(`d464175`, `workon-5sx0ep394`) Ready를 확인한 뒤 `main`에 올렸다. 시험 DB(0001~0092)를 띄운 전체 시험 263파일 3,643개 통과·tsc 0.
- 배포 뒤 확인(로그인 없이, 운영 주소): `/`·`/login`·`/my/password`·`/api/system/maintenance`·`/api/branding`·`/login?error=password_changed` 200, `GET /api/users` 403, `POST /api/users/{id}/password-reset` 403, `POST /api/my/password` 401. pg_cron 호출 200(22:19~22:21 KST, 실행기 하트비트 22:20).
- **확인하지 못한 것**(사용자 몫): 로그인한 화면을 브라우저로 보지 않았다 — 평소 로그인이 끊기지 않는지(가장 중요 — 새 미들웨어가 모든 로그인 요청에서 이 칸을 읽는다), 비밀번호를 바꾸면 다른 브라우저의 로그인이 30초 안에 끝나는지, 관리자 '비밀번호 재발급'이 임시 비밀번호를 보이고 그 비밀번호로 로그인되는지. 이번 배포 전에 로그인한 세션은 `authAt`이 없어 세션을 다시 쓰면 빠져나갈 수 있다(30일 안에 사라짐).

## 2026-11-16(오후 3): 내 비밀번호 바꾸기

- 2026-11-16 17:01 KST 배포 `dpl_Dejdo6yJErcBCcvPZZ99vz2Q8jrS`(커밋 `2fc3776`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영"). 마이그레이션 없음. 되돌릴 때는 직전 `dpl_ERUWju7vd6U5WJprQdh548mL1xG4`(87731e2)로 promote한다(비밀번호 바꾸기 화면·API만 빠진다 — 이미 바꾼 비밀번호는 그대로).
- 들어간 커밋: `0726872`(직전 배포 기록), `549a4f6` 내 비밀번호 바꾸기(사용자 메뉴 '비밀번호 바꾸기' `/my/password` → `POST /api/my/password` — 세션 본인만·대리 접근 403, 지금 비밀번호를 로그인과 같은 두 길로 확인하고 틀리면 로그인 실패로 셈·잠긴 계정 429, 세 종류 8자·두 종류 10자, Auth 비밀번호와 `password_hash`를 함께 맞춤, 보안 로그 `password_changed`), `2fc3776` 문서.
- **배포 전**: 가지 Preview(`2fc3776`, `workon-m187rso1i`) Ready를 확인한 뒤 `main`에 올렸다. 시험 DB(0001~0091)를 띄운 전체 시험 262파일 3,627개 통과·tsc 0.
- 배포 뒤 확인(로그인 없이, 운영 주소 — 대화 세션이 끊겨 22:05 KST에 확인): 운영 주소가 이 배포를 가리킴, `/`·`/login`·`/my/password`·`/api/system/maintenance`·`/api/branding` 200, `POST /api/my/password` 401, `GET /api/my/password` 405. pg_cron 호출 200(22:03~22:05 KST, 실행기 하트비트 22:05).
- **확인하지 못한 것**(사용자 몫): 로그인해서 비밀번호를 실제로 바꿔 보고 새 비밀번호로 다시 로그인되는지, 옛 비밀번호가 거절되는지(관리자가 등록한 임시 비밀번호 계정 하나와 가입 계정 하나) 브라우저로 보지 않았다(자동 시험만). 이미 열린 다른 기기의 로그인은 끝내지 않는다.

## 2026-11-16(오후 2): 직원 세션 계정 확인

- 2026-11-16 16:02 KST 배포 `dpl_ERUWju7vd6U5WJprQdh548mL1xG4`(커밋 `87731e2`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영"). 마이그레이션 없음. 되돌릴 때는 직전 `dpl_CbdxBhpsBMzXrJCHJpJzKpi9DjMJ`(015a981)로 promote한다(되돌리면 비활성·탈퇴·권한/소속이 바뀐 계정의 옛 로그인이 다시 만료까지 쓰인다).
- 들어간 커밋: `21bac36`(직전 배포 기록), `530ad07` 직원 세션 계정 확인(미들웨어가 토큰이 있는 요청마다 계정을 서비스 키로 다시 봄 — 30초 기억, 비활성·탈퇴·역할/부서가 토큰과 다르면 세션 쿠키를 지우고 API 401·화면은 로그인으로, 못 읽으면 10분 안의 마지막 값·없으면 받음, 대리 접근은 들어온 슈퍼관리자도 활성이어야·활성 관리자로만 들어감·서명 비밀값은 config에서), `87731e2` 문서.
- **배포 전**: 가지 Preview(`87731e2`, `workon-gdpegwrid`) Ready를 확인한 뒤 `main`에 올렸다(Preview는 Vercel 로그인 보호라 curl로는 302만 보임). 시험 DB(0001~0091)를 띄운 전체 시험 261파일 3,614개 통과·tsc 0.
- 배포 뒤 확인(로그인 없이, 운영 주소): `/`·`/login`·`/signup`·`/super/login`·`/api/system/maintenance`·`/api/branding` 200, `GET /api/users` 403(위조 세션 쿠키도 403 — 서명이 틀린 토큰은 계정 확인 전에 버려짐), `GET /api/super/accounts/users` 401, `POST /api/chat` 401. pg_cron 호출 200(16:05~16:07 KST, 실행기 하트비트 16:05).
- **확인하지 못한 것**(사용자 몫): 로그인한 직원으로 평소처럼 쓸 수 있는지(정상 계정이 끊기지 않는지), 비활성화한 직원이 30초 안에 로그인 화면으로 가는지, 부서를 옮긴 직원에게 '권한이나 소속이 바뀌어' 안내가 뜨는지를 브라우저로 보지 않았다(자동 시험만).

## 2026-11-16(오후): 관리자 로그인 잠금 풀기

- 2026-11-16 15:03 KST 배포 `dpl_CbdxBhpsBMzXrJCHJpJzKpi9DjMJ`(커밋 `015a981`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영"). 마이그레이션 없음. 되돌릴 때는 직전 `dpl_EmY2ubUhpVJziZ7iyKJ2VaX3Cc1Q`(a66381c)로 promote한다(잠금 자체는 그대로 돌고 풀기 화면만 빠진다).
- 들어간 커밋: `635a471`(직전 배포 기록), `c2bb9ec` 관리자 로그인 잠금 풀기(기관 관리자 '사용자 관리'·슈퍼관리자 '계정 관리' 두 표에 잠김·풀리는 때·'잠금 풀기' — 기관 관리자는 관리 범위 직원의 직원 로그인 잠금만·보안 로그 `sign_in_unlocked`, 슈퍼관리자는 두 잠금을 함께·`super_admin_logs`, IP 잠금은 그대로), `015a981` 문서.
- **배포 전**: 가지 Preview(`015a981`, `workon-llh0ofm9q`) Ready를 확인한 뒤 `main`에 올렸다. 시험 DB(0001~0091)를 띄운 전체 시험 260파일 3,602개 통과·tsc 0.
- 배포 뒤 확인(로그인 없이, 운영 주소): `/`·`/login`·`/api/system/maintenance`·`/api/branding` 200, `GET /api/users` 403, `GET /api/super/accounts/users`·`/api/super/accounts/super-admins` 401, `DELETE /api/users/{id}/sign-in-lock` 403, `DELETE /api/super/accounts/users/{id}/sign-in-lock` 401. pg_cron 호출 200(15:05~15:07 KST, 실행기 하트비트 15:05).
- **확인하지 못한 것**(사용자 몫): 로그인해 잠긴 계정이 목록에 '로그인 잠김 · 시:분 풀림'으로 보이고 '잠금 풀기'로 풀리는지 브라우저로 보지 않았다(자동 시험만).

## 2026-11-16(아침): 로그인 실패 잠금(0091)

- **먼저 운영 DB에 0091 적용**(2026-11-16 08:3x KST, 사용자 "운영반영"). 적용 뒤 확인(읽기 전용): `sign_in_failures` 칸 다섯(`ip_hash`만 비어도 됨)·CHECK 셋·색인 셋(기본 키 포함)·RLS 켜짐·정책 0, anon·authenticated 읽기·쓰기·지우기 권한 없음, service_role 읽기·쓰기·지우기 있음, RLS 꺼진 public 표 0.
- 그다음 코드 배포 `dpl_EmY2ubUhpVJziZ7iyKJ2VaX3Cc1Q`(커밋 `a66381c`, 2026-11-16 08:38 KST, `main` fast-forward — GitHub 연동). 들어간 커밋: `dfdcc1a`(직전 배포 기록), `d1f0382` 로그인 실패 잠금(직원 로그인 두 길·슈퍼관리자 로그인 — 한 계정 30분 5번·한 IP 30번이면 잠금, 이메일·IP는 SHA-256만, 실패 기록을 못 읽으면 막지 않음), `a66381c` 문서. 되돌릴 때는 직전 `dpl_EZBC35Zxpf8zfC9yFLUrAgchEmeF`(5dab6f2)로 promote한다 — 0091은 되돌리지 않아도 된다(옛 코드는 이 표를 읽지 않는다).
- **배포 전**: 가지 Preview(`a66381c`, `workon-m36z87d6h`) Ready를 확인한 뒤 `main`에 올렸다. 시험 DB(0001~0091)를 띄운 전체 시험 259파일 3,588개 통과·tsc 0.
- 배포 뒤 확인(로그인 없이, 운영 주소): `/`·`/login`·`/api/system/maintenance`·`/api/branding` 200, `/api/super/dashboard` 401. 없는 계정(`nobody@example.invalid`)으로 `POST /api/super/auth/login` 401 → 운영 `sign_in_failures`에 한 줄(그 이메일의 해시만) 쌓인 것을 확인 — 실패 기록이 실제로 남는다(이 줄은 30분 뒤 판정에서 빠지고 하루 뒤 치워진다). pg_cron 호출 200(08:44~08:46 KST, 실행기 하트비트 08:45).
- **확인하지 못한 것**(사용자 몫): 직원 로그인 화면에서 다섯 번 틀린 뒤 잠김 안내가 보이는지 브라우저로 보지 않았다(자동 시험만). 관리자가 잠금을 직접 푸는 화면은 없다(30분 기다림).

## 2026-11-13(오후): 공개 키로 열려 있던 DB 닫기(0090)·미들웨어 서비스 키·비활성 슈퍼관리자 토큰

- **먼저 운영 DB에 0090 적용**(2026-11-13 16:0x KST, 사용자 "운영반영") — 코드와 상관없이 적용만으로 누출이 닫힌다. 적용 전 운영 확인(읽기 전용·수만): 브라우저에 실린 공개 키(anon)로 PostgREST를 부르면 RLS가 꺼진 표 여섯(`agent_history` 48행 — 비서 판 사본·지시문, `chat_attachments` 3행 — 첨부 이름·요약, `schema_migrations` 88행, `agent_templates`·`common_documents`·`generated_files` 0행)을 읽을 수 있었고 이 표들에 INSERT·UPDATE·DELETE·TRUNCATE 권한까지 있었다. 뷰 `v_organization_summary`(기관 2행 — 담당자 이름·메일·요금)·`v_monthly_billing`, 대시보드에서 만든 정책 `departments_select_all`이 걸린 `departments`(4행)도 읽혔다. 공개 역할 정책은 10개(마이그레이션 밖에서 만든 것).
- 적용 뒤 확인(읽기 전용): RLS 꺼진 public 표 0, public·anon·authenticated 정책 0, anon·authenticated 표 권한 0, 뷰 anon 읽기 없음, service_role 권한 59 그대로, 적용 기록 있음. 공개 키로 다시 부르면 표·뷰 모두 401(42501), 서비스 키는 그대로 읽힘. 옛 코드가 도는 운영 주소 `/login`·`/signup`·`/api/system/maintenance`·`/api/branding` 200.
- 그다음 코드 배포 `dpl_EZBC35Zxpf8zfC9yFLUrAgchEmeF`(커밋 `5dab6f2`, 2026-11-13 16:12 KST, `main` fast-forward — GitHub 연동). 들어간 커밋: `205cf4f`(직전 배포 기록), `2cad4a6` 0090·업무 DB 시험의 거절 코드(트리거 23514 또는 권한 42501), `cde9c6e` 미들웨어가 점검 모드·접속 허용 IP를 서비스 키로 읽기(예전엔 공개 키라 RLS에 막혀 **두 기능이 한 번도 걸리지 않았다** — 운영은 점검 모드 꺼짐·허용 IP 쓰는 기관 없음이라 동작 변화 없음)·`/super` 화면·`/api/super` API·점검 모드 통과 때 슈퍼관리자 계정 상태를 DB로 다시 보기(30초 기억 — 비활성화하면 30초 안에 막힘), `5dab6f2` 문서. 되돌릴 때는 직전 `dpl_3xSQhSMwhu3xd55PV9peH1QBLkXJ`(b53cd9f)로 promote한다 — 0090은 되돌리지 않는다(앱은 서비스 키로만 표를 써 영향 없음).
- **배포 전**: 가지 Preview(`5dab6f2`, `workon-k9erfta2w`) Ready를 확인한 뒤 `main`에 올렸다. 시험 DB(0001~0090)를 띄운 전체 시험 258파일 3,577개 통과·tsc 0.
- 배포 뒤 확인(로그인 없이, 운영 주소): `/login`·`/signup`·`/super/login`·`/api/system/maintenance`·`/api/branding` 200, `/super` 307, `/api/super/accounts/users`(토큰 없음·위조 토큰) 401, `POST /api/chat`·`GET /api/forbidden-words` 401. pg_cron 호출 200(16:13~16:15 KST, 실행기 하트비트 16:15).
- **확인하지 못한 것**(사용자 몫): 로그인한 화면(직원·관리자·슈퍼관리자)을 이 배포 뒤 브라우저로 보지 않았다. 슈퍼관리자 비활성화 → 30초 안에 막힘은 운영에서 재현하지 않았다(자동 시험만).

## 2026-11-13(아침): 보안 고침 넷(금지어 범위·로그인 소속·초대 링크·슈퍼관리자 인증)·법령 본문 조회·예산 빠른 확인

- 2026-11-13 08:46 KST 배포 `dpl_3xSQhSMwhu3xd55PV9peH1QBLkXJ`(커밋 `b53cd9f`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영"). 마이그레이션 없음. 되돌릴 때는 직전 `dpl_FU8PY7wDumqiRZMb2pQnhwz5Z5Zn`(2bad33c — 08:20에 같은 커밋을 다시 배포한 것, 그 전 `dpl_D8b2uKspFxPu3VNTzcUvahiNcQFy`)으로 promote한다. 되돌리면 아래 보안 구멍이 다시 열린다.
- 들어간 커밋: `cb59101`(직전 배포 기록), `46b903e` 조회 단계 행정규칙·법령해석례 본문·국가법령정보 거절 까닭([조회 단계](APP_LOOKUP_STEPS.md)), `99d28e0` 앱 예약 실행기의 15분 예산 알림 빠른 확인([예산 알림](BUDGET_ALERTS.md)), `2af2d8b` 금지어 목록·고치기를 관리 범위로·대화 필터는 상위 부서 금지어까지(목록에 기관 조건이 없어 **모든 기관의 금지어가 보였다**), `f94d88a` 로그인이 소속을 추측하지 않음(공개 가입한 Auth 계정이 **가장 오래된 부서 = 첫 기관 직원**이 되던 길·하드코딩 관리자 이메일 제거), `741a0bb` 초대 가입은 초대받은 이메일로만·한 링크 한 계정, `5778778` 슈퍼관리자 설정 막이(운영 슈퍼관리자가 둘이라 `maybeSingle()` 막이가 열려 있었다)·비활성 슈퍼관리자 로그인 거절·운영에서 서명 비밀값 고정 값 거절, `b53cd9f` 문서.
- **배포 전**: 운영 DB 읽기 전용 확인 — 금지어는 한 기관 6개(모두 최상위 부서), 부서 없는 사용자 0, `users` 행 없는 Auth 계정 1(이제 로그인 못 함 — 의도), Supabase 공개 가입 켜짐(`disable_signup: false`)·메일 확인 필요, 슈퍼관리자 2명. Vercel 운영 환경 변수 `SUPER_JWT_SECRET`·`SUPER_ADMIN_SETUP_KEY` 있음(이름만 확인). 가지 Preview(`b53cd9f`, `workon-c4inxjxfq`) Ready를 확인한 뒤 `main`에 올렸다. 시험 DB를 띄운 전체 시험 257파일 3,567개 통과·tsc 0. 08:20 KST의 운영 배포(`dpl_FU8PY7…`)는 같은 커밋 `2bad33c`의 재배포(사용자 — 법령 OC 키 반영으로 보임)라 그대로 진행했다.
- 배포 뒤 확인(로그인 없이, 운영 주소): `/login`·`/signup`·`/super/login` 200, `/super` 307(위조 토큰도 307), `GET /api/forbidden-words` 401, `POST /api/chat`·`/api/apps/webhook`·`GET /api/super/accounts/users`·`/api/cron/app-schedules` 401, `POST /api/super/auth/setup`(틀린 키) 403, `POST /api/super/auth/login`(틀린 계정) 401, `POST /api/signup`(빈 몸) 400. pg_cron 호출 200(08:48~08:50 KST, 실행기 하트비트 08:50).
- **확인하지 못한 것**(사용자 몫): 로그인해 관리자 금지어 화면(부서 이름 표시)·초대 링크 가입(이메일 칸 잠김)·슈퍼관리자 로그인을 브라우저로 보지 않았다. 예산 빠른 확인은 KST :00·:15·:30·:45 차례에만 돌아 배포 뒤 첫 차례(09:00)는 보지 않았다. 법령 본문 조회는 국가법령정보에 서버 주소를 등록하기 전까지 실제 응답으로 확인할 수 없다. 이미 발급된 슈퍼관리자 토큰은 비활성화해도 24시간 남는다(남은 공백).

## 2026-11-12(밤): 문서 찾기 평가 — 같은 세트로 잰 다른 비서

- 2026-11-12 21:47 KST 배포 `dpl_D8b2uKspFxPu3VNTzcUvahiNcQFy`(커밋 `2bad33c`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영"). 마이그레이션 없음. 되돌릴 때는 직전 `dpl_87QcnsBwRkxrCyUCCW7PUjWtkM28`(82db02f)로 promote한다(새 실행의 `summary.setKey`는 남아도 해가 없다).
- 들어간 커밋: `0cb2766`(직전 배포 기록), `843e5a2` 세트 지문(`ragEvalSetKey`, 새 실행 `summary.setKey`)·`GET /api/admin/rag-eval?across=<실행 id>`(같은 세트로 잰 다른 비서마다 가장 최근 실행의 요약 — 평가할 수 있는 비서만)·평가 결과 위 '같은 세트로 잰 다른 비서'([일괄 평가](RAG_EVAL.md)), `2bad33c` 문서.
- **배포 전**: 가지 Preview(`2bad33c`, `workon-jxwdyf29c`) Ready를 확인한 뒤 `main`에 올렸다(웹훅이 제때 왔다). 시험 DB를 띄운 전체 시험 251파일 3,525개 통과(불러오지 못한 파일 0)·tsc 0. 새 조회 조건(`summary->>setKey`·`summary->setKey` is null)은 운영 API로 읽기 전용으로 한 번 돌려 확인했다(운영 평가 기록 0개라 실제 비교는 보지 못함).
- 배포 뒤 확인(로그인 없이, 운영 주소): `/login` 200, `/admin/documents` 307, `GET /api/admin/rag-eval?across=…`·`?agentId=…` 403. pg_cron 호출 200(21:48~21:50 KST — 21:50은 5분 앱 예약 실행기).
- **확인하지 못한 것**(사용자 몫): 로그인해 두 비서를 같은 세트로 평가한 뒤 '같은 세트로 잰 다른 비서'에 둘이 함께 나오는지(브라우저로 보지 않았다).

## 2026-11-12(오전): 공통 자료실 인용 기관

- 2026-11-12 10:53 KST 배포 `dpl_87QcnsBwRkxrCyUCCW7PUjWtkM28`(커밋 `82db02f`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영"). 마이그레이션 없음. 되돌릴 때는 직전 `dpl_9BWLrtdQiCR9nuqjQdXgAPHrTe86`(9c3b4b6)로 promote한다.
- 들어간 커밋: `6c8add2`(직전 배포 기록), `d1b478b` 슈퍼관리자 공통 자료실 '인용 기관'(`GET /api/super/common-documents/[id]/cited-by` — 그 유형 기관마다 같은 이름·이름 비슷 인용 문서 수만, 문서 이름 없음 — [참조 관계](DOCUMENT_REFERENCES.md)), `82db02f` 문서.
- **배포 전**: 가지 Preview(`82db02f`, `workon-l9zq439eq`) Ready를 확인한 뒤 `main`에 올렸다(웹훅이 제때 왔다). 시험 DB를 띄운 전체 시험 250파일 3,521개 통과(불러오지 못한 파일 0)·tsc 0 — 처음 돌린 전체 시험의 1,000행 상한 검사가 같은 이름 조회의 `.limit(5000)`을 잡아 쪽마다 읽기로 고쳤다. 새 조회(`agent:agents(deleted_at)`·`keys:metadata->references->keys`·`contains`)는 운영 API로 읽기 전용으로 한 번 돌려 확인했다(운영 공통 자료실 문서 0개라 실제 숫자는 보지 못함).
- 배포 뒤 확인(로그인 없이, 운영 주소): `/login` 200, `/super/common-library` 307, `GET /api/super/common-documents/[id]/cited-by`·`GET /api/super/common-documents` 401. pg_cron 호출 200(11:00~11:04 KST — 11:00은 5분 앱 예약 실행기).
- **확인하지 못한 것**(사용자 몫): 슈퍼관리자로 공통 문서를 올린 뒤 '인용 기관'에 기관별 수가 나오는지(브라우저로 보지 않았다).

## 2026-11-12(아침): 결과 저장 실패 회수·공통 기준 인용 문서·이름 비슷

- 2026-11-12 08:28 KST 배포 `dpl_9BWLrtdQiCR9nuqjQdXgAPHrTe86`(커밋 `9c3b4b6`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영" — 세 묶음). 마이그레이션 없음. 되돌릴 때는 직전 `dpl_5TehzbJByvR8bpS1kXNvNZYqsYoW`(fc5f98a)로 promote한다(예약 도장 `conversations.metadata.app_schedule`은 남아도 해가 없다).
- 들어간 커밋: `a39b8fc`(직전 배포 기록), `1528479` 예약 결과 저장 한 번 더·마친 실행 도장으로 멈춘 차지 회수(`recovered`)·일괄 실행 줄 저장 오류를 던지고 한 번 더([앱 예약](APP_SCHEDULES.md)·[일괄 실행](APP_BATCHES.md)), `fbea285` 관리자 '공통 기준 문서'의 '인용하는 문서'(`GET /api/admin/common-documents/[id]/cited-by`)·거꾸로 목록의 '이름 비슷'(`similarCitation`·`listSimilarCiting` — [참조 관계](DOCUMENT_REFERENCES.md)), `9c3b4b6` 문서.
- **배포 전**: 가지 Preview(`9c3b4b6`, `workon-ke0uj9uml`) Ready를 확인한 뒤 `main`에 올렸다(웹훅이 제때 왔다). 시험 DB를 띄운 전체 시험 249파일 3,517개 통과(불러오지 못한 파일 0)·tsc 0. 이름 비슷 조회(`keys:metadata->references->keys`·`metadata->references->>status`)는 시험 DB에 PostgREST가 없어 배포 전에 운영 API로 같은 조회를 읽기 전용으로 한 번 돌려 열쇠 배열이 오는 것을 확인했다(문서 이름은 보지 않음).
- 배포 뒤 확인(로그인 없이, 운영 주소): `/login` 200, `/admin/documents` 307, `GET /api/admin/common-documents/[id]/cited-by` 403, `GET /api/documents/[id]/references` 401, `/api/cron/app-schedules` 비밀값 없이 401. pg_cron 호출 200(08:29~08:31 KST — 08:30은 5분 앱 예약 실행기). 참조 색인: 기관 문서 3개 모두 색인됨(`ok` 3).
- **확인하지 못한 것**(사용자 몫): 로그인해 관리자 '공통 기준 문서'의 '인용하는 문서'·참조 창 거꾸로 목록의 '이름 비슷' 표시, 예약 결과 저장 실패 회수는 운영에서 재현하지 않았다(자동 시험만).

## 2026-11-12(새벽 2): 문서 참조 색인 자동 채우기·시험 판 실행 대화 표시

- 2026-11-12 00:59 KST 배포 `dpl_5TehzbJByvR8bpS1kXNvNZYqsYoW`(커밋 `fc5f98a`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영"). 마이그레이션 없음. 되돌릴 때는 직전 `dpl_3ooe2qoLoCuZhb89rz3U7Jzysk2n`(7d28756)로 promote한다(채운 색인은 `metadata.references`에 남아도 해가 없다).
- 들어간 커밋: `f4d8af6`(직전 배포 기록), `1404986` 5분 실행기가 모든 기관의 색인 없는 문서를 두 개씩 채움(`autoIndexReferences` — [참조 관계](DOCUMENT_REFERENCES.md))·대화 화면의 '시험 판 실행' 이름표·이어 묻기 안내·시험 판 답변의 이어 실행 숨김([시험 판](APP_DRAFTS.md)), `fc5f98a` 문서.
- **배포 전**: 가지 Preview(`fc5f98a`, `workon-320xs122a`) Ready를 확인한 뒤 `main`에 올렸다(웹훅이 제때 왔다). 시험 DB를 띄운 전체 시험 246파일 3,499개 통과(불러오지 못한 파일 0)·tsc 0.
- 배포 뒤 확인(로그인 없이, 운영 주소): `/login`·`/chat` 200, `/api/cron/app-schedules` 비밀값 없이 401, `/api/documents/references/build` GET 405(POST만). pg_cron 호출 200(01:00 KST). **색인 자동 채우기 실측**(읽기 전용 셈): 배포 직후 기관 문서 3개 중 색인 0 → 01:00 실행기 한 번 뒤 2개(`ok` 2·`skipped` 0). 남은 하나는 다음 차례에 채워진다.
- **확인하지 못한 것**(사용자 몫): 로그인해 '참조 문서' 창의 '이 문서를 인용하는 문서'에 자동 색인한 문서가 잡히는지, 시험 판 실행 뒤 '대화에서 근거 확인·추가 요청하기'로 연 대화에 이름표·안내가 보이는지(브라우저로 보지 않았다).

## 2026-11-12(새벽): 앱 실행 현황에서 시험 판 실행 빼기(0089)·근거 칩 시행일·관리자 공통 기준 문서 판 비교

- 2026-11-12 00:20 KST 배포 `dpl_3ooe2qoLoCuZhb89rz3U7Jzysk2n`(커밋 `7d28756`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영"). 되돌릴 때는 직전 `dpl_EmMuw7hsE7acSLsABzPYg9XhnN6v`(2bc97e6)로 promote한다. 0089는 함수 정의만 바꾼 것이라(같은 이름·인자·반환) 그대로 둬도 된다 — 0046으로 되돌리려면 0046을 다시 적용한다.
- **운영 DB 먼저**: `npm run db:migrate -- 0089`(00:1x KST). 읽기 전용 확인 — `app_run_states` 하나, 정의에 `app_draft` 조건, 실행 권한 anon·authenticated 없음·service_role 있음, 실제 호출(운영 입력형 앱 0개라 30일 실행 0행).
- 들어간 커밋: `ae34036`(직전 배포 기록), `4ac5b0c` 0089(관리자 '앱 실행 현황'·기관 통계 API `app-runs`가 시험 판 실행을 세지 않음 — [앱 실행 현황](APP_RUN_OVERVIEW.md))·근거 칩 시행일(`sourceEffectiveLabel`)·기관 관리자 '공통 기준 문서'의 '옛 판과 비교'(`GET /api/admin/common-documents/[id]/compare` — 이 기관 유형만 — [문서 판](DOCUMENT_EDITIONS.md)), `7d28756` 문서.
- **배포 전**: 가지 Preview(`7d28756`, `workon-kqwcq4ppc`) Ready를 확인한 뒤 `main`에 올렸다(웹훅이 제때 왔다). 시험 DB를 띄운 전체 시험 245파일 3,490개 통과(빠진 파일 없음)·tsc 0.
- 배포 뒤 확인(로그인 없이, 운영 주소): `/login` 200, `/admin/documents` 307, `GET /api/admin/common-documents`·`…/[id]/compare` 403, `GET /api/admin/app-overview` 401, `/api/v1/app-runs` 401. pg_cron 호출 200(00:24~00:25 KST).
- **확인하지 못한 것**(사용자 몫): 로그인해 관리자 문서 화면 '공통 기준 문서'에서 판을 바꾼 문서의 '옛 판과 비교'가 열리고 엑셀·한글이 받아지는지, 시행일을 정한 문서로 답한 대화의 근거 칩에 시행일이 보이는지, 앱 빌더에서 시험 실행한 뒤 관리자 '앱 실행 현황' 숫자가 늘지 않는지(브라우저로 보지 않았다).

## 2026-11-11(밤 4): 일괄 실행의 기대 핵심어·비동기 연동 마지막 결과(0088)

- 2026-11-11 23:57 KST 배포 `dpl_EmMuw7hsE7acSLsABzPYg9XhnN6v`(커밋 `2bc97e6`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영"). 되돌릴 때는 직전 `dpl_5w8RnPnkH7UbhxDZjBwmvkXvVJZL`(ad2525b)로 promote한다. 0088은 칸 추가라(옛 코드는 읽지 않음) 그대로 둬도 된다.
- **운영 DB 먼저**: `npm run db:migrate -- 0088`(23:5x KST). 읽기 전용 확인 — `app_batch_items.expect`(text)·`expect_missing`(text[]) 둘 다 NULL 가능, `app_batch_items_expect_check`(1~500자)·`app_batch_items_expect_missing_check`(`expect`가 있을 때만·20개), RLS 켜짐, 운영 일괄 실행 줄 0행.
- 들어간 커밋: `ca40e57`(직전 배포 기록), `180f40d` 일괄 실행 표의 '기대 핵심어' 칸(줄마다 저장, 실행기가 줄을 마칠 때 답변에 핵심어가 모두 있는지 한 번 재 `expect_missing`에 — 모델 없음, 목록 `핵심어 맞음 N/M`·엑셀 두 열, 핵심어 규칙은 `keyword-match.ts` 한 곳 — [일괄 실행](APP_BATCHES.md))·비동기 연동 묶음의 줄이 끝나면 그 연동의 마지막 결과를 바꿈, `2bc97e6` 문서.
- **배포 전**: 가지 Preview(`2bc97e6`, `workon-da57168jn`) Ready를 확인한 뒤 `main`에 올렸다(웹훅이 제때 왔다). 시험 DB를 띄운 전체 시험 244파일 3,483개 통과(빠진 파일 없음)·tsc 0.
- 배포 뒤 확인(로그인 없이, 운영 주소): `/login`·`/apps/run` 200, `GET`·`POST /api/apps/batches`·결과 엑셀 401, `GET /api/apps/webhook/batches/[id]` 401. pg_cron 호출 200(23:56~00:00 KST — 00:00은 배포 뒤 첫 5분 앱 예약 실행기, 새 칸을 읽는 일괄 실행 실행기 포함).
- **확인하지 못한 것**(사용자 몫): 로그인해 일괄 실행 표에 '기대 핵심어' 칸을 넣어 돌린 뒤 목록에 `핵심어 맞음 N/M`이 나오고 엑셀 판정 열이 맞는지, 비동기 연동 호출이 끝난 뒤 연동 목록의 마지막 결과가 바뀌는지(브라우저로 보지 않았다).

## 2026-11-11(밤 3): 외부 연동 비동기 호출·결과 콜백·상태 묻기(0087)

- 2026-11-11 23:28 KST 배포 `dpl_5w8RnPnkH7UbhxDZjBwmvkXvVJZL`(커밋 `ad2525b`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영"). 되돌릴 때는 직전 `dpl_3aEXhRzAbEPX5ZnNyNin8QRyRawK`(5bcce9c)로 promote한다. 0087은 칸·색인 추가라(옛 코드는 읽지 않음) 그대로 둬도 된다.
- **운영 DB 먼저**: `npm run db:migrate -- 0087`(23:2x KST). 읽기 전용 확인 — `app_batches.source`(text, NOT NULL, 기본 `'manual'`)·`webhook_id`(uuid, NULL 가능), `app_batches_source_check`(manual·webhook)·`app_batches_webhook_source_check`(`webhook_id IS NULL OR source = 'webhook'`)·외래 키 `app_webhooks(id) ON DELETE SET NULL`, 색인 `app_batches_webhook_idx`·`app_batch_items_message_idx`, RLS 켜짐, 운영 일괄 실행 0행.
- 들어간 커밋: `47469ff`(직전 배포 기록), `b5737d3` 외부 연동 비동기 호출(`"async": true`·`Prefer: respond-async` → 202와 `batch_id`, 그 직원의 한 줄 일괄 실행 `source='webhook'`, 결과는 앱의 결과 보낼 곳으로 몸에 `run.batch_id`, 파일·문서함 문서 호출 400·실행 중 일괄 실행 3개면 429·같은 `Idempotency-Key`면 같은 `batch_id`·마침 메일 없음)·상태 묻기 `GET /api/apps/webhook/batches/[id]`(같은 토큰, 그 연동이 넣은 묶음만 — [앱 연동](APP_WEBHOOKS.md)), `ad2525b` 문서.
- **배포 전**: 가지 Preview(`ad2525b`, `workon-gzerlnibx`) Ready를 확인한 뒤 `main`에 올렸다(웹훅이 제때 왔다). 시험 DB를 띄운 전체 시험 243파일 3,469개 통과(빠진 파일 없음)·tsc 0.
- 배포 뒤 확인(로그인 없이, 운영 주소): `/login` 200, `GET /api/apps/webhook/batches/[id]` 토큰 없이·틀린 토큰 모두 401(토큰 조회까지 돌고 500 없음), `POST /api/apps/webhook` 비동기(본문 `async`·`Prefer`) 토큰 없이·틀린 토큰 401, `/api/v1/budget` 401, `/api/apps/batches` 401. pg_cron 호출 200(23:28~23:30 KST — 23:30은 5분 앱 예약 실행기).
- **확인하지 못한 것**(사용자 몫): 실제 연동 토큰으로 `"async": true` 호출 → 202·`batch_id` → 5분 안에 실행되고 상태 묻기가 `queued` → `completed`로 바뀌는지, 결과 보낼 곳이 있는 앱이면 받는 쪽 몸에 `run.batch_id`가 오는지(운영에서 직접 부르지 않았다).

## 2026-11-11(밤 2): 기관 통계 API 끝점 셋(0086)

- 2026-11-11 21:36 KST 배포 `dpl_3aEXhRzAbEPX5ZnNyNin8QRyRawK`(커밋 `5bcce9c`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영"). 되돌릴 때는 직전 `dpl_8zi6sUATcdTpaMcNGDm7YsnemviA`(1091e1d)로 promote한다. 0086은 호출 기록 CHECK를 넓힌 것이라(옛 코드는 옛 셋만 씀) 그대로 둬도 된다.
- **운영 DB 먼저**: `npm run db:migrate -- 0086`(21:3x KST). 읽기 전용 확인 — `org_api_key_calls_endpoint_check`가 여섯 값(`feedback-summary`·`app-runs`·`budget` 포함), 상태 코드 CHECK 그대로, RLS 켜짐, 호출 기록 0행.
- 들어간 커밋: `7272602`(직전 배포 기록), `1a4fbf3` `GET /api/v1/feedback-summary`·`/api/v1/app-runs`·`/api/v1/budget`(범위 usage, 관리자 통계와 같은 읽기 함수 — 앱 실행 현황 읽기를 `run-overview-load.ts`로 뽑아 관리자 라우트와 함께 씀, 개인 앱 이름·개인 한도 없음 — [기관 통계 API](ORG_API.md))·`feedbackPeriod`의 없는 날짜 503 → 400, `5bcce9c` 문서.
- **배포 전**: 가지 Preview(`5bcce9c`, `workon-4dnofrv8m`) Ready를 확인한 뒤 `main`에 올렸다(웹훅이 제때 왔다). 시험 DB를 띄운 전체 시험 241파일 3,446개 통과(빠진 파일 없음)·tsc 0.
- 배포 뒤 확인(로그인 없이, 운영 주소): `/login` 200, `/admin/organization`·`/admin/stats` 307, `/api/v1/feedback-summary`·`app-runs`·`budget`·`usage-summary` 키 없이·틀린 키 모두 401, `GET /api/admin/app-overview` 401, `GET /api/admin/feedback-summary` 403. pg_cron 호출 200(21:35~21:37 KST).
- **확인하지 못한 것**(사용자 몫): 기관 정보 화면에서 이용통계 범위 키를 만들어 세 주소를 실제로 불러 숫자가 관리자 통계 화면과 같은지, 관리자 '앱 실행 현황'이 예전과 같게 나오는지(브라우저로 보지 않았다).

## 2026-11-11(밤): 예약 지금 실행·다시 보내기·마치지 못한 줄 다시 실행·부서별 줄인 시간(0085)

- 2026-11-11 21:16 KST 배포 `dpl_8zi6sUATcdTpaMcNGDm7YsnemviA`(커밋 `1091e1d`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영" — 작은 항목 넷 묶음). 되돌릴 때는 직전 `dpl_G5H7uyRUMkNQhAg55Lr1TRGHbZ4D`(c551c55)로 promote한다. 0085는 함수에 칸 하나를 더한 것이라(옛 코드는 읽지 않음) 그대로 둬도 된다.
- **운영 DB 먼저**: `npm run db:migrate -- 0085`(21:1x KST). 읽기 전용 확인 — `adoption_by_department` 정의에 `'saved_minutes'`·`'cost_krw'` 둘 다, 같은 이름 함수 하나, 실행 권한 anon·authenticated 없음·service_role 있음, 두 기관으로 실제 호출해 모든 부서 줄에 `saved_minutes`(합 0).
- 들어간 커밋: `715b4b7`(직전 배포 기록), `a0b1ae3` 앱 예약 '지금 한 번 실행'(켜짐·잠금 없음·실행기가 잡지 않음·10분 간격 — [앱 예약](APP_SCHEDULES.md)), 그만둔 결과 보내기의 직원 '다시 보내기'(시도 1번 이상·7일 안·보낼 곳 쓰임, 보안 로그 low — [결과 보내기](APP_OUTBOUND.md)), 일괄 실행 '마치지 못한 줄 다시 실행'(만들기와 같은 검사, 파일 줄 제외 — [일괄 실행](APP_BATCHES.md)), 부서별 도입 현황 '줄인 시간' 열(0085 — [도입 현황](ADOPTION_REPORT.md)), `1091e1d` 문서.
- **배포 전**: 가지 Preview(`1091e1d`, `workon-6sbyxc4rq`) Ready를 확인한 뒤 `main`에 올렸다(웹훅이 제때 왔다). 시험 DB를 띄운 전체 시험 240파일 3,437개 통과(빠진 파일 없음)·tsc 0.
- 배포 뒤 확인(로그인 없이, 운영 주소): `/login`·`/apps/run`·`/apps/schedules` 200, `/admin/stats` 307, `PATCH /api/apps/schedules/[id]`(run_now)·`POST /api/apps/outbound-deliveries/[id]`·`POST /api/apps/batches/[id]`·`GET /api/v1/adoption-report/departments` 401, `GET /api/admin/adoption-report/departments` 403. pg_cron 호출 200(21:15~21:18 KST).
- **확인하지 못한 것**(사용자 몫): 로그인해 ① 앱 예약 '지금 한 번 실행' 뒤 5분 안에 실행되고 다음 실행 시각이 원래 일정으로 돌아오는지 ② 그만둔 보내기에 '다시 보내기'가 보이고 받는 쪽에 다시 오는지 ③ 실패 줄이 있는 일괄 실행에서 '마치지 못한 줄 다시 실행'으로 새 묶음이 생기는지 ④ 관리자 '부서별 보기'·CSV의 '줄인 시간' 열(브라우저로 보지 않았다).

## 2026-11-11(저녁): 도입 현황 줄인 시간(0083)·일괄 실행 기관 상한(0084)·결과 엑셀 보내기 열

- 2026-11-11 17:24 KST 배포 `dpl_G5H7uyRUMkNQhAg55Lr1TRGHbZ4D`(커밋 `c551c55`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영" — 작은 항목 셋 묶음). 되돌릴 때는 직전 `dpl_3Rd8DR1hd7Y9DmX9Rk5fcpPEQbuA`(7e5d695)로 promote한다. 0083은 함수에 칸 둘을 더한 것이고(옛 코드는 읽지 않음), 0084는 칸 하나 추가라 그대로 둬도 된다(옛 코드는 상한을 보지 않음).
- **운영 DB 먼저**: `npm run db:migrate -- 0083`, `-- 0084`(17:1x KST). 읽기 전용 확인 — `adoption_report` 정의에 `saved_minutes_reported`·`completed_median_hours` 둘 다, 실행 권한 anon·authenticated 없음·service_role 있음, 기관 하나로 실제 호출해 두 칸이 나옴(값 0·0), `organizations.app_batch_max_rows`(smallint) + CHECK, 상한을 정한 기관 0/2.
- 들어간 커밋: `35af943`(직전 배포 기록), `aa4c143` 월별 도입 현황 '자기 신고' 묶음(직원이 고른 줄인 시간 합·고른 답 수 — [도입 현황](ADOPTION_REPORT.md)), `0982a00` 일괄 실행 기관 상한(1~100, 사유·보안 로그, 못 읽으면 만들기 닫힘)·결과 엑셀 보내기·접수 번호 열 — [일괄 실행](APP_BATCHES.md), `c551c55` 문서.
- **배포 전**: 가지 Preview(`c551c55`, `workon-avyuwsdf3`) Ready를 확인한 뒤 `main`에 올렸다(웹훅이 제때 왔다). 시험 DB를 띄운 전체 시험 239파일 3,428개 통과(빠진 파일 없음)·tsc 0.
- 배포 뒤 확인(로그인 없이, 운영 주소): `/login`·`/apps/run` 200, `/admin/stats`·`/admin/app-automations` 307, `PUT /api/admin/app-automations/batch-limit`·`GET /api/v1/adoption-report`·`/api/apps/batches/[id]/export` 401, `GET /api/admin/adoption-report` 403. pg_cron 호출 200(17:25~17:26 KST).
- **확인하지 못한 것**(사용자 몫): 로그인해 ① 관리자 통계 '월별 도입 현황'의 '자기 신고' 두 줄(줄인 시간을 고른 답이 생긴 뒤) ② '앱 예약·연동'에서 일괄 실행 상한을 바꾸고 직원이 상한을 넘겨 만들면 거절되는지 ③ 외부로 보낸 일괄 실행의 결과 엑셀 '보내기'·'접수 번호' 열(브라우저로 보지 않음).

## 2026-11-11(오후): 보내기 동작·알림 메일(0081)·답변 평가 줄인 시간(0082)

- 2026-11-11 15:57 KST 배포 `dpl_3Rd8DR1hd7Y9DmX9Rk5fcpPEQbuA`(커밋 `7e5d695`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영" — 작은 항목 넷을 묶어 한 번에). 되돌릴 때는 직전 `dpl_5MsidPkWdMVWjaer8h2xFyb3f4Co`(177ce45)로 promote한다. 0081·0082는 칸·CHECK·색인 추가라 그대로 둬도 된다 — 옛 코드는 새 칸을 읽지도 쓰지도 않는다(동작을 정한 보낼 곳도 동작 없이 보내고, 알림은 안 간다).
- **운영 DB 먼저**: `npm run db:migrate -- 0081`, `-- 0082`(15:5x KST). 읽기 전용 확인 — `app_outbound_endpoints.actions`(jsonb NOT NULL DEFAULT '[]')·`failure_notified_at`, `app_outbound_deliveries.action`·`approval_notified_at`, `message_feedback.saved_minutes`(smallint), CHECK 셋(`app_outbound_endpoints_actions_check`·`app_outbound_deliveries_action_check`·`message_feedback_saved_minutes_check`), 색인 `app_outbound_deliveries_unnotified_idx`, 세 표 RLS 켜짐, 보낼 곳·평가 행 0.
- 들어간 커밋: `335b575`(직전 배포 기록), `51ea88f` 받는 쪽 동작·알림 메일(보낼 곳마다 `키=이름` 5개·앱이 골라 몸·`X-Workon-Action`에, 그만둔 보내기는 기관 전체 관리자에게 6시간에 한 번, 확인 기다림은 10분 뒤 실행한 직원에게 — [결과 보내기](APP_OUTBOUND.md)), `2c2cbfd` 답변 평가의 '줄인 시간'(자기 신고 10분~반나절, 관리자 '답변 평가' 표에 비서별 합 — [도입 현황](ADOPTION_REPORT.md)), `7e5d695` 문서.
- **배포 전**: 가지 Preview(`7e5d695`, `workon-jbjp53tfm`) Ready를 확인한 뒤 `main`에 올렸다(웹훅이 제때 왔다). 시험 DB를 띄운 전체 시험 237파일 3,413개 통과(빠진 파일 없음)·tsc 0. (시험 DB가 그 사이 멈춰 있어 `npm run work:testdb -- start`로 다시 띄웠다 — 이 PC의 시험용 Postgres, 운영과 무관.)
- 배포 뒤 확인(로그인 없이, 운영 주소): `/login`·`/apps/run`·`/apps/builder`·`/chat` 200, `/admin/app-automations` 307, `GET /api/apps/outbound-endpoints`·`PUT /api/messages/[id]/feedback`·`/api/cron/app-schedules` 401, `PATCH /api/admin/outbound-endpoints/[id]` 403. pg_cron 호출 200(15:56~15:59 KST).
- **확인하지 못한 것**(사용자 몫): 로그인해 ① 관리자 '앱 결과 보낼 곳'에서 동작을 정하고 빌더에서 골라 실행한 뒤 받는 쪽에 `action`·`X-Workon-Action`이 오는지 ② 보내기가 그만둘 때 관리자 메일·확인 기다림 10분 뒤 직원 메일이 오는지 ③ 답변에 '도움됨' → '줄인 시간'을 고르고 관리자 '답변 평가' 표의 합(실제 외부 주소·메일 — 브라우저로 보지 않음).

## 2026-11-11(낮): 일괄 실행 관리자 현황·멈추기·받는 쪽 접수 정보(0080)

- 2026-11-11 14:40 KST 배포 `dpl_5MsidPkWdMVWjaer8h2xFyb3f4Co`(커밋 `177ce45`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영"). 되돌릴 때는 직전 `dpl_okrhn3Ax46yE67fQbXiL4jyQ55JG`(3e96f43)로 promote한다. 0080은 칸 둘·CHECK·색인 추가라 그대로 둬도 된다 — 옛 코드는 접수 칸을 쓰지도 읽지도 않는다.
- **운영 DB 먼저**: `npm run db:migrate -- 0080`(14:3x KST). 읽기 전용 확인 — `app_outbound_deliveries.receipt_ref`·`receipt_url`(text, NULL 허용), CHECK `app_outbound_deliveries_receipt_check`(보낸 기록에만·번호 1~100자·https 500자), 색인 `app_outbound_deliveries_user_idx`, RLS 켜짐, 행 0.
- 들어간 커밋: `a2e63c4`(직전 배포 기록), `3fe6521` 관리자 화면의 앱 일괄 실행 현황·멈추기(관리 범위 최근 50개 — 줄 수·상태만, 사유와 함께 멈춤·보안 로그 `app_batch_stopped`·직원 메일, 마이그레이션 없음 — [관리자 통제](APP_AUTOMATION_ADMIN.md)), `c972997` 받는 쪽 접수 정보(2xx 응답 앞 4KB의 `receipt`만 다듬어 남김·직원 실행 화면 '보낸 결과' — [결과 보내기](APP_OUTBOUND.md)), `177ce45` 문서.
- **배포 전**: 가지 Preview(`177ce45`, `workon-bh3gzzssw`) Ready를 확인한 뒤 `main`에 올렸다(웹훅이 제때 왔다). 시험 DB를 띄운 전체 시험 3,385개 통과(빠진 파일 없음)·tsc 0.
- 배포 뒤 확인(로그인 없이, 운영 주소): `/login`·`/apps/run` 200, `/admin/app-automations` 307, `GET /api/apps/outbound-deliveries`·`PATCH /api/admin/app-automations/batches/[id]`·`GET /api/admin/app-automations`·`/api/cron/app-schedules` 401. pg_cron 호출 200(14:40~14:42 KST).
- **확인하지 못한 것**(사용자 몫): 로그인해 ① 관리자 '앱 예약·연동'의 '앱 일괄 실행' 표와 멈추기(직원 메일) ② 받는 쪽이 `receipt`를 돌려줄 때 실행 화면 '보낸 결과'에 접수 번호·링크가 보이는지(실제 외부 주소·메일 — 브라우저로 보지 않음).

## 2026-11-10(밤 2): 일괄 실행의 '파일마다 한 건'(0079)

- 2026-11-10 22:33 KST 배포 `dpl_okrhn3Ax46yE67fQbXiL4jyQ55JG`(커밋 `3e96f43`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영"). 되돌릴 때는 직전 `dpl_6uxJ4EJrxi8ywWPtHyAkB82oiJDW`(b798c02)로 promote한다. 0079는 칸 하나 추가라 그대로 둬도 된다 — 옛 코드는 `file` 칸을 읽지 않아 파일 줄도 파일 없이 실행하고, 사본(`app-batch-files/…`)을 지우지 않는다.
- **운영 DB 먼저**: `npm run db:migrate -- 0079`(22:2x KST). 읽기 전용 확인 — `app_batch_items.file` jsonb(NULL 허용), CHECK `app_batch_items_file_check`(빠진 키를 COALESCE로 막는 꼴), RLS 켜짐, 줄 0.
- 들어간 커밋: `56654d7`(직전 배포 기록), `5edbd54` 파일마다 한 건(파일을 받는 앱은 10개까지 올려 파일 하나마다 실행, 입력 한 줄 또는 파일마다 한 줄, 요청자의 읽힌 첨부만 사본으로·원본은 묘비로, 실행 때 새 첨부로 다시 붙임, 묶음이 끝나면 사본 지움, 결과 엑셀 파일 열 — [일괄 실행](APP_BATCHES.md)), `3e96f43` 문서.
- **배포 전**: 가지 Preview(`3e96f43`, `workon-eyl0gjaxc`) Ready를 확인한 뒤 `main`에 올렸다(웹훅이 제때 왔다). 시험 DB를 띄운 전체 시험 232파일 3,367개 통과(빠진 파일 없음)·tsc 0. 0079는 시험 DB에 두 번 적용(첫 CHECK가 빠진 키를 통과시킨 것을 DB 시험이 잡아 COALESCE로 고친 뒤).
- 배포 뒤 확인(로그인 없이, 운영 주소): `/login`·`/apps`·`/apps/run` 200, `GET`·`POST /api/apps/batches`·`DELETE /api/apps/batches/[id]`·`…/export`·`/api/cron/app-schedules` 401. pg_cron 호출 200(22:33~22:35 KST — 새 코드의 앱 예약 실행기 차례 22:35 포함, 일괄 실행은 대상이 없어 빈 차례).
- **확인하지 못한 것**(사용자 몫): 로그인해 파일을 받는 앱의 실행 화면 '여러 건 한 번에 실행'에서 '파일마다 한 건'으로 파일 몇 개를 올려 실행하고, 5분 실행기가 파일마다 줄을 마치는지·결과 엑셀의 파일 열·묶음이 끝난 뒤 사본이 지워지는지(실제 NODA·모델·저장소 — 브라우저로 보지 않음).

## 2026-11-10(밤): 보내기 전 사람 확인(0078)·결과 한글 파일 함께 보내기·일괄 실행 마침 메일

- 2026-11-10 20:43 KST 배포 `dpl_6uxJ4EJrxi8ywWPtHyAkB82oiJDW`(커밋 `b798c02`, `main` fast-forward — GitHub 연동). 사용자 선택("가" = 운영반영). 되돌릴 때는 직전 `dpl_AjVGRfbxDrgTcgX38mA76jqEMhW6`(41ffc6d)로 promote한다. 0078은 추가만(칸 셋·상태 값 넓힘)이라 되돌려도 그대로 둬도 된다 — 옛 코드는 `require_approval`을 읽지 않아 확인을 켠 곳도 곧바로 보내고, 확인 기다림(`awaiting_approval`) 기록은 집지 않아 남는다. 옛 저장 검사는 앱 정의의 `deliverFile`을 모르는 칸으로 떨군다.
- **운영 DB 먼저**: `npm run db:migrate -- 0078`(20:3x KST). 읽기 전용 확인 — `app_outbound_endpoints.require_approval`(boolean NOT NULL DEFAULT false)·`app_outbound_deliveries.decided_by`·`decided_at`, 상태 CHECK 여섯 값·정한 때 짝 CHECK, 색인 `app_outbound_deliveries_awaiting_idx`, 두 표 RLS 켜짐·정책 0, 행 0(보낼 곳·보내기 기록 모두 없음).
- 들어간 커밋: `34645eb`(직전 배포 기록), `97d83f6` 보내기 전 사람 확인(보낼 곳마다 켜면 실행한 직원만 실행 화면에서 보내기·보내지 않기, 7일 지나면 그만둠, 보안 로그)·결과 한글 파일 함께(앱 빌더에서 고르면 보내기 직전에 앱 양식/표준 보고서로 만들어 base64로, 5MB 넘으면 글만 — 마이그레이션 없음 — [결과 보내기](APP_OUTBOUND.md)), `dc0cb64` 일괄 실행 마침 메일(묶음을 마치거나 멈추면 만든 직원에게 한 통, 입력·결과 글 없음 — [일괄 실행](APP_BATCHES.md)), `b798c02` 문서.
- **배포 전**: 가지 Preview(`b798c02`, `workon-n1nep3wap`) Ready를 확인한 뒤 `main`에 올렸다(웹훅이 제때 왔다). 시험 DB를 띄운 전체 시험 3,354개 통과(빠진 파일 없음)·tsc 0.
- 배포 뒤 확인(로그인 없이, 운영 주소): `/login`·`/apps`·`/apps/run`·`/apps/builder` 200, `/admin/app-automations` 307, `GET /api/apps/outbound-approvals`·`POST /api/apps/outbound-approvals/[id]`·`GET /api/apps/outbound-endpoints`·`/api/apps/batches`·`/api/cron/app-schedules` 401, `PATCH /api/admin/outbound-endpoints/[id]` 403. pg_cron 호출 200(20:43~20:45 KST, 실행기 하트비트 20:45).
- **확인하지 못한 것**(사용자 몫): 로그인해 ① 보낼 곳에 '보내기 전 확인'을 켜고 앱을 실행한 뒤 실행 화면 '보내기 전 확인할 결과'에서 보내기·보내지 않기 ② 빌더에서 '결과 한글 파일도 함께 보내기'를 켜고 받는 쪽에 `result.file`이 오는지·한글에서 열리는지 ③ 일괄 실행을 마친 뒤 마침 메일이 오는지(실제 외부 주소·메일 — 브라우저로 보지 않음).

## 2026-11-10(오후): 앱 결과 보내기(0076)·평가의 도구를 쓰는 답·앱 일괄 실행(0077)

- 2026-11-10 15:04 KST 배포 `dpl_AjVGRfbxDrgTcgX38mA76jqEMhW6`(커밋 `41ffc6d`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영"). 되돌릴 때는 직전 `dpl_85qLp1c679hs95tcZzXbFRVLhM97`(b107d93)로 promote한다. 0076·0077은 추가만이라 되돌려도 옛 코드가 그 표를 읽지 않을 뿐 그대로 둬도 된다(옛 저장 검사는 앱 정의의 `deliverEndpointId`를 모르는 칸으로 떨군다 — 다시 저장하면 보낼 곳이 빠짐).
- **운영 DB 먼저**: `npm run db:migrate -- 0076`, `-- 0077`(15:0x KST). 읽기 전용 확인 — 표 넷(`app_outbound_endpoints`·`app_outbound_deliveries`·`app_batches`·`app_batch_items`) 모두 RLS 켜짐·정책 0·anon/authenticated SELECT 권한 없음·service_role 있음, CHECK·외래 키·UNIQUE가 시험 DB와 같은 수, 행 0.
- 들어간 커밋: `8c7af36`(직전 배포 기록), `fdb7ca1` 앱 결과 보내기(기관 전체 관리자가 승인한 https 주소로 끝까지 마친 실행의 결과 글을 HMAC 서명·멱등 키와 함께, 사설 주소 거절·리디렉션 안 따름·재시도 5번 — [결과 보내기](APP_OUTBOUND.md)), `45385f0` 평가의 도구를 쓰는 답(`tools: true` — [일괄 평가](RAG_EVAL.md)), `f614ab2` 앱 일괄 실행(표·CSV 100줄을 줄마다 그 직원 권한으로, 결과 엑셀 — [일괄 실행](APP_BATCHES.md))·실행기가 결과 보내기·일괄 실행·예약을 나란히, `41ffc6d` 문서.
- **배포 전**: 가지 Preview(`41ffc6d`, `workon-1mjvam637`) Ready를 확인한 뒤 `main`에 올렸다(웹훅이 제때 왔다). 시험 DB를 띄운 전체 시험 227파일 3,322개 통과(빠진 파일 없음)·tsc 0.
- 배포 뒤 확인(로그인 없이, 운영 주소): `/`·`/login`·`/apps/run`·`/apps/builder` 200, `/admin/app-automations`·`/admin/documents` 307(로그인으로), `GET`·`POST /api/apps/batches`·`GET /api/apps/outbound-endpoints`·`/api/cron/app-schedules` 401, `/api/admin/outbound-endpoints`·`/api/admin/rag-eval` 403. pg_cron 호출 200(15:04~15:11 KST — 새 코드의 앱 예약 실행기 차례 15:10 KST 포함, 결과 보내기·일괄 실행은 대상이 없어 빈 차례).
- **확인하지 못한 것**(사용자 몫): 로그인해 ① '앱 예약·연동' 아래 '앱 결과 보낼 곳'에 받을 주소를 승인하고 빌더에서 골라 앱을 실행한 뒤 받는 쪽에 서명된 결과가 오는지 ② 답변까지 평가에서 '도구도 쓰기'로 공공 데이터 도구를 켠 비서를 재 보기 ③ 실행 화면 '여러 건 한 번에 실행'에 몇 줄을 넣고 5분 실행기가 줄을 마치는지·결과 엑셀(실제 NODA·모델·외부 주소 — 브라우저로 보지 않음, 처리량은 재지 않음).

## 2026-11-09(오후 5): 문서 찾기 단계 — 태그로 좁히기

- 2026-11-09 16:33 KST 배포 `dpl_85qLp1c679hs95tcZzXbFRVLhM97`(커밋 `b107d93`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영"). 되돌릴 때는 직전 `dpl_5CJnQv4LSUEZ7sGWXUs8ckvFfmmB`(e1b258d)로 promote한다. **마이그레이션 없음**. 되돌리면 옛 코드의 저장 검사는 `lookup.tags`를 모르는 칸으로 떨구고(정의를 다시 저장하면 태그 거르기가 빠진 채 저장됨) 실행기는 문서함 전체의 근거를 넘긴다.
- 들어간 커밋: `4223b7b`(직전 배포 기록), `72b6fa9` 태그로 좁히기(`lookup.tags` — 찾은 근거 중 태그 하나라도 붙은 이 기관 문서의 것만, 공통 기준은 빠짐, 태그를 못 읽으면 멈춤, 남는 것 없으면 정보 공백 — [조회 단계](APP_LOOKUP_STEPS.md)), `b107d93` 문서.
- **배포 전**: 가지 Preview(`b107d93`, `workon-nsdryjj9h`) Ready를 확인한 뒤 `main`에 올렸다(이번에는 웹훅이 제때 왔다). 시험 DB를 띄운 전체 시험 222파일 3,277개 통과(빠진 파일 없음)·tsc 0.
- 배포 뒤 확인(로그인 없이, 운영 주소): `/`·`/login`·`/apps/builder`·`/apps/run`·`/chat` 200, `GET /api/agents`·`POST /api/chat` 401, `PATCH /api/admin/rag-eval` 403. pg_cron 호출 200(16:33~16:35 KST).
- **확인하지 못한 것**(사용자 몫): 로그인해 문서에 태그를 붙여 두고, 문서 찾기 단계에 '이 태그 문서만'을 둔 앱을 저장·실행해 그 태그 문서의 근거만 남는지, 단계 결과의 '태그: …', 맞는 문서가 없을 때 정보 공백으로 넘어가는지 보기(실제 NODA·모델 — 브라우저로 보지 않음).

## 2026-11-09(오후 4): 사람 판정 — AI 채점자 정확도 재기

- 2026-11-09 15:40 KST 배포 `dpl_5CJnQv4LSUEZ7sGWXUs8ckvFfmmB`(커밋 `e1b258d`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영"). 되돌릴 때는 직전 `dpl_9bM495WLAWfzyKbpVehGKCyw7scK`(513c9f5)로 promote한다. **마이그레이션 없음**. 되돌리면 옛 코드에는 PATCH가 없어 사람 판정을 매기지 못하지만, 이미 매긴 판정(`results[].answer.human`·`summary.answers.agreement`·`summary.labelRevision`)은 기록에 그대로 남고 옛 화면은 그 칸을 읽지 않는다.
- 들어간 커밋: `6568fc4`(직전 배포 기록), `01f5409` 사람 판정(`PATCH /api/admin/rag-eval { id, line, grade }` — 답마다 맞음·일부·틀림, 요약에 AI 채점 일치율·후하게/짜게 본 답·3×3 표, `summary.labelRevision` 조건부 저장 — [일괄 평가](RAG_EVAL.md)), `b352682` 문서, `e1b258d` 빈 커밋.
- **배포 길에서 또 생긴 일**: 이번에는 가지 푸시(`b352682`)의 Preview(`workon-5cpl0yvgq`)는 Ready였는데, `main`을 같은 커밋으로 올린 푸시에 **Production 빌드가 생기지 않았다**(원격 `main` = b352682 확인, 9분 넘게 운영 배포 목록에 없음, GitHub 커밋 상태는 Preview의 것뿐). 빈 커밋 `e1b258d`를 가지에 푸시해 Preview(`workon-jylzivg5l`) Ready를 본 뒤 `main`에 다시 올리자 Production이 1분 만에 Ready. 오늘 두 번째 웹훅 누락이다(첫째는 오후 3 배포의 가지 푸시).
- **배포 전**: 시험 DB를 띄운 전체 시험에서 이 PC 메모리 부족으로 15개 파일이 빠져 하나씩 다시 돌렸고(마지막 한 파일은 사용자가 메모리를 비운 뒤), 합쳐 3,271개 통과·tsc 0.
- 배포 뒤 확인(로그인 없이, 운영 주소): `/`·`/login`·`/chat`·`/apps/run` 200, `/admin/documents` 307(로그인으로), `GET`·`PATCH /api/admin/rag-eval` 403, `GET /api/agents`·`POST /api/chat` 401. pg_cron 호출 200(15:39~15:41 KST).
- **확인하지 못한 것**(사용자 몫): 로그인해 'AI 채점도'를 고른 답변까지 평가를 한 번 돌리고, 답마다 사람 판정을 매겨 요약 줄의 일치율·후하게 본 답과 'AI 채점과 같음/다름', CSV의 '사람 판정' 칸 보기(실제 NODA·모델 — 브라우저로 보지 않음).

## 2026-11-09(오후 3): 더 찾기 — 조회 단계 안에서 AI가 빠진 부분을 다시 찾기

- 2026-11-09 14:33 KST 배포 `dpl_9bM495WLAWfzyKbpVehGKCyw7scK`(커밋 `513c9f5`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영"). 되돌릴 때는 직전 `dpl_BTH78Ue1SAqHdwRe7DnMxDDUzrdw`(7581b6a)로 promote한다. **마이그레이션 없음**. 되돌리면 옛 코드의 저장 검사는 `lookup.refine`을 모르는 칸으로 떨구고(정의를 다시 저장하면 더 찾기가 꺼진 채 저장됨) 실행기는 정해 둔 조회어로만 찾는다.
- 들어간 커밋: `2eeb81b`(직전 배포 기록), `edad2e7` 더 찾기(`lookup.refine` 1~2 — 조회 뒤 AI가 결과를 보고 빠진 부분의 새 조회어를 쓰면 다시 찾음, '없음'이면 멈춤, 한 번 5개·단계 전체 10개 — [조회 단계](APP_LOOKUP_STEPS.md)), `9759bf1` 문서, `513c9f5` 빈 커밋.
- **배포 길에서 생긴 일**: `9759bf1` 가지 푸시는 GitHub에 올라갔는데(원격 가지 끝 확인) Vercel이 빌드를 만들지 않았다 — 10분 넘게 배포 목록에 없고 GitHub 커밋 상태에도 Vercel이 없었다(웹훅이 오지 않음). 빈 커밋 `513c9f5`를 푸시해 다시 걸었더니 Preview(`workon-65zs9ndkh`)가 1분 만에 Ready — 그 뒤 `main`에 올렸다. 앞으로도 Preview가 몇 분째 목록에 없으면 GitHub 커밋 상태(`api.github.com/repos/…/commits/{sha}/status` — 공개 저장소)를 보고 빈 커밋으로 다시 건다.
- **배포 전**: 시험 DB를 띄운 전체 시험 220파일 3,263개 통과(파일별 시험 수가 지난번보다 준 곳 없음)·tsc 0.
- 배포 뒤 확인(로그인 없이, 운영 주소): `/`·`/login`·`/apps/builder`·`/apps/run`·`/chat` 200, `GET /api/agents`·`POST /api/chat`·`GET /api/v1/usage-summary` 401, `GET /api/admin/api-keys` 403. pg_cron 호출 200(14:31~14:34 KST).
- **확인하지 못한 것**(사용자 몫): 로그인해 문서 찾기 단계에 '더 찾기 2번'과 기준을 둔 앱을 저장·실행해 단계 결과의 '조회어 K개 · 더 찾기 N번'과 새 조회어로 찾은 근거, 사용량이 더 찾기만큼 늘었는지 보기(실제 NODA·모델 — 브라우저로 보지 않음).

## 2026-11-09(오후 2): 문서 찾기 단계 — 다른 비서의 문서함 찾기

- 2026-11-09 14:01 KST 배포 `dpl_BTH78Ue1SAqHdwRe7DnMxDDUzrdw`(커밋 `7581b6a`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영"). 되돌릴 때는 직전 `dpl_59xv3RRRBnwcW4PrqbT2j49Luniq`(d2bc946)로 promote한다. **마이그레이션 없음**. 되돌리면 옛 코드의 저장 검사는 `lookup.agent`를 모르는 칸으로 떨구고(정의를 다시 저장하면 이 앱 비서의 문서함을 찾는 단계로 저장됨) 실행기는 이 앱 비서의 문서함을 찾는다.
- 들어간 커밋: `0623c5f`(직전 배포 기록), `e24d522` 다른 비서의 문서함 찾기(`lookup.agent` — 실행 전에 대화를 만들기 전 `checkLookupAgents`로 실행하는 사람의 `canUseAgent`·그 비서의 `doc_search`를 다시 보고 하나라도 아니면 403, 실행기는 확인한 목록 밖의 비서로 찾지 않음 — [조회 단계](APP_LOOKUP_STEPS.md)), `7581b6a` 문서.
- **배포 전**: 가지 Preview(`7581b6a`, `workon-gjwanrmb7`) Ready를 확인한 뒤 `main`에 올렸다. 그 전에 시험 DB를 띄운 전체 시험 3,252개 중 3,250개 통과 — 실패 2개(조회 함수에 빈 넷째 인자가 넘어가 옛 시험의 호출 기대와 어긋남)는 `agent`가 있을 때만 넘기도록 고쳐 관련 7파일 125개 통과, 파일별 시험 수가 지난번보다 준 곳 없음·tsc 0.
- 배포 뒤 확인(로그인 없이, 운영 주소): `/`·`/login`·`/apps/builder`·`/chat` 200, `GET /api/agents`·`POST /api/chat`·`GET /api/v1/usage-summary` 401, `GET /api/admin/api-keys` 403. pg_cron 호출 200(14:00~14:02 KST).
- **확인하지 못한 것**(사용자 몫): 로그인해 문서 찾기 단계의 '찾을 문서함'에서 다른 비서(문서 찾기가 켜진 공식·부서 비서)를 고른 앱을 저장·실행해 그 비서 문서의 근거가 나오는지, 그 비서를 쓸 수 없는 직원이 실행하면 실행 전에 막히는지 보기(실제 NODA·모델 — 브라우저로 보지 않음).

## 2026-11-09(오후): 조사 계획 — 조회 단계의 줄마다 찾기

- 2026-11-09 13:21 KST 배포 `dpl_59xv3RRRBnwcW4PrqbT2j49Luniq`(커밋 `d2bc946`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영"). 되돌릴 때는 직전 `dpl_DzmiUtCj8vC1PTgv1utkjfTJY64c`(1af5de2)로 promote한다. **마이그레이션 없음**. 되돌리면 옛 코드의 저장 검사는 `lookup.each`를 모르는 칸으로 떨구고(정의를 다시 저장하면 줄마다 찾기가 꺼진 채 저장됨) 실행기는 첫 줄로 한 번만 찾는다.
- 들어간 커밋: `b25d3a8`(직전 배포 기록), `1d5a56f` 조사 계획(`lookup.each` — 앞 AI 단계 결과의 줄마다 최대 5번 찾고, 근거 없는 조회어를 `gapQueries`/`not_found_queries`로 따로 정보 공백 — [조회 단계](APP_LOOKUP_STEPS.md)), `d2bc946` 문서.
- **배포 전**: 가지 Preview(`d2bc946`, `workon-ict9bsape`) Ready를 확인한 뒤 `main`에 올렸다. 그 전에 시험 DB를 띄운 전체 시험에서 한 시험 프로세스가 이 PC 메모리 부족으로 시작하자마자 죽어 `work-currentize-shift.test.ts`(21개)만 빠졌고, 그 파일을 따로 돌려 통과 — 합쳐 218파일 3,242개 통과·tsc 0.
- 배포 뒤 확인(로그인 없이, 운영 주소): `/`·`/login`·`/apps/builder`·`/apps/run` 200, `POST /api/chat`·`PATCH /api/agents/[id]` 401. pg_cron 호출 200(13:20~13:22 KST).
- **확인하지 못한 것**(사용자 몫): 로그인해 AI 처리(조회어를 줄마다) → 문서 찾기 `{{@1}}` + '줄마다 찾기' 앱을 저장·실행해 '줄마다 K번'·근거 없는 조회어 표시와 결과의 정보 공백 문구 보기(실제 NODA·모델 — 브라우저로 보지 않음).

## 2026-11-09(낮 2): 보완 조사 — 조회어에 앞 AI 단계 결과

- 2026-11-09 12:36 KST 배포 `dpl_DzmiUtCj8vC1PTgv1utkjfTJY64c`(커밋 `1af5de2`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영"). 되돌릴 때는 직전 `dpl_2ErKz3L1fWK6tREPvB7sr5wGYRCK`(29c0232)로 promote한다. **마이그레이션 없음**. 되돌리면 옛 코드의 저장 검사가 조회어의 `{{@N}}`을 '현재 입력 항목만' 규칙으로 거절하니, 되돌리기 전에 그런 앱이 생겼는지 본다.
- 들어간 커밋: `0d27e72`(직전 배포 기록), `a084038` 보완 조사(조회어의 `{{@N}}` = 앞선 AI 단계 결과의 첫 줄, 앞의 AI 단계만, 한 번에 바꾸기, 빌더 '+ N단계 결과' — [조회 단계](APP_LOOKUP_STEPS.md)), `1af5de2` 문서.
- **배포 전**: 가지 Preview(`1af5de2`, `workon-7tex3f3f6`) Ready를 확인한 뒤 `main`에 올렸다(그 전에 시험 DB를 띄운 전체 시험 217파일 3,234개 통과·tsc 0).
- 배포 뒤 확인(로그인 없이, 운영 주소): `/`·`/login`·`/apps/builder`·`/apps/run` 200, `POST /api/chat`·`PATCH /api/agents/[id]` 401. pg_cron 호출 200(12:35~12:37 KST).
- **확인하지 못한 것**(사용자 몫): 로그인해 앱 빌더에서 문서 찾기 → AI 처리(다음 조회어를 첫 줄에) → 문서 찾기 `{{@N}}` 앱을 저장·실행해 두 번째 찾기의 조회어(단계 결과의 '문서 찾기: …')가 앞 단계 첫 줄로 들어가는지 보기(실제 NODA·모델 — 브라우저로 보지 않음).

## 2026-11-09(낮): 입력형 앱의 문서 찾기 조회 단계

- 2026-11-09 12:17 KST 배포 `dpl_2ErKz3L1fWK6tREPvB7sr5wGYRCK`(커밋 `29c0232`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영"). 되돌릴 때는 직전 `dpl_8xMkn7BckbeFnxieWYg38uLFbW8n`(4f62099)로 promote한다. **마이그레이션 없음** — 단계 정의는 기존 `agents.app_definition` jsonb, 기록은 `source_references.app_steps`. 다만 되돌리면 옛 코드의 저장 검사가 `doc_search` 조회 단계가 든 앱 정의를 모르는 도구로 거절하니, 되돌리기 전에 그런 앱이 생겼는지 본다.
- 들어간 커밋: `6b8cdb6`(직전 배포 기록), `fc55267` 문서 찾기 조회 단계(조회어로 그 앱 비서의 문서함·공통 기준을 대화와 같은 찾기로 한 번, 근거가 없으면 정보 공백으로 넘김, 출처는 문서 원본 링크, 이어 실행 기록 복원이 끝난 조회 단계를 조회 기록으로 남김 — [조회 단계](APP_LOOKUP_STEPS.md)), `29c0232` 문서.
- **배포 전**: 가지 Preview(`29c0232`, `workon-j1j9uqv26`) Ready를 확인한 뒤 `main`에 올렸다(그 전에 시험 DB를 띄운 전체 시험 216파일 3,226개 통과·tsc 0).
- 배포 뒤 확인(로그인 없이, 운영 주소): `/`·`/login`·`/apps/builder`·`/apps/run` 200, `POST /api/chat`·`PATCH /api/agents/[id]`·`GET /api/v1/adoption-report` 401. pg_cron 호출 200(12:16~12:19 KST).
- **확인하지 못한 것**(사용자 몫): 로그인해 앱 빌더에서 문서 찾기 단계를 넣어 저장하고(문서 찾기 능력이 켜지는지), 문서를 올린 앱으로 실행해 '문서 찾기: … — 문서 N개'·찾은 근거·원본 링크, 근거 없는 조회어의 '정보 공백' 표시와 결과의 '확인 필요' 문구를 보기(실제 NODA·모델 — 브라우저로 보지 않음, 개발 서버가 운영 DB를 씀).

## 2026-11-09(오전 3): 기관 통계 읽기 API — 범위 제한 키(0075)

- 2026-11-09 11:09 KST 배포 `dpl_8xMkn7BckbeFnxieWYg38uLFbW8n`(커밋 `4f62099`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영"). 되돌릴 때는 직전 `dpl_4SbeNkzGpWV2Mb668tosMBgpgvmo`(7f831ba)로 promote한다(0075 표는 옛 코드가 읽지 않는다 — 되돌리면 키 화면과 `/api/v1/*`만 없어진다).
- **마이그레이션 0075 운영 적용**(코드 전, `npm run db:migrate -- 0075`): `org_api_keys`·`org_api_key_calls` 두 표 RLS 켜짐·정책 0개, CHECK 7개·2개, `org_api_key_claim(text, timestamptz, integer)` 실행 권한 service_role만(anon·authenticated 없음), 행 0개를 읽기 전용으로 확인.
- 들어간 커밋: `cc5307e`(직전 배포 기록), `18370d7` 기관 통계 읽기 API(기관 전체 관리자가 범위·유효 기간을 정한 키를 '기관 정보' 화면에서 만들고 회수, `GET /api/v1/adoption-report`·`/api/v1/adoption-report/departments`·`/api/v1/usage-summary` — 숫자만, 직원별 400 — [기관 통계 API](ORG_API.md)), `4f62099` 문서.
- **배포 전**: 가지 Preview(`4f62099`, `workon-58rusvcb6`) Ready를 확인한 뒤 `main`에 올렸다(그 전에 시험 DB를 띄운 전체 시험 215파일 3,207개 통과·tsc 0, 0075는 시험 DB에 두 번 적용).
- 배포 뒤 확인(로그인 없이, 운영 주소): `/`·`/login` 200, `/admin/organization` 307(로그인으로), `/api/v1/*` 셋 모두 키 없이 401·**없는 키로 401**(운영 DB의 차지 함수가 답함 — 함수가 없으면 500), `GET`·`POST /api/admin/api-keys` 403. pg_cron 호출 200(11:09~11:11 KST).
- **확인하지 못한 것**(사용자 몫): 기관 전체 관리자로 로그인해 '기관 정보' 화면에서 키를 만들고, 그 키로 `/api/v1/adoption-report`를 불러 숫자를 받고, 회수 뒤 401이 되는지(브라우저로 보지 않음 — 개발 서버가 운영 DB를 씀). 기관 접속 허용 IP를 정한 기관이면 부르는 시스템의 주소가 그 안이어야 한다.

## 2026-11-09(오전 2): 문서 찾기 평가의 AI 채점(선택·참고)

- 2026-11-09 10:46 KST 배포 `dpl_4SbeNkzGpWV2Mb668tosMBgpgvmo`(커밋 `7f831ba`, `main` fast-forward — GitHub 연동). 사용자 선택("운영반영"). 되돌릴 때는 직전 `dpl_2BooX7TA3UQytXToAKUnrdmwS7QC`(cb225fe)로 promote한다. **마이그레이션 없음** — 채점은 기존 `rag_eval_runs` jsonb 안 `answer.judge`·`summary.answers.judge` 칸이라 옛 코드는 읽지 않는다.
- 들어간 커밋: `cbb8242`(직전 배포 기록), `9f979e7` 답변까지 평가의 AI 채점(`judge: true` — 기대 문서가 있는 질문의 답마다 같은 모델로 근거와 맞대 맞음·일부·틀림·근거 밖 내용·이유, 프로그램 판정은 그대로, 사용 기록 `rag_eval_judge` — [일괄 평가](RAG_EVAL.md)), `7f831ba` 문서.
- **배포 전**: 가지 Preview(`7f831ba`, `workon-3wmq90a94`) Ready를 확인한 뒤 `main`에 올렸다(그 전에 시험 DB를 띄운 전체 시험 213파일 3,183개 통과·tsc 0).
- 배포 뒤 확인(로그인 없이, 운영 주소): `/`·`/login` 200, `/admin/documents` 307(로그인으로), `GET`·`POST /api/admin/rag-eval` 403(관리자만), `POST /api/chat` 401. pg_cron 호출 200(10:45~10:47 KST), 앱 예약 실행기 heartbeat 10:45 KST.
- **확인하지 못한 것**(사용자 몫): 로그인한 관리자가 '답변까지 평가' + 'AI 채점도(참고)'를 실제 모델로 돌려 보기(모델 호출·비용 — 질문당 AI 두 번), 채점 이유가 사람이 보기에 맞는지(채점자 정확도는 재지 않음).

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
