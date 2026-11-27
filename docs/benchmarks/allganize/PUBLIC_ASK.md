# 시민용 민원 상담 창 (0136, 2026-11-27)

시민이 로그인 없이 `/ask/{기관 로그인 경로}`에서 기관에 묻고, **기관이 시민에게 공개해도 된다고 정한 문서만** 근거로 답을 받는다. 기관 홈페이지에는 스크립트 한 줄로 오른쪽 아래 'AI 상담' 단추를 붙인다. 설계 `docs/superpowers/specs/2026-11-27-public-ask-design.md`, 계획 `docs/superpowers/plans/2026-11-27-public-ask.md`.

## 무엇이 어디에
| 부분 | 파일 |
|---|---|
| 마이그레이션 | `supabase/migrations/0136_public_ask.sql` — `agents.tier`에 `public`(기관에 하나), `public_ask_settings`·`public_ask_logs`, `public_ask_claim`(기관마다 잠그고 하루 횟수를 세고 넣음), `department_spend_krw`에서 `public_ask` 뺌, `organization_chat_tokens`에 `public_ask` 더함 |
| 규칙(잎) | `src/lib/public-ask/spec.ts` — 상한·설정 검사·안내 글·`frameAncestors`·붙일 코드 |
| 엔진 | `src/lib/public-ask/service.ts`(+ `deps.ts`) — 설정·비서 → 기관 예산 → 하루 횟수 → 개인정보·금지어 → 찾기(`prepareLikeChat`) → 모델 → 숫자 확인 → 기록·사용 기록 |
| 공개 API | `GET/POST /api/ask/[slug]` — 로그인 없음(`route-auth.test.ts` 공개 목록) |
| 시민 화면 | `/ask/[slug]`(`PublicAskChat`), 붙이기 `/ask/embed.js?org=` |
| 관리자 | `/admin/public-ask`(`PublicAskPanel`) ← `/api/admin/public-ask`·`/agent`·`/logs` — 기관 전체 관리자만 |
| 30일 정리 | 5분 실행기 `purgePublicAskLogs` |

## 지키는 것
- **시민 전용 비서**: 직원 비서 목록·대화(`canUseAgent` false)·앱 목록·기관 API에 나오지 않고, 고치기·문서 올리기는 기관 전체 관리자만(`canEditAgent`). 그래서 직원이 내부 문서를 넣어 시민에게 새어 나갈 길이 없다.
- **확인 못 하면 닫힘**: 설정·비서·기관 예산·하루 횟수·금지어를 못 읽으면 묻지 않고 503(직원 길의 '못 읽으면 허용'과 반대).
- **비용**: 같은 IP 하루 20번(1~100)·기관 하루 500번(1~5,000) — 넘으면 모델을 부르지 않음. 기관 예산(연간 정액·월 토큰)에는 들어가고 **부서 월 한도에는 안 들어감**.
- **개인정보**: 직원 대화와 같은 필터(주민·카드·휴대전화·기관 금지어). 거절·마감한 시도는 질문 글 없이 기록. IP는 해시만. 기록 30일.
- **붙이기**: `vercel.json`의 `X-Frame-Options: DENY`는 `/ask` 밖에만, `/ask/{slug}`는 미들웨어가 그 기관의 허용 홈페이지만 `frame-ancestors`로(비우면 자기 주소만).
- **법령 조회 없음**: 운영 법령 API가 막혀 있어 기관 문서(+ 공통 자료실)로만 답한다.

## 하지 않는 것
민원 접수(번호·처리 상태), 담당자 연결 채팅, 카카오톡, 첨부·사진, 시민 로그인.

## 운영 반영 순서
0136을 코드보다 먼저 적용 → 배포 → 관리자 '시민 상담'에서 시민 전용 비서 만들기·문서 올리기·연락처·켜기 → `/ask/{slug}`에서 질문.
