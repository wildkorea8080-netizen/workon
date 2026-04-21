# WORKON Database Schema

## 1. Relationship Summary

- `organizations` own `profiles`, `documents`, `report_templates`, `report_generations`, `chat_sessions`, `chat_messages`, and `usage_logs`.
- `profiles` represent users and link to `memberships`.
- `memberships` link `profiles` to `organizations` with a role.
- `documents` are uploaded assets belonging to an organization.
- `report_templates` are reusable report definitions belonging to an organization.
- `report_generations` are completed reports created by a profile from a tenant template.
- `chat_sessions` represent Q&A interactions for tenant documents.
- `chat_messages` store individual messages within a chat session.
- `usage_logs` capture tenant-scoped actions across the system.

## 2. Tables

### 2.1 organizations

| Column | Type | Primary Key | Foreign Keys | Notes |
|---|---|---|---|---|
| id | uuid | yes |  | Tenant identifier |
| name | text | no |  | Organization display name |
| slug | text | no |  | Unique public identifier for URL and lookup |
| created_at | timestamptz | no |  | Creation timestamp |
| updated_at | timestamptz | no |  | Update timestamp |

Important indexes:
- `PRIMARY KEY (id)`
- `UNIQUE (slug)`

Tenant isolation notes:
- Acts as the root tenant record.
- All tenant-scoped tables reference `organization_id`.

### 2.2 profiles

| Column | Type | Primary Key | Foreign Keys | Notes |
|---|---|---|---|---|
| id | uuid | yes |  | User identifier |
| email | text | no |  | Login email, unique across workspace or per tenant depending on auth design |
| full_name | text | no |  | Display name |
| avatar_url | text | no |  | Optional profile image URL |
| created_at | timestamptz | no |  | Creation timestamp |
| updated_at | timestamptz | no |  | Update timestamp |

Important indexes:
- `PRIMARY KEY (id)`
- `UNIQUE (email)` or `UNIQUE (email, organization_id)` if email can repeat across tenants and membership is required for login

Tenant isolation notes:
- Profile may be global across tenants, but access is determined by `memberships`.
- Avoid storing tenant-specific state directly on profile.

### 2.3 memberships

| Column | Type | Primary Key | Foreign Keys | Notes |
|---|---|---|---|---|
| id | uuid | yes |  | Membership identifier |
| profile_id | uuid | no | `profiles(id)` | User membership reference |
| organization_id | uuid | no | `organizations(id)` | Tenant reference |
| role | text | no |  | `admin` or `employee` |
| created_at | timestamptz | no |  | Creation timestamp |
| updated_at | timestamptz | no |  | Update timestamp |

Important indexes:
- `PRIMARY KEY (id)`
- `UNIQUE (profile_id, organization_id)`
- `INDEX (organization_id)`
- `INDEX (profile_id)`

Tenant isolation notes:
- Membership is the core tenant binding for a user.
- Use this table to resolve roles and tenant access.

### 2.4 documents

| Column | Type | Primary Key | Foreign Keys | Notes |
|---|---|---|---|---|
| id | uuid | yes |  | Document identifier |
| organization_id | uuid | no | `organizations(id)` | Tenant reference |
| uploaded_by | uuid | no | `profiles(id)` | Owner/uploader profile |
| storage_path | text | no |  | Supabase storage key/path |
| file_name | text | no |  | Original file name |
| file_type | text | no |  | MIME type or extension |
| title | text | no |  | Document title |
| description | text | no |  | Optional description |
| tags | text[] | no |  | Optional tags 
| metadata | jsonb | no |  | Additional document metadata |
| created_at | timestamptz | no |  | Upload timestamp |
| updated_at | timestamptz | no |  | Last metadata update |

Important indexes:
- `PRIMARY KEY (id)`
- `INDEX (organization_id)`
- `INDEX (uploaded_by)`
- `GIN (tags)` if tags are queryable

Tenant isolation notes:
- Use `organization_id` to limit document access.
- Enforce RLS policies by tenant.

### 2.5 report_templates

| Column | Type | Primary Key | Foreign Keys | Notes |
|---|---|---|---|---|
| id | uuid | yes |  | Template identifier |
| organization_id | uuid | no | `organizations(id)` | Tenant reference |
| created_by | uuid | no | `profiles(id)` | Creator profile |
| name | text | no |  | Template name |
| description | text | no |  | Template purpose |
| schema | jsonb | no |  | Dynamic field definitions and placeholders |
| content | text | no |  | Template body or markup |
| version | int | no |  | Version counter |
| is_active | boolean | no |  | Active/archived marker |
| created_at | timestamptz | no |  | Creation timestamp |
| updated_at | timestamptz | no |  | Last update timestamp |

Important indexes:
- `PRIMARY KEY (id)`
- `INDEX (organization_id)`
- `INDEX (is_active)`

Tenant isolation notes:
- Template selection and generation filtered by organization.
- Keep history in versioned rows or separate audit.

### 2.6 report_generations

| Column | Type | Primary Key | Foreign Keys | Notes |
|---|---|---|---|---|
| id | uuid | yes |  | Generated report identifier |
| organization_id | uuid | no | `organizations(id)` | Tenant reference |
| template_id | uuid | no | `report_templates(id)` | Source template |
| generated_by | uuid | no | `profiles(id)` | User who generated report |
| input_data | jsonb | no |  | Filled template field values |
| output_path | text | no |  | Generated report storage path |
| output_type | text | no |  | `pdf`, `docx`, etc. |
| status | text | no |  | `completed`, `failed`, `pending` |
| created_at | timestamptz | no |  | Generation request time |
| completed_at | timestamptz | no |  | Completion timestamp |
| error_message | text | no |  | Optional failure details |

Important indexes:
- `PRIMARY KEY (id)`
- `INDEX (organization_id)`
- `INDEX (generated_by)`
- `INDEX (template_id)`
- `INDEX (status)`

Tenant isolation notes:
- Restrict report history queries by `organization_id`.
- Enforce template tenant relationship via backend validation.

### 2.7 chat_sessions

| Column | Type | Primary Key | Foreign Keys | Notes |
|---|---|---|---|---|
| id | uuid | yes |  | Chat session identifier |
| organization_id | uuid | no | `organizations(id)` | Tenant reference |
| profile_id | uuid | no | `profiles(id)` | Employee who started session |
| title | text | no |  | Optional session label |
| context | jsonb | no |  | Session metadata or document context pointers |
| created_at | timestamptz | no |  | Start timestamp |
| updated_at | timestamptz | no |  | Last activity timestamp |

Important indexes:
- `PRIMARY KEY (id)`
- `INDEX (organization_id)`
- `INDEX (profile_id)`

Tenant isolation notes:
- Session visibility limited to tenant.
- Keep context references tenant-scoped.

### 2.8 chat_messages

| Column | Type | Primary Key | Foreign Keys | Notes |
|---|---|---|---|---|
| id | uuid | yes |  | Chat message identifier |
| session_id | uuid | no | `chat_sessions(id)` | Parent chat session |
| organization_id | uuid | no | `organizations(id)` | Tenant reference |
| profile_id | uuid | no | `profiles(id)` | Sender profile (employee or system) |
| role | text | no |  | `user` or `assistant` |
| content | text | no |  | Message text |
| source_references | jsonb | no |  | Document source metadata |
| created_at | timestamptz | no |  | Message timestamp |

Important indexes:
- `PRIMARY KEY (id)`
- `INDEX (session_id)`
- `INDEX (organization_id)`

Tenant isolation notes:
- Messages must inherit session tenant and not cross-tenant.
- RLS should enforce both session and organization membership.

### 2.9 usage_logs

| Column | Type | Primary Key | Foreign Keys | Notes |
|---|---|---|---|---|
| id | uuid | yes |  | Usage log identifier |
| organization_id | uuid | no | `organizations(id)` | Tenant reference |
| profile_id | uuid | no | `profiles(id)` | User who performed action |
| action | text | no |  | Action type, e.g. `login`, `upload_document` |
| resource_type | text | no |  | `document`, `template`, `report`, `chat` |
| resource_id | uuid | no |  | Associated resource identifier |
| details | jsonb | no |  | Additional event metadata |
| created_at | timestamptz | no |  | Event timestamp |

Important indexes:
- `PRIMARY KEY (id)`
- `INDEX (organization_id)`
- `INDEX (profile_id)`
- `INDEX (action)`
- `INDEX (created_at)`

Tenant isolation notes:
- Logs are scoped to tenant and should be queryable by tenant admin only.
- Avoid storing sensitive text in `details`.

## 3. Row-Level Security Strategy

- Enable RLS on each tenant-scoped table: `documents`, `report_templates`, `report_generations`, `chat_sessions`, `chat_messages`, `usage_logs`.
- Create policies that allow access only when `organization_id` matches the authenticated user's tenant membership.
- Use a session variable like `auth.organization_id` and `auth.profile_id` to enforce limits.
- Example policy for `documents`:
  - `USING (organization_id = current_setting('request.jwt.claims.organization_id')::uuid)`
- Example policy for `report_templates`:
  - `USING (organization_id = current_setting('request.jwt.claims.organization_id')::uuid)`
- For `profiles`, use membership lookup to authorize access indirectly.
- For `usage_logs`, allow admin-role members only and filter by tenant.

## 4. Audit / Logging Considerations

- Use `usage_logs` to record key actions: login, document upload, metadata update, template creation/edit, report generation, chat queries, and deletions.
- Store: `organization_id`, `profile_id`, `action`, `resource_type`, `resource_id`, `details`, `created_at`.
- Retain logs for at least 90 days for audit purposes.
- Avoid storing sensitive document content or raw PII in `details`.
- Optionally use a separate audit table for critical changes if detailed diffs are required.
- Ensure log writes are durable and do not block user-facing operations.
- Use database triggers or application-level logging consistently.
