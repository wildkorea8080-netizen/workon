# 기관 SSO — OpenID Connect (2026-11-25, 0107)

기관이 이미 쓰는 계정 서비스(Microsoft Entra ID·Google Workspace·Keycloak·사내 SSO 등 **OpenID Connect**를 지원하는 것)로 로그인한다. 알리웍스의 'SSO 조직 연결'에 해당한다. SAML은 이번에 넣지 않았다.

## 쓰는 법

1. 기관 전체 관리자가 계정 서비스에 앱(클라이언트)을 만든다 — 돌아올 주소(Redirect URI) `https://{서비스 주소}/api/sso/callback`, 권한 `openid email profile`, 인증 방식 클라이언트 비밀값.
2. 관리자 포털 '기관 정보' 아래 **'기관 계정 로그인(SSO)'**(`OrgSsoPanel` → `GET`·`PUT /api/admin/sso`)에 발급자(issuer) 주소·클라이언트 ID·비밀값·허용 이메일 도메인(선택)·단추 글(선택)을 적고 켠다. 켤 때 발급자 주소의 발견 문서를 실제로 읽어 보고 못 읽으면 저장하지 않는다. 기관 로그인 경로(slug)가 있어야 켜진다.
3. 직원은 기관 전용 로그인 `/signin/{slug}`의 **'기관 계정으로 로그인'**을 누른다. 비밀번호 로그인도 그대로 된다 — 아래 'SSO 전용'을 켜면 직원은 기관 계정으로만.

## 흐름 (`src/lib/org-sso.ts`)

- `GET /api/sso/{slug}/start` — 켜진 기관·정지/종료 아님을 보고 발견 문서(`{issuer}/.well-known/openid-configuration`, issuer가 설정과 같아야)를 읽어 인가 주소로 보낸다. state·nonce·PKCE verifier는 **서명한 10분 쿠키**(`wo_sso_state`, HMAC — NEXTAUTH_SECRET, `/api/sso`에만)에.
- `GET /api/sso/callback` — 쿠키 서명·기한·state(같은 시간 비교) → 토큰 교환(인가 코드 + `code_verifier` + `client_secret_post`) → **id_token 검증**: RS256·ES256만, `jwks_uri`의 공개키(kid), `iss`(다듬어 같음)·`aud`(클라이언트 ID 포함, 여럿이면 `azp`)·`exp`(2분 여유)·`iat`·`nonce`. 상태 쿠키는 한 번 쓰면 지운다.
- 이메일: `email`(`email_verified`가 false면 안 씀) → `preferred_username`·`upn`이 이메일 꼴일 때. 허용 도메인을 정했으면 그 도메인만.
- **계정을 만들지 않는다** — 그 이메일(대소문자 무시, 하나만)로 등록된 직원이 **이 기관 부서**에 속할 때만. 슈퍼관리자 계정·다른 기관 사람·사용 중지/탈퇴(`canSignIn`)·장기 미접속 잠금(0095)은 막는다. 성공·거절은 접속 기록(`access_logs`, 브라우저 칸에 `SSO ·`).
- 세션은 대리 접근과 같은 NextAuth JWT(`encode`)로 30일, 토큰에 `sso: true`. 미들웨어의 계정 확인(비활성·권한/소속 변경·비밀번호 바꾼 뒤 끊기)은 그대로 걸리고, **임시 비밀번호 바꾸기 강제만은 SSO 로그인에 걸지 않는다**(비밀번호를 모른다).
- 계정 서비스 주소는 https만, 부를 때마다 이름을 다시 풀어 내부망·특수 IP면 부르지 않는다, 리다이렉트를 따르지 않는다, 8초.
- 실패는 로그인 화면으로 `?error=sso_…`(사용 불가·거절·시간 지남·연결된 계정 없음·도메인 밖·사용 중지·장기 미접속)와 안내 글(`org-sso-spec.ts`). 운영 기록에는 단계·까닭 코드만(코드·토큰·이메일 없음).

## SSO 전용 — 직원 비밀번호 로그인 끄기 (2026-11-25, 0109)

같은 칸 아래 **'직원은 기관 계정으로만 로그인'**(`org_sso_providers.sso_only`, 요청 `ssoOnly`)을 고르면:

- 직원(USER)의 이메일·비밀번호 로그인을 막는다 — 로그인 두 길(`nextAuthOptions.ts`의 Supabase Auth·저장해 둔 비밀번호)이 **비밀번호가 맞은 뒤** `passwordLoginBlocked`(`src/lib/sso-only.ts`)로 보고 `SSO_ONLY`를 던진다(접속 기록 `login_rejected`, 로그인 화면 `SSO_ONLY_MESSAGE`). 틀린 비밀번호는 지금처럼 '올바르지 않습니다'·실패로 센다.
- 비밀번호로 들어와 있던 직원 로그인은 미들웨어가 끝낸다(`userSessionVerdict`의 `sso_only` — 부서 → 기관 → 설정을 `readDeptSsoOnly`로 읽어 부서마다 30초 기억, 로그인 화면 `?error=sso_only`). SSO로 들어온 토큰(`sso: true`)·관리자·대리 접근은 그대로.
- **기관 관리자(ADMIN)는 비밀번호 로그인을 그대로 쓴다** — 계정 서비스가 고장 나거나 설정이 틀려도 설정을 고칠 사람이 들어올 수 있게. 화면도 '먼저 관리자 한 명이 기관 계정으로 들어와 보고 켜라'고 안내한다.
- 켜진 SSO에만 걸 수 있다(입력 검사 400·DB CHECK `NOT sso_only OR enabled`). SSO를 끄면 SSO 전용도 함께 꺼진다. 바뀌면 보안 로그 `org_sso_changed`(high)의 바뀐 칸에 `sso_only`.
- 기관 전용 로그인 화면은 SSO 전용이면 기관 계정 단추를 맨 위에 두고 비밀번호 칸은 '관리자 로그인' 아래로(`ssoLoginForSlug`).
- 설정·DB를 **못 읽으면 막지 않는다**(열림 — 장기 미접속 잠금과 같다, 로그인 쪽은 운영 기록 warning). 미들웨어는 10분 안의 마지막 값을 쓰고 그것도 없으면 끝내지 않는다.
- 비밀번호 찾기 메일은 막지 않는다 — 재설정해도 직원은 비밀번호로 로그인하지 못한다. 시험: `tests/batch-0289.test.ts`.

## 지키는 것

- 클라이언트 비밀값은 AES(crypto.ts)로만 저장, 화면에는 '저장돼 있음'만. 비우고 저장하면 그대로 둔다. 운영에서 암호화 키가 없으면 503.
- 설정 바꾸기는 기관 전체 관리자만·대리 접근 중 403, 보안 로그 `org_sso_changed`(high — 바뀐 칸 이름·켜짐·발급자만).
- 마이그레이션 **0107** `org_sso_providers`(기관마다 하나 — 발급자 https·클라이언트 ID·암호화한 비밀값·허용 도메인 10개·켜짐·단추 글, 켜면 비밀값 필수 CHECK). RLS 켜고 정책 없음·공개 키 권한 없음. **코드 배포 전에 적용** — 없으면 SSO 설정·단추만 없다(비밀번호 로그인은 그대로).

## 남은 것

- **실제 계정 서비스로 로그인해 보지 않았다** — 시험은 실제 RSA·EC 키로 서명한 id_token과 가짜 계정 서비스로 했다. 운영에서 Entra ID나 Keycloak 시험 테넌트로 한 번 확인해야 한다.
- SAML, 계정 서비스 쪽 로그아웃(단일 로그아웃), `client_secret_basic`·`private_key_jwt`, PS256 등 다른 서명 알고리즘, 그룹 → 부서·역할 매핑은 없다. 관리자까지 비밀번호를 끄는 완전한 SSO 전용도 없다(위 — 관리자는 남긴다).
- 공용 `/login`에는 단추가 없다 — 기관 전용 경로에서만.

시험: `tests/batch-0286.test.ts`.
