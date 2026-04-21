# WORKON User Flows

## 1. Organization Admin Flows

### 1.1 Sign In
- Actor: Organization Admin
- Goal: Authenticate and access the admin dashboard.
- Preconditions:
  - Admin account exists for the organization.
  - Admin has credentials (email and password).
- Main Steps:
  1. Open WORKON login page.
  2. Enter email and password.
  3. Submit login request.
  4. Backend validates credentials and checks tenant association.
  5. On success, redirect admin to their organization dashboard.
- Alternate/Error Paths:
  - Invalid credentials: show error message and allow retry.
  - Account disabled: show account status message.
  - Tenant not found: show "organization unavailable" error.
- Postconditions:
  - Admin session is created.
  - Admin is authorized for tenant-specific admin actions.

### 1.2 Upload Document
- Actor: Organization Admin
- Goal: Add a new internal document to the organization repository.
- Preconditions:
  - Admin is signed in.
  - Document file is available and in an accepted format (PDF, DOCX, TXT).
- Main Steps:
  1. Navigate to the document management section.
  2. Select "Upload Document." 
  3. Choose file and enter metadata fields (title, description, tags, visibility).
  4. Submit upload request.
  5. Backend stores the file securely, associates it with the tenant, and indexes content for AI Q&A.
  6. Confirm upload success in UI.
- Alternate/Error Paths:
  - Unsupported file type: display validation error.
  - File size limit exceeded: display size error.
  - Upload failure: retry or cancel option.
  - Missing required metadata: prompt for completion.
- Postconditions:
  - Document is stored and linked to the tenant.
  - Document becomes available for Q&A and search.

### 1.3 Manage Document Metadata
- Actor: Organization Admin
- Goal: Update document details and maintain accurate internal records.
- Preconditions:
  - Admin is signed in.
  - Document exists within the tenant.
- Main Steps:
  1. Navigate to document list.
  2. Locate and select a document.
  3. Open metadata edit view.
  4. Update fields such as title, description, tags, visibility, or associated folder.
  5. Save changes.
  6. Backend updates metadata and returns confirmation.
- Alternate/Error Paths:
  - Document not found: display error and refresh list.
  - Concurrent edit conflict: warn admin and present latest document state.
  - Validation error on metadata: show field-specific error messages.
- Postconditions:
  - Document metadata is updated for the tenant.
  - Changes are reflected in search and reports.

### 1.4 Create Report Template
- Actor: Organization Admin
- Goal: Define a reusable report structure for employees.
- Preconditions:
  - Admin is signed in.
  - Template authoring interface is accessible.
- Main Steps:
  1. Open report template management.
  2. Select "Create Template." 
  3. Enter template name, description, and placeholder schema.
  4. Define required fields and optional sections.
  5. Save template.
  6. Backend stores template linked to tenant and validates placeholders.
- Alternate/Error Paths:
  - Missing template name or required fields: show validation errors.
  - Invalid placeholder syntax: show syntax error guidance.
  - Save failure: retry with error details.
- Postconditions:
  - New template is available for employees.
  - Template metadata is stored and versioned.

### 1.5 Edit Template
- Actor: Organization Admin
- Goal: Revise an existing report template.
- Preconditions:
  - Admin is signed in.
  - Template exists in tenant.
- Main Steps:
  1. Navigate to template list.
  2. Select the template to edit.
  3. Modify template content, field definitions, or metadata.
  4. Save changes.
  5. Backend updates template version and retains audit information.
- Alternate/Error Paths:
  - Template locked or in use: warn user before editing.
  - Invalid field definitions: show validation errors.
  - Save conflict: prompt to reload or merge.
- Postconditions:
  - Template is updated with latest version.
  - Employees can use the revised template.

### 1.6 View Usage Logs
- Actor: Organization Admin
- Goal: Review tenant activity and audit key events.
- Preconditions:
  - Admin is signed in.
  - Usage logs are collected for the tenant.
- Main Steps:
  1. Navigate to the usage or audit log screen.
  2. Apply filters by date, user, action type, or resource.
  3. Review log entries.
  4. Drill into specific events if needed.
- Alternate/Error Paths:
  - No logs available: display "no activity found." 
  - Invalid filter criteria: show correction hints.
  - Permission denied: ensure admin role and tenant access.
- Postconditions:
  - Admin obtains a record of tenant actions.
  - Relevant log details are available for compliance.

## 2. Employee Flows

### 2.1 Sign In
- Actor: Employee
- Goal: Authenticate and access the employee workspace.
- Preconditions:
  - Employee account exists and belongs to a tenant.
  - Credentials are available.
- Main Steps:
  1. Open WORKON login page.
  2. Enter email and password.
  3. Submit login request.
  4. Backend validates credentials and tenant association.
  5. Redirect employee to the document/Q&A workspace.
- Alternate/Error Paths:
  - Invalid credentials: show error and retry option.
  - Account suspended: display account status.
  - Tenant disabled: show organization unavailable message.
- Postconditions:
  - Employee session is established.
  - Employee is authorized for tenant-limited actions.

### 2.2 Ask a Question About Internal Documents
- Actor: Employee
- Goal: Get answers from internal documents via AI Q&A.
- Preconditions:
  - Employee is signed in.
  - Internal documents are available for the tenant.
- Main Steps:
  1. Navigate to the internal documents Q&A interface.
  2. Enter a natural language question.
  3. Submit the question.
  4. Backend routes the query to AI service and document index.
  5. Receive AI response and supporting sources.
  6. Display answer in the UI.
- Alternate/Error Paths:
  - No documents available: show guidance to contact admin.
  - Question too broad: prompt to refine question.
  - AI timeout or failure: show retry option.
  - No answer found: show "no relevant information available." 
- Postconditions:
  - Employee receives an answer with sources.
  - Query is logged for usage tracking.

### 2.3 View Answer with Sources
- Actor: Employee
- Goal: Verify the AI answer and inspect source documents.
- Preconditions:
  - AI Q&A request completed successfully.
  - Source documents are accessible within tenant.
- Main Steps:
  1. View AI-generated response on the results screen.
  2. Review the source list, including document names and page/section references.
  3. Click a source item to inspect original document context.
  4. Confirm answer relevance.
- Alternate/Error Paths:
  - Source unavailable: display source retrieval error.
  - Document access denied: show tenant access error.
  - Source metadata missing: show fallback summary.
- Postconditions:
  - Employee can validate the answer through quoted sources.
  - Source references are available for follow-up.

### 2.4 Choose a Report Template
- Actor: Employee
- Goal: Select the appropriate template to generate a report.
- Preconditions:
  - Employee is signed in.
  - At least one approved template exists for the tenant.
- Main Steps:
  1. Navigate to report generation area.
  2. Browse or search available templates.
  3. View template details and placeholders.
  4. Select the desired template.
- Alternate/Error Paths:
  - No templates available: show "contact admin" message.
  - Template access denied: hide unavailable templates.
  - Template preview loading fails: retry option.
- Postconditions:
  - Template is selected and ready to fill.
  - Employee is shown required fields.

### 2.5 Fill Dynamic Form
- Actor: Employee
- Goal: Provide required values for the chosen report template.
- Preconditions:
  - Template is selected.
  - Template defines required fields and dynamic inputs.
- Main Steps:
  1. Display dynamic form fields from the selected template.
  2. Enter values for each required field.
  3. Optionally fill optional fields and add comments.
  4. Review completed input.
  5. Submit the form for report generation.
- Alternate/Error Paths:
  - Missing required fields: highlight and request completion.
  - Invalid input format: display field-specific validation errors.
  - Submission failure: show retry or save draft option.
- Postconditions:
  - Template inputs are validated and accepted.
  - The report generation request is triggered.

### 2.6 Generate Report
- Actor: Employee
- Goal: Create a finalized report from the selected template.
- Preconditions:
  - Dynamic form is completed and validated.
  - Template is available to render.
- Main Steps:
  1. Submit the template form.
  2. Backend combines template structure with provided values.
  3. Generate report document, attach metadata, and store it.
  4. Return success confirmation and download options.
  5. Display generated report summary and links.
- Alternate/Error Paths:
  - Template rendering error: show specific error and allow retry.
  - Storage failure: preserve form values and retry later.
  - Validation failure on backend: return field corrections.
- Postconditions:
  - Generated report is stored with tenant and user association.
  - Report is available for download and history review.

### 2.7 View Generation History
- Actor: Employee
- Goal: Review previously generated reports.
- Preconditions:
  - Employee is signed in.
  - Reports have been generated for the tenant.
- Main Steps:
  1. Navigate to report history or generated reports view.
  2. Review the list of generated reports, timestamps, and statuses.
  3. Filter or sort by date, template, or report name.
  4. Open a report to view details or download the file.
- Alternate/Error Paths:
  - No history records found: display "no generated reports." 
  - Report retrieval error: show error and retry link.
  - Permission denial: ensure access to report owner or tenant-level data.
- Postconditions:
  - Employee can access a list of their generated reports.
  - Report details and download options are available.
