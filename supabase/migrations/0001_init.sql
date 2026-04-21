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
