# WORKON AI — 공공기관 전용 AI 비서 플랫폼

> Next.js 14 · Supabase · Claude API · Voyage AI · Vercel

---

## 슈퍼관리자 포털

### 접속 URL
```
https://workon-ai.vercel.app/super/login
```

### 최초 계정 생성 (1회만)

```bash
curl -X POST https://workon-ai.vercel.app/api/super/auth/setup \
  -H "Content-Type: application/json" \
  -d '{
    "email":    "admin@workon.ai",
    "password": "안전한비밀번호8자이상",
    "name":     "슈퍼관리자",
    "setupKey": "YOUR_SUPER_ADMIN_SETUP_KEY"
  }'
```

이미 계정이 있으면 `/super/login` 에서 바로 로그인하세요.

### 주요 기능

| 경로 | 기능 |
|---|---|
| `/super` | 대시보드 (전체 현황, 차트, 알림) |
| `/super/organizations` | 기관 CRUD, 대리 접근 |
| `/super/accounts` | 전체 사용자 + 슈퍼관리자 관리 |
| `/super/api-keys` | 시스템 API 키 + 기관별 키 현황 |
| `/super/usage` | 실시간 사용량 모니터링 |
| `/super/contracts` | 계약 등록/갱신, 매출 통계 |
| `/super/notices` | 공지사항 작성/발행 |
| `/super/settings` | 시스템 설정, 점검 모드 |
| `/super/logs` | 접속·시스템·대리접근 로그 |

---

## 환경변수

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# NextAuth
NEXTAUTH_URL=
NEXTAUTH_SECRET=

# AI APIs
ANTHROPIC_API_KEY=       # Claude
VOYAGE_API_KEY=          # Voyage AI 임베딩

# 슈퍼관리자 전용
SUPER_ADMIN_SETUP_KEY=   # 최초 계정 생성 키
SUPER_JWT_SECRET=        # JWT 서명 키 (32바이트)
ENCRYPTION_KEY=          # API 키 암호화 키 (64자 hex)
```

### 키 생성 명령

```bash
# SUPER_JWT_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## DB 마이그레이션 실행 순서

Supabase SQL Editor에서 순서대로 실행:

```
0001_init.sql
0002_security_logs.sql
0003_search_document_chunks.sql
0004_search_agent_chunks.sql
0005_benchmark_features.sql
0006_super_admin.sql
0007_impersonation.sql
0008_user_active.sql
0009_api_keys_system.sql
0010_notices.sql
0011_logs.sql
```

---

## 기술 스택

| 레이어 | 기술 |
|---|---|
| Frontend | Next.js 14 (App Router) + TypeScript + Tailwind CSS |
| 일반 인증 | NextAuth.js 4 (Credentials) |
| 슈퍼관리자 인증 | 자체 JWT (HMAC-SHA256, httpOnly 쿠키) |
| DB | Supabase PostgreSQL + pgvector |
| AI/LLM | Claude API (`claude-sonnet-4-6`) |
| 임베딩 | Voyage AI (`voyage-3`) |
| 배포 | Vercel |
| 차트 | Recharts |
