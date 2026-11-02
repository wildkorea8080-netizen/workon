# 운영 배포: 업무 앱 중심 첫 화면

## 최신: 조건 확장·예산 알림·관리자 앱 실행 현황·현행화 N1·N2

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
