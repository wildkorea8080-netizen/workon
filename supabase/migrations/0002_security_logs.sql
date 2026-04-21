-- Security logs table for capturing audit events such as forbidden word
-- detections, blocked uploads, personal info exposure, and rate limiting.
create table security_logs (
  id uuid primary key default gen_random_uuid(),
  department_id uuid references departments(id) on delete set null,
  user_id uuid references users(id) on delete set null,
  event_type text not null,
  details jsonb not null default '{}'::jsonb,
  severity text not null default 'medium',
  created_at timestamptz not null default now()
);

create index security_logs_department_id_idx on security_logs(department_id);
create index security_logs_user_id_idx on security_logs(user_id);
create index security_logs_event_type_idx on security_logs(event_type);
create index security_logs_severity_idx on security_logs(severity);
create index security_logs_created_at_idx on security_logs(created_at);
