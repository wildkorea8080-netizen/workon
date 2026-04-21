# WORKON Product Requirements

## 1. Overview
WORKON is an internal SaaS platform for multi-tenant organizations to manage internal documents, ask AI-powered questions over those documents, and generate structured reports using templates. The MVP is focused on secure tenant isolation, admin-driven configuration, and quality document-based AI workflows.

## 2. User Roles

2.1 Admin
- Manages departments and users.
- Configures AI agents and report templates.
- Uploads internal documents and assigns them to agents.
- Defines forbidden words and reviews usage logs.
- Views tenant-scoped audit and usage history.

2.2 Employee
- Uses assigned AI agents for internal document Q&A.
- Generates reports from approved templates.
- Views their own generated reports and chat history.
- Interacts only with department-scoped data.

## 3. Functional Requirements

### 3.1 Multi-Tenant Organization Support
- FR-1: Support multiple departments/organizations with tenant isolation.
- FR-2: Each department has a separate set of users, agents, documents, templates, and logs.
- FR-3: Department data must not be accessible to users or admins from another department.

### 3.2 Admin and Employee Roles
- FR-4: Support at least two roles: `ADMIN` and `USER`.
- FR-5: Admins can manage users, departments, agents, documents, templates, and forbidden words.
- FR-6: Employees can access Q&A, document search, and report generation for their department.
- FR-7: Enforce role-based access control on all API endpoints and UI actions.

### 3.3 Internal Document Upload and Management
- FR-8: Allow document upload of PDF, DOCX, and TXT.
- FR-9: Enforce a 20MB maximum upload size.
- FR-10: Automatically extract text from uploaded documents.
- FR-11: Store document metadata, title, summary, storage path, and chunk data.
- FR-12: Associate documents with a department and optionally with an agent.
- FR-13: Allow admins to list, inspect, and delete uploaded documents.

### 3.4 AI-Powered Internal Document Q&A
- FR-14: Allow employees to ask natural language questions to an agent.
- FR-15: Retrieve relevant document chunks using semantic search.
- FR-16: Generate answers using AI with document context.
- FR-17: Attach source reference metadata to answers for traceability.
- FR-18: Filter user input through department forbidden words.

### 3.5 Report Template Management
- FR-19: Allow admins to create, edit, activate/deactivate, and delete templates.
- FR-20: Templates must include name, description, content, schema, and active status.
- FR-21: Templates are scoped to a department.
- FR-22: Maintain template metadata such as version or last modified timestamp.

### 3.6 Report Generation from Templates
- FR-23: Employees can generate reports by selecting a template and providing required fields.
- FR-24: Use AI to render the final report from template content and user input.
- FR-25: Return generated report text to the employee.
- FR-26: Save generation usage metadata including template name, user, and department.

### 3.7 Usage Logging
- FR-27: Log actions for login, document upload, agent creation, template edits, Q&A queries, and report generation.
- FR-28: Store logs with tenant, user, action, resource type, resource ID, details, and timestamp.
- FR-29: Make logs reviewable by admins within their department.
- FR-30: Do not store sensitive raw content in logs.

## 4. Non-Functional Requirements

- NFR-1: Enforce data isolation between tenants at the database and application layers.
- NFR-2: Store secrets and API keys server-side only.
- NFR-3: Use secure authentication and session handling.
- NFR-4: Ensure document storage and transfers use secure channels.
- NFR-5: Provide consistent JSON API responses with error handling.
- NFR-6: Preserve performance for typical Q&A requests under 5 seconds.
- NFR-7: Preserve performance for report generation under 10 seconds.
- NFR-8: Retain audit logs for at least 90 days.
- NFR-9: Support modern desktop browsers in MVP.
- NFR-10: Limit MVP load to approximately 100 concurrent users.

## 5. MVP Scope

### In Scope
- Multi-tenant department support with RBAC.
- Admin and employee role management.
- Internal document upload (PDF, DOCX, TXT) and secure storage.
- Document processing, chunking, and embeddings for retrieval.
- Agent-based AI Q&A with tenant-scoped documents.
- Report template creation and department scoping.
- Report generation from templates.
- Department-scoped usage and audit logging.
- Forbidden word filtering per department.

### Implementation Boundaries
- Document upload limited to core file types.
- Report templates are text-based, placeholder-driven, and not formula-enabled.
- Q&A uses retrieved document context, but no advanced multi-document analytics.
- No external public document sharing or guest access.
- No mobile-first native app MVP.

## 6. Excluded Features for Now

- External customer-facing portals or public document access.
- Multi-stage approval workflows for reports.
- Advanced template scripting, formulas, and macros.
- Document version history and rollback.
- Full-text search across the entire platform beyond tenant scope.
- Real-time collaboration or co-authoring.
- Multi-factor authentication in the initial release.
- AI-driven template authoring or template suggestions.
- Rich analytics dashboards beyond basic usage logs.

## 7. Assumptions

- Each user belongs to one department only.
- Admins are responsible for tenant configuration and employee management.
- Internal documents are sensitive and require tenant isolation.
- AI services are available and configured via server-side secrets.
- Employees rely on admin-created templates and agent assignments.
- Database-level RLS or equivalent enforcement is available.
- Usage logs are sufficient for initial auditing and monitoring.

## 8. Future Expansion Ideas

- Add additional roles: Reviewer, Auditor, Department Manager.
- Add workflow approvals for report generation and publishing.
- Enable document versioning and history tracking.
- Add semantic tagging, classification, and folder-based document organization.
- Add export options: PDF, DOCX, and email delivery.
- Add dashboards for agent usage, document relevance, and report adoption.
- Add SSO and enterprise authentication support.
- Add mobile-responsive UI and native mobile clients.
- Add advanced AI prompt management per agent.

## 9. Requirement Summary Table

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-1 | Tenant data isolation | High | Core architecture requirement |
| FR-4 | Admin / Employee roles | High | Must enforce RBAC across UI/API |
| FR-8 | Document upload and processing | High | PDF/DOCX/TXT only |
| FR-14 | AI document Q&A | High | Tenant-scoped retrieval required |
| FR-19 | Report template management | High | Department-specific templates |
| FR-23 | Report generation from templates | High | Save generated reports |
| FR-27 | Usage logging | High | Audit and monitoring |
| NFR-1 | Security and isolation | High | Data and secrets protection |
| NFR-6 | Q&A performance | Medium | 5s target for normal queries |
| NFR-8 | Log retention | Medium | 90-day retention |
