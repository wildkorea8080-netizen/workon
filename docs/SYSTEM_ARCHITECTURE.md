# WORKON System Architecture

## 1. High-Level Architecture

WORKON is a multi-tenant SaaS application built as a modern web app with Next.js App Router and TypeScript, using Supabase for authentication, database, and file storage, and OpenAI for internal document Q&A.

Key components:
- Frontend: Next.js App Router + Tailwind CSS
- Backend: Next.js server actions / API routes with Supabase and OpenAI integration
- Database: Supabase Postgres for tenant data, users, documents metadata, templates, reports, logs
- Storage: Supabase Storage for internal document files and generated report artifacts
- AI: OpenAI API for Q&A over document embeddings or direct document content
- Deployment: Vercel hosting for the frontend and server-side logic

## 2. Frontend Responsibilities

- Render UI pages and layouts for Admin and Employee roles.
- Provide authentication flows using Supabase Auth.
- Drive tenant-aware navigation and access control based on role.
- Implement document upload, metadata editing, template creation, and report generation workflows.
- Collect form data and send requests to backend services.
- Display AI Q&A results and source references.
- Provide responsive admin dashboards, record lists, and history views.
- Handle client-side validation and error display.

## 3. Backend Responsibilities

- Authenticate and authorize users using Supabase Auth and session validation.
- Enforce role-based access control for Admin vs Employee actions.
- Provide server-side endpoints or server actions for tenant-scoped CRUD operations.
- Manage document uploads, metadata updates, report template creation, report generation, and usage logs.
- Interface with OpenAI API for document Q&A.
- Validate inputs and sanitize outputs for security.
- Securely sign Supabase Storage uploads and provide temporary credentials if needed.
- Log all key actions to Postgres.

## 4. Database Responsibilities

- Store tenant records and organization metadata.
- Store users with role assignment and tenant association.
- Store document metadata, including file references, tags, status, and indexing pointers.
- Store report templates, field definitions, version metadata, and tenant ownership.
- Store generated report records, status, output file references, author, and timestamps.
- Store usage logs with tenant-scoped event metadata.
- Store AI query logs and document Q&A trace metadata.

## 5. Storage Responsibilities

- Store uploaded internal documents in Supabase Storage buckets.
- Store generated report artifacts as PDF or DOCX files.
- Ensure files are scoped to tenant-specific paths or buckets.
- Serve secure downloads with signed URLs or authenticated access.
- Manage file lifecycle for updates, replacements, and deletions.
- Optionally store extracted text or embeddings for search/Q&A.

## 6. AI Integration Responsibilities

- Accept employee natural language queries for internal documents.
- Retrieve tenant-specific documents and optionally precomputed embeddings.
- Forward user questions and document context to OpenAI API.
- Return an answer with source references and confidence metadata.
- Ensure AI queries are scoped to the tenant only.
- Log AI query usage and associate it with the user and tenant.
- Manage API keys securely through environment variables.

## 7. Multi-Tenant Isolation Strategy

- Use a tenant identifier on every user, document, template, report, and log record.
- Enforce tenant filters in every backend query.
- Ensure Supabase row-level security (RLS) policies require tenant membership for access.
- Use tenant-scoped Storage paths, e.g. `tenant-id/documents/...` and `tenant-id/reports/...`.
- Avoid cross-tenant references in frontend state and server responses.
- Authenticate via Supabase and map users to tenant context on each request.

## 8. Security Overview

- Authenticate all requests with Supabase Auth.
- Enforce RBAC for `admin` and `employee` roles.
- Protect sensitive endpoints with server-side validation.
- Encrypt data in transit using HTTPS for all Vercel and Supabase traffic.
- Store documents and report files securely in Supabase Storage.
- Do not expose OpenAI API keys in the client.
- Log authentication, upload, Q&A, template, and report events for audit.
- Use least-privilege permissions for storage and database access.

## 9. Key Modules and Boundaries

- `app/` and `components/` (Frontend)
  - Authentication and session hooks
  - Admin dashboard pages
  - Employee workspace pages
  - Document upload and metadata forms
  - Template editor and report generator
  - Q&A interface and answer viewer

- `lib/supabase/` (Backend helper layer)
  - Supabase client initialization
  - Auth session helpers
  - Tenant-aware query helpers
  - Storage helpers for uploads/downloads

- `lib/openai/`
  - OpenAI API client and prompt helpers
  - Q&A orchestration logic
  - Document context retrieval helpers

- `server/actions/` or `app/api/` routes
  - Document CRUD endpoints
  - Template CRUD endpoints
  - Report generation endpoints
  - Usage log ingestion endpoints
  - AI Q&A endpoint

- `database/` or `prisma/` schema (if used)
  - Tenant, user, document, template, report, log models

## 10. Future Extensibility Considerations

- Add role expansion with Reviewer, Auditor, and Guest roles.
- Add support for SSO / enterprise authentication providers.
- Add folder and tagging systems for documents.
- Add a document embedding pipeline for full semantic search.
- Add scheduled report generation and delivery.
- Add more output formats and custom report connectors.
- Add a plugin-based template engine.
- Add monitoring/observability with metrics for AI and storage usage.

## ASCII Architecture Diagram

```
[ Browser ]
    |
    | HTTPS
    v
[ Vercel Next.js App ]
    |-- Supabase Auth
    |-- Supabase Postgres
    |-- Supabase Storage
    |-- OpenAI API
    v
[ Supabase / OpenAI ]

Data flow:
- Browser -> Next.js -> Supabase Auth for login
- Browser -> Next.js -> Supabase Postgres for tenant data
- Browser -> Next.js -> Supabase Storage for files
- Next.js -> OpenAI API for document Q&A
```
