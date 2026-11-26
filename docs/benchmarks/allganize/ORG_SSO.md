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

## 계정 서비스 그룹 → 부서 맞추기 (2026-11-25, 0110)

같은 칸 아래 **'계정 서비스 그룹 → 부서 맞추기'**에 부서를 정할 클레임 이름(`org_sso_providers.group_claim`, 예 `groups`·`department`·`realm_access.roles`)과 '그룹 값 → WORKON 부서' 목록(`group_mappings`, 100줄까지)을 적으면:

- 기관 계정으로 로그인할 때 id_token의 그 클레임 값(글·숫자·그 배열 — 이름 그대로 먼저, 없고 점이 있으면 점으로 내려감, `claimValues`) 중 **목록을 위에서부터 보아 처음 맞는 부서**(`groupDepartment` — 대소문자·앞뒤 공백·보이지 않는 글자는 가리지 않음)로 **일반 직원(USER)**의 소속을 옮긴다. 인사 이동을 계정 서비스에서만 고치면 된다.
- 옮기기(`syncDepartment`)는 부서가 이 기관 것인지 다시 보고, 지금 부서가 확인한 부서이고 일반 직원·탈퇴 안 함일 때만 조건부로 바꾼다. 옮기면 보안 로그 `user_department_synced`(medium — 대상·전후 부서 이름·맞은 그룹 값, 감사 화면 '직원 부서 맞추기(기관 SSO 그룹)'). 세션은 새 부서로 만들고, 같은 사람의 다른 옛 로그인은 미들웨어가 '소속이 바뀜'으로 끝낸다.
- **관리자(ADMIN)의 소속은 옮기지 않는다** — 소속이 관리 범위를 정하므로 계정 서비스 설정 하나로 관리 범위가 바뀌지 않게. **역할은 이 목록으로 바꾸지 않고**(관리자 역할은 아래 0115) 계정도 만들지 않는다.
- 맞는 값이 없거나, 부서를 못 읽거나 옮기지 못하면 **소속 그대로 들어온다**(로그인은 막지 않음 — 못 한 것은 운영 기록 warning `group_sync`).
- 저장 검사(`parseGroupMapping`): 클레임은 영문·숫자·`_ . : / -` 100자, 목록이 있으면 클레임이 있어야 함, 값 200자·겹치지 않게, 부서는 이 기관 부서만(라우트가 DB로 맞댐 — 아니면 400, 못 읽으면 503). 설정 화면은 이 기관의 부서 목록에서 고른다(`GET /api/admin/sso`의 `departments`). 바뀌면 `org_sso_changed`의 바뀐 칸에 `group_claim`·`group_mappings`.
- 계정 서비스가 그 클레임을 id_token에 넣도록 설정해야 한다(Entra ID는 '그룹 클레임' — 그룹 ID(GUID)로 오는 것이 기본이라 목록에도 ID를 적는다, Keycloak은 그룹 매퍼). 비밀번호로 로그인한 직원의 소속은 바꾸지 않는다. 시험: `tests/batch-0290.test.ts`.

## 계정 서비스 그룹 → 관리자 (2026-11-25, 0115)

기관 전체 관리자가 SSO 설정의 '계정 서비스 그룹 → 관리자'에 그룹 값(줄마다 하나, 20개 — `SSO_MAX_ADMIN_GROUPS`)을 적으면, 기관 계정으로 로그인할 때 **그룹 → 부서와 같은 클레임**(`group_claim`)에 그 값이 든 **일반 직원**을 그 소속 부서의 관리자(ADMIN)로 올린다(`adminGroupMatch` — 대소문자·앞뒤 공백 무시, `SsoIo.syncRole`).

- **이 길로 올린 관리자만 표시한다**(`users.role_from_sso`). 그 사람이 그룹에서 빠진 채 기관 계정으로 다시 로그인하면 일반 직원으로 내린다. **내려야 하는데 못 내리면(쓰기 실패·그 사이 바뀜) 로그인을 막는다**(`sso_unavailable` — 관리자 권한을 거둘 사람을 관리자로 들이지 않게). 올리지 못하면 일반 직원으로 들인다(운영 기록 warning `role_sync`).
- **손으로 지정한 관리자는 건드리지 않는다**(표시가 거짓). 기관 관리자·슈퍼관리자가 손으로 권한을 바꾸면 표시를 지운다 — 그 뒤로는 그룹이 그 사람을 올리거나 내리지 않는다(다시 맡기려면 일반 직원으로 바꾼 뒤 그룹으로 로그인).
- 순서: 내리기 → 그룹 → 부서 맞추기(일반 직원이 된 뒤) → 올리기(옮긴 부서에서). 올리기·내리기 모두 조건부 update(올리기는 `role='USER'`, 내리기는 `role='ADMIN' AND role_from_sso`, 지금 부서·탈퇴 안 함·사용 중·슈퍼관리자 아님) — 보안 로그 `user_role_synced`(high, 전후 역할·맞은 그룹).
- **목록을 비우면 아무도 올리거나 내리지 않는다**(이미 올린 관리자는 그대로 — 사람이 정리한다). 소속(관리 범위)은 이 목록으로 바꾸지 않는다 — 최상위 부서 소속 직원을 올리면 기관 전체 관리자가 된다(설정 화면이 빨간 글로 알림: 계정 서비스의 그 그룹을 고칠 수 있는 사람이 곧 WORKON 관리자를 정한다).
- 마이그레이션 **0115**: `org_sso_providers.admin_groups text[]`(20개·있으면 클레임 필요 CHECK) + `users.role_from_sso boolean NOT NULL DEFAULT false`. 추가만, 여러 번 적용해도 안전, **0114 뒤·코드 배포 전에 반드시 적용** — SSO 설정 select·직원 찾기 select에 두 칸이 들어가, 없으면 기관 계정 로그인·SSO 설정 화면이 실패한다. 시험: `tests/batch-0297.test.ts`.

## 함께 로그아웃 (2026-11-25, 0111)

같은 칸의 **'로그아웃할 때 계정 서비스에서도 로그아웃'**(`org_sso_providers.single_logout`, 요청 `singleLogout`)을 켜면, 기관 계정으로 들어온 직원이 WORKON에서 로그아웃할 때 계정 서비스의 로그인도 끝낸다(OIDC RP-Initiated Logout). 공용 PC에서 다음 사람이 기관 계정 단추로 앞사람 계정에 그대로 들어가지 않게 하려는 것이다.

- 로그아웃 단추(사용자 메뉴·대화 첫 화면·옛 머리 막대)는 `signOutEverywhere`(`src/lib/sso-logout-client.ts`)를 거친다 — SSO 로그인(세션 `user.sso` — 토큰의 `sso: true`)이면 먼저 `POST /api/sso/logout`으로 주소를 받고, NextAuth 로그아웃을 마친 뒤 그 주소(https만)로 간다. 주소가 없거나 못 받으면 평소처럼 WORKON만 로그아웃한다.
- 주소(`ssoLogoutUrl`)는 기관이 켰고 발견 문서에 `end_session_endpoint`(https)가 있을 때만 — `client_id`와 `post_logout_redirect_uri` = 그 기관 로그인 화면(`/signin/{slug}`)을 단다. **id_token은 저장하지 않으므로 `id_token_hint`는 싣지 않는다**(계정 서비스에 따라 '로그아웃할까요?'를 한 번 묻는다). 대리 접근·비밀번호 로그인은 null. 못 읽으면 null + 운영 기록 warning(`logout`).
- 켜진 SSO에만(입력 검사·DB CHECK `NOT single_logout OR enabled`), 켤 때 발견 문서에 로그아웃 주소가 없으면 저장하지 않는다(400 — Google은 없다). SSO를 끄면 함께 꺼진다. 바뀌면 `org_sso_changed`의 바뀐 칸에 `single_logout`.
- 기본은 꺼짐 — **Microsoft Entra ID는 그 브라우저의 Microsoft 365 로그인까지 끝낸다.** 계정 서비스 앱에 로그아웃 뒤 돌아올 주소(설정 화면에 보임)를 등록해야 한다.
- 계정 서비스가 먼저 로그아웃할 때 WORKON 로그인을 끝내는 길은 아래 back-channel 로그아웃(0114). front-channel 로그아웃은 없다. 시험: `tests/batch-0291.test.ts`.

## 계정 서비스가 먼저 로그아웃할 때 — back-channel 로그아웃 (2026-11-25, 0114)

직원이 계정 서비스에서 로그아웃하거나 그쪽 관리자가 세션을 끊으면, 계정 서비스가 서버끼리 `POST /api/sso/backchannel-logout`(폼 `logout_token` — OIDC Back-Channel Logout 1.0)을 보낸다. WORKON은 그 직원의 **기관 계정 로그아웃 시각**(`users.sso_logout_at`)을 적고, 미들웨어(`userSessionVerdict` — 계정 상태 30초 기억)가 그때나 그 전에 **기관 계정으로** 들어온 WORKON 로그인을 끝낸다(`sso_logged_out` — API 401, 화면은 `/login?error=sso_logged_out` 안내).

- 설정 칸은 없다 — 계정 서비스 앱의 Back-Channel Logout 주소에 설정 화면에 보이는 주소를 등록하면 된다(지원하는 계정 서비스만 보낸다 — Keycloak 등).
- **logout_token에는 이메일이 없고 사용자 번호(sub)만 온다.** 그래서 기관 계정으로 로그인할 때 기관·발급자·sub → 직원을 `org_sso_subjects`에 적어 둔다(`rememberSubject` — 못 적으면 운영 기록 warning `subject`, 로그인은 그대로). 이 기능이 생긴 뒤 기관 계정으로 한 번 이상 로그인한 직원부터 받는다.
- 검증(`verifyLogoutToken`): 서명은 id_token과 같은 규칙(RS256·ES256, jwks 공개키), `iss`·`aud`(그 기관 설정의 발급자·클라이언트 ID), `iat`(앞서지 않고 10분 안 — `LOGOUT_TOKEN_MAX_AGE_S`), `exp`(있으면), `events`에 back-channel 로그아웃 이벤트, `nonce` 없음(id_token을 돌려쓰지 못하게), `sub`·`sid` 중 하나 이상(있는데 꼴이 틀리면 거절 — 1~255자 글만). `sub`가 오면 `sub`로, `sid`만 오면 아래 0118의 세션 번호 표로 직원을 찾는다. `sid`가 온 토큰은 그 세션 하나만 끝낸다(아래 0121).
- 서명을 보기 전에는 `iss`·`aud`로 설정만 고른다(Google처럼 발급자가 같은 기관이 여럿이어도 클라이언트 ID로 가린다 — 그 값으로 아무것도 바꾸지 않음). 모르는 발급자·클라이언트는 공개키를 받으러 가지 않는다. SSO를 꺼 둔 설정도 받는다(끝내는 쪽이라).
- 로그아웃 시각은 토큰의 `iat`(지금보다 늦지 않게)이고 **지금 값보다 늦을 때만** 적는다 — 다시 온 옛 토큰이 그 뒤의 새 로그인을 끝내지 않는다(`jti`는 따로 거르지 않는다). 적으면 보안 로그 `sso_backchannel_logout`(low).
- 응답: 맞으면 200, 틀린 토큰 400, 설정·공개키·직원을 못 읽거나 못 적으면 503(계정 서비스가 다시 보낸다). 점검 모드에도 받는다(미들웨어 예외). 비밀번호 로그인·대리 접근은 끝내지 않는다.
- 마이그레이션 **0114**: `users.sso_logout_at` + `org_sso_subjects`(기관·발급자·sub 기본 키, 직원 외래 키, RLS 켜고 정책 없음·공개 키 권한 없음). 추가만, 여러 번 적용해도 안전. **코드 배포 전에 반드시 적용** — 새 미들웨어가 모든 직원 요청에서 `sso_logout_at`을 select 해, 없으면 계정 상태를 못 읽어 열림으로 돈다(비활성·탈퇴 끊기까지 빠짐). 시험: `tests/batch-0295.test.ts`.

## 세션 번호(sid)만 오는 로그아웃 (2026-11-25, 0118)

OIDC Back-Channel Logout은 `sub`와 `sid` 중 하나만 보내도 된다 — `sid`만 보내는 계정 서비스의 로그아웃은 그동안 400으로 거절했다.

- **로그인 때 적어 둔다**: id_token에 `sid`(1~255자 글)가 있으면 기관·발급자·`sid` → 직원을 `org_sso_sessions`에 적는다(`SsoIo.rememberSession` — 같은 `sid`면 덮어씀). 못 적어도 로그인은 그대로(운영 기록 `session`). 적을 때 그 직원의 31일(`SSO_SESSION_ROW_TTL_MS` — WORKON 기관 계정 로그인 30일 + 하루) 넘은 줄을 치운다.
- **로그아웃 받기**: `sub`가 없고 `sid`만 온 토큰이면 `SsoBackchannelIo.sessionUsers`로 그 기관·발급자·`sid`의 직원을 찾아 `sub`가 왔을 때와 똑같이 로그아웃 시각을 적는다 — **그 세션 하나가 아니라 그 직원의 그 전 기관 계정 로그인을 모두 끝낸다**(WORKON 로그인에 `sid`를 싣지 않아 하나만 가려 끝낼 수 없다 — 더 넓게 끝내는 쪽). `sub`가 함께 오면 예전처럼 `sub`로. 적어 둔 `sid`가 없으면 200·아무도 끝내지 않음(0118 전 로그인), 읽기 실패는 503(계정 서비스가 다시 보냄).
- (2026-11-26, 0121로 바뀜) 아래 '세션 하나만 끝내기' — `sid`가 온 토큰은 이제 그 세션 하나만 끝낸다. 위 '모두 끝낸다'는 `sid`를 싣지 않은 로그인에만 남는다.
- 마이그레이션 **0118**: `org_sso_sessions`(기관·발급자·`sid` 기본 키, 직원을 지우면 함께, RLS 켜고 정책 없음·공개 키 권한 없음). 추가만, 여러 번 적용해도 안전, **코드 배포 전에 적용** — 없으면 로그인 때 `sid`를 못 적고(운영 기록에 남고 로그인은 그대로) `sid`만 온 로그아웃이 503. 시험: `tests/batch-0301.test.ts`.
- **실제 계정 서비스로는 해 보지 않았다.**

## 세션 하나만 끝내기 (2026-11-26, 0121)

OIDC Back-Channel Logout 규칙대로 `sid`가 온 로그아웃은 **그 세션 하나만** 끝낸다 — 0118까지는 WORKON 로그인에 `sid`를 싣지 않아 그 직원의 기관 계정 로그인을 모두 끝냈다(같은 직원이 다른 PC·브라우저에서 들어와 있던 것까지).

- **로그인에 싣는다**: id_token에 `sid`(1~255자 글)가 있으면 WORKON 로그인 토큰에 `ssoSid`로 싣는다(`SsoIo.mintSession`의 `sid` — 세션을 다시 써도 jwt 콜백이 토큰을 그대로 돌려줘 남는다). 0118처럼 `sid` → 직원도 적는다.
- **로그아웃 받기**: `sid`가 온 토큰(`sub`가 함께 와도)이면 찾은 직원 행의 '끝낸 세션' 목록 `users.sso_ended_sessions`에 `{로그아웃 초}:{sid}` 하나를 더하고 `users.sso_sid_logout_at`(sid로 받은 로그아웃의 가장 늦은 때)을 늦춘다 — DB 함수 `sso_end_session` 한 번(행 하나를 한 문장으로 — 거의 동시에 온 두 로그아웃이 서로를 덮지 않게, 최근 20개만, 같은 항목이면 안 바꿈·끝낸 수에 안 듦, 탈퇴 직원은 안 바꿈). `SsoBackchannelIo.endSession`, 보안 로그 `sso_backchannel_logout`(low, `scope: 'session'` — `sid`는 남기지 않음). `sub`만 온 토큰은 예전처럼 `sso_logout_at`으로 모두 끝낸다.
- **미들웨어**: 이미 읽는 직원 행에서 두 칸을 함께 읽어(요청마다 DB를 더 읽지 않음, 30초 기억) — 토큰에 `ssoSid`가 있으면 그 `sid`로 끝낸 항목이 있고 로그인이 그때나 그 전일 때만 끝낸다(`sessionEndedBySid` — 계정 서비스가 같은 번호를 되써도 로그아웃 뒤의 로그인은 그대로). `ssoSid`가 없는 기관 계정 로그인(**이 배포 전 로그인**·id_token에 `sid`가 없던 로그인)은 어느 세션인지 몰라 예전처럼 `sso_sid_logout_at` 전 로그인을 끝낸다. 비밀번호 로그인·대리 접근은 그대로.
- 마이그레이션 **0121**: `users.sso_ended_sessions text[]`(기본 빈 목록, 20개 CHECK)·`users.sso_sid_logout_at`·함수 `sso_end_session(uuid, text, timestamptz)`(실행 권한 service_role만). 추가만, 여러 번 적용해도 안전, **코드 배포 전에 반드시 적용** — 새 미들웨어가 모든 직원 요청에서 두 칸을 select 해, 없으면 계정 상태를 못 읽어 열림으로 돈다. 시험: `tests/batch-0307.test.ts`.
- **실제 계정 서비스로는 해 보지 않았다.**

## 지키는 것

- 클라이언트 비밀값은 AES(crypto.ts)로만 저장, 화면에는 '저장돼 있음'만. 비우고 저장하면 그대로 둔다. 운영에서 암호화 키가 없으면 503.
- 설정 바꾸기는 기관 전체 관리자만·대리 접근 중 403, 보안 로그 `org_sso_changed`(high — 바뀐 칸 이름·켜짐·발급자만).
- 마이그레이션 **0107** `org_sso_providers`(기관마다 하나 — 발급자 https·클라이언트 ID·암호화한 비밀값·허용 도메인 10개·켜짐·단추 글, 켜면 비밀값 필수 CHECK). RLS 켜고 정책 없음·공개 키 권한 없음. **코드 배포 전에 적용** — 없으면 SSO 설정·단추만 없다(비밀번호 로그인은 그대로).

## 남은 것

- **실제 계정 서비스로 로그인해 보지 않았다** — 시험은 실제 RSA·EC 키로 서명한 id_token과 가짜 계정 서비스로 했다. 운영에서 Entra ID나 Keycloak 시험 테넌트로 한 번 확인해야 한다.
- SAML, front-channel 로그아웃, `client_secret_basic`·`private_key_jwt`, PS256 등 다른 서명 알고리즘, 관리자 소속 맞추기·관리자 말고 다른 역할(예: 감사 전용)은 없다(그룹 → 부서는 위 0110 — 일반 직원만, 그룹 → 관리자는 위 0115 — 올리고 내리기만). 관리자까지 비밀번호를 끄는 완전한 SSO 전용도 없다(위 — 관리자는 남긴다).
- 공용 `/login`에는 단추가 없다 — 기관 전용 경로에서만.

시험: `tests/batch-0286.test.ts`.
