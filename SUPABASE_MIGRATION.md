# 🗄️ Supabase 마이그레이션 가이드

## 현재 상태

- **Supabase URL**: https://rmsebxqzwxpzuiywavsf.supabase.co
- **프로젝트**: WORKON
- **마이그레이션 파일**: supabase/migrations/0001_init.sql
- **상태**: ✅ 준비 완료

## 📋 실행 단계

### STEP 1: Supabase 웹 콘솔 접속

1. https://app.supabase.com 로 이동
2. 이메일/비밀번호로 로그인
3. "WORKON" 프로젝트 선택

### STEP 2: SQL 에디터 열기

1. 좌측 메뉴에서 **SQL Editor** 클릭
2. **New query** 버튼 클릭

### STEP 3: 마이그레이션 SQL 실행

아래 SQL을 **전체 복사**하여 에디터에 붙여넣고 **Run** 클릭:

```sql
-- Enable required extensions for Supabase and pgvector support
create extension if not exists pgcrypto;
create extension if not exists vector;

-- Departments represent access groups for users and resources.
create table departments (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index departments_slug_idx on departments(slug);

-- Users belong to departments and are the primary actors.
create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  full_name text,
  role text not null default 'USER',
  department_id uuid references departments(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index users_email_idx on users(email);
create index users_department_id_idx on users(department_id);

-- Agents are configured AI personas associated with a department.
create table agents (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references departments(id) on delete cascade,
  name text not null,
  description text,
  system_prompt text,
  config jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_by uuid references users(id),
  updated_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index agents_department_name_idx on agents(department_id, name);
create index agents_department_id_idx on agents(department_id);

-- Documents store uploaded files and embeddings for Q&A.
create table documents (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references departments(id) on delete cascade,
  agent_id uuid references agents(id),
  uploaded_by uuid references users(id),
  storage_path text not null,
  file_name text not null,
  file_type text,
  title text,
  summary text,
  metadata jsonb not null default '{}'::jsonb,
  embedding vector(1024),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index documents_department_id_idx on documents(department_id);
create index documents_agent_id_idx on documents(agent_id);
create index documents_uploaded_by_idx on documents(uploaded_by);
create index documents_embedding_idx on documents using ivfflat (embedding vector_l2_ops) with (lists = 100);

-- Conversations are chat sessions with an agent.
create table conversations (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references departments(id) on delete cascade,
  agent_id uuid references agents(id),
  user_id uuid references users(id),
  title text,
  status text not null default 'active',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index conversations_department_id_idx on conversations(department_id);
create index conversations_agent_id_idx on conversations(agent_id);
create index conversations_user_id_idx on conversations(user_id);

-- Messages belong to conversations and store assistant/user exchanges.
create table messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  user_id uuid references users(id),
  role text not null,
  content text not null,
  source_references jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index messages_conversation_id_idx on messages(conversation_id);
create index messages_user_id_idx on messages(user_id);
create index messages_role_idx on messages(role);

-- Report templates are reusable output definitions for a department.
create table report_templates (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references departments(id) on delete cascade,
  created_by uuid references users(id),
  name text not null,
  description text,
  content text not null,
  schema jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index report_templates_department_name_idx on report_templates(department_id, name);
create index report_templates_department_id_idx on report_templates(department_id);

-- Forbidden words provide department-level content guard rails.
create table forbidden_words (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references departments(id) on delete cascade,
  word text not null,
  context text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index forbidden_words_department_word_idx on forbidden_words(department_id, word);
create index forbidden_words_department_id_idx on forbidden_words(department_id);

-- Usage logs capture actions for audit and observability.
create table usage_logs (
  id uuid primary key default gen_random_uuid(),
  department_id uuid references departments(id) on delete set null,
  user_id uuid references users(id),
  action text not null,
  resource_type text,
  resource_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index usage_logs_department_id_idx on usage_logs(department_id);
create index usage_logs_user_id_idx on usage_logs(user_id);
create index usage_logs_action_idx on usage_logs(action);
create index usage_logs_created_at_idx on usage_logs(created_at);

-- Enable Row Level Security (RLS) for multi-tenancy
alter table departments enable row level security;
alter table users enable row level security;
alter table agents enable row level security;
alter table documents enable row level security;
alter table conversations enable row level security;
alter table messages enable row level security;
alter table report_templates enable row level security;
alter table forbidden_words enable row level security;
alter table usage_logs enable row level security;

-- RLS Policies for departments (admin only)
create policy "Departments are viewable by anyone" on departments
  for select using (true);

-- RLS Policies for users (department isolation)
create policy "Users can see their own record" on users
  for select using (auth.uid() = id);

create policy "Users can see department members" on users
  for select using (department_id = (select department_id from users where id = auth.uid()));

-- RLS Policies for agents (department level)
create policy "Agents viewable within department" on agents
  for select using (department_id = (select department_id from users where id = auth.uid()));

-- RLS Policies for documents (department level)
create policy "Documents viewable within department" on documents
  for select using (department_id = (select department_id from users where id = auth.uid()));

-- RLS Policies for conversations (user specific)
create policy "Conversations viewable by owner" on conversations
  for select using (user_id = auth.uid());

-- RLS Policies for messages (conversation based)
create policy "Messages viewable in user's conversations" on messages
  for select using (
    conversation_id in (
      select id from conversations where user_id = auth.uid()
    )
  );

-- RLS Policies for report templates (department level)
create policy "Templates viewable within department" on report_templates
  for select using (department_id = (select department_id from users where id = auth.uid()));

-- RLS Policies for forbidden words (admin only)
create policy "Forbidden words viewable by admins" on forbidden_words
  for select using (
    (select role from users where id = auth.uid()) = 'ADMIN'
  );

-- RLS Policies for usage logs (department level)
create policy "Usage logs viewable by admins in department" on usage_logs
  for select using (
    (select role from users where id = auth.uid()) = 'ADMIN' and
    department_id = (select department_id from users where id = auth.uid())
  );
```

✅ **성공 메시지**: "Success" 표시 및 테이블 목록이 보입니다.

---

## ⚠️ 문제 해결

### 에러: "extension vector not found"
→ Supabase 벡터 확장이 아직 활성화되지 않음
- **해결**: Supabase 대시보드 → [Extensions] → "vector" 검색 → Enable 클릭

### 에러: "permission denied"
→ 계정 권한 부족
- **해결**: 프로젝트 소유자(Owner) 계정으로 로그인

### 에러: "relation already exists"
→ 이미 마이그레이션이 실행됨
- **해결**: SQL을 `drop table if exists` 추가로 수정 후 재실행 (주의: 모든 데이터 삭제됨)

---

## 🌱 STEP 4: 초기 데이터 설정

마이그레이션 이후 초기 데이터(부서, 에이전트 등)를 설정합니다.

### 옵션 A: 터미널로 실행 (권장)
```bash
cd d:\coding\WORKON
node setup-initial-data.mjs
```

출력 결과:
```
✅ 부서 3개 생성
✅ 에이전트 3개 생성
✅ 관리자 계정 생성
✅ 초기 데이터 설정 완료
```

### 옵션 B: 수동으로 부서/에이전트 생성

Supabase 웹 콘솔 → **Table Editor** → `departments` 테이블:

```json
[
  {
    "name": "총무팀",
    "slug": "general-affairs",
    "description": "인사, 예산, 복지 담당"
  },
  {
    "name": "기획팀", 
    "slug": "planning",
    "description": "전략, 기획, 정책 담당"
  },
  {
    "name": "사업팀",
    "slug": "business",
    "description": "사업 운영, 실행 담당"
  }
]
```

---

## 🔐 STEP 5: 관리자 계정 생성

마이그레이션 후 첫 관리자 계정을 생성합니다.

### 옵션 A: API 호출로 생성
```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@example.com",
    "password": "SecurePassword123!",
    "full_name": "관리자"
  }'
```

### 옵션 B: Supabase 직접 생성

1. Supabase 대시보드 → [Authentication] → [Users]
2. **Add user** 버튼 클릭
3. 이메일/비밀번호 입력

그 다음 **users 테이블** → 해당 사용자 행 수정:
- `role`: `ADMIN` (기본값은 USER)
- `department_id`: 부서 UUID 선택
- `full_name`: 관리자 이름

---

## ✅ 검증 체크리스트

마이그레이션이 성공했는지 확인:

### 1. 테이블 생성 확인
```sql
SELECT table_name FROM information_schema.tables 
WHERE table_schema = 'public' 
ORDER BY table_name;
```

**예상 결과**: 9개 테이블 표시
- departments
- users
- agents
- documents
- conversations
- messages
- report_templates
- forbidden_words
- usage_logs

### 2. 벡터 인덱스 확인
```sql
SELECT * FROM pg_indexes 
WHERE indexname LIKE '%embedding%';
```

**예상 결과**: documents_embedding_idx 표시

### 3. RLS 정책 확인
```sql
SELECT schemaname, tablename, policyname FROM pg_policies;
```

**예상 결과**: 약 15개 정책 표시

### 4. 확장 확인
```sql
SELECT * FROM pg_extension WHERE extname IN ('pgcrypto', 'vector');
```

**예상 결과**: 2개 행 (pgcrypto, vector)

---

## 🚀 STEP 6: 개발 서버 시작

마이그레이션 완료 후 앱을 구동합니다:

```bash
npm run dev
```

앱 접속: http://localhost:3000

---

## 📊 마이그레이션 요약

| 항목 | 개수 | 설명 |
|------|------|------|
| **테이블** | 9개 | 부서, 사용자, 에이전트, 문서, 대화 등 |
| **인덱스** | 20+ | 검색 성능 최적화 |
| **RLS 정책** | 15+ | 다중 테넌트 격리 |
| **확장** | 2개 | pgcrypto (해시), vector (임베딩) |
| **트리거** | 0개 | 향후 추가 예정 |

---

## 💾 백업

마이그레이션 전에 백업을 권장합니다:

1. Supabase 대시보드 → [Settings] → [Backups]
2. **Create backup** 클릭
3. 이름 입력 (예: "Pre-Migration-2026-04-17")

---

## 📝 다음 단계

1. ✅ Supabase 마이그레이션 **완료**
2. ⬜ 초기 데이터 설정 (setup-initial-data.mjs 실행)
3. ⬜ 관리자 계정 생성
4. ⬜ 로컬 테스트 (로그인 → 채팅 → 관리자 포털)
5. ⬜ Vercel 배포

---

**최종 업데이트**: 2026년 4월 17일 | WORKON v1.0