# WORKON Project Overview

## Product Summary

WORKON is a multi-tenant enterprise AI platform for internal knowledge access and document-based report generation.

It helps organizations upload internal regulations, manuals, policies, and operating guidelines into a secure workspace. Employees can then search and ask questions about those documents using AI, and create internal reports from predefined templates with information pulled from the document library.

For the MVP, the goal is not to build a fully autonomous AI system. The goal is to build a reliable internal tool that makes it faster for employees to find trusted information and produce standard reports.

## Target Customers

The best early customers for WORKON are organizations with large amounts of internal documentation and repeated reporting workflows.

Examples:

- Mid-sized and large enterprises
- Financial institutions
- Insurance companies
- Healthcare organizations
- Manufacturing companies
- Consulting and professional services firms
- Internal compliance, operations, HR, and audit teams

These customers usually have:

- many internal documents spread across folders or systems
- employees who waste time searching for the right version of a rule or manual
- recurring reports that follow standard company formats
- strong requirements for access control and tenant separation

## Main Problems Solved

### 1. Information Is Hard to Find

Important internal rules and procedures are often stored in PDFs, Word files, or shared drives. Employees spend too much time searching manually.

WORKON solves this by:

- centralizing document upload
- indexing documents for AI-powered search
- returning answers with source references

### 2. Employees Need Faster, More Reliable Answers

Employees often ask coworkers or managers for answers that already exist in company documents. This is slow and inconsistent.

WORKON solves this by:

- letting users ask natural-language questions
- generating answers based only on approved internal content
- showing the document passages used in the answer

### 3. Repetitive Internal Reporting Takes Too Long

Many internal reports use fixed structures, but employees still rewrite the same sections repeatedly.

WORKON solves this by:

- providing predefined report templates
- helping users generate draft content from internal documents
- keeping humans in control before final submission

## Core MVP Features

The MVP should stay small and focus on the minimum features needed to prove business value.

### 1. Multi-Tenant Organization Workspaces

Each customer organization should have its own isolated workspace.

MVP scope:

- tenant-based data separation
- tenant admin account
- basic user roles such as admin and employee

### 2. Document Upload and Storage

Admins should be able to upload internal files into their tenant workspace.

MVP scope:

- upload PDF, DOCX, and TXT files
- store file metadata
- version-aware replacement or simple re-upload flow
- basic document list view

### 3. Document Processing and Indexing

Uploaded files need to be processed so AI can search and use them.

MVP scope:

- extract text from files
- split text into chunks
- generate embeddings
- store searchable index data

### 4. AI Search and Question Answering

Employees should be able to search internal documents in natural language.

MVP scope:

- keyword and semantic search
- chatbot-style question input
- answer generation using retrieved document chunks
- citations or links to source documents

### 5. Template-Based Report Generation

Users should be able to create internal reports from predefined templates.

MVP scope:

- admin-defined report templates
- prompt inputs for report context
- AI-generated draft sections using internal documents
- editable output before export or copy

### 6. Basic Admin Controls

Admins need simple controls to manage the workspace.

MVP scope:

- user invitation or account creation
- document visibility settings at a simple level
- template management
- basic usage logs

## Non-Goals for MVP

To keep delivery realistic, the following items should not be part of the first version.

- advanced workflow automation across departments
- complex approval chains for reports
- fine-grained permission models at paragraph or clause level
- support for every enterprise file type
- full OCR pipeline for low-quality scanned documents
- autonomous agents that take actions in other systems
- external system integrations with ERP, HR, CRM, or ticketing tools
- multilingual support beyond one primary launch language
- mobile app development
- highly customized analytics dashboards

## Recommended Tech Stack

The stack should prioritize fast implementation, maintainability, and support for AI search workflows.

### Frontend

- React with Next.js
- TypeScript
- Tailwind CSS for fast UI development

Why:

- widely used and beginner-friendly
- strong ecosystem for admin dashboards and forms
- good support for server-side and client-side features

### Backend

- Node.js with NestJS or Express
- TypeScript

Why:

- same language across frontend and backend
- good developer productivity
- easy integration with AI APIs, queues, and storage services

If the team prefers Python for AI-heavy development, FastAPI is also a strong option.

### Database

- PostgreSQL as the main relational database

Why:

- strong support for multi-tenant business applications
- reliable for users, documents, templates, and audit data

### Vector Search

- `pgvector` on PostgreSQL for MVP

Why:

- simpler operations for an MVP
- avoids managing a separate vector database too early
- good enough for early semantic search workloads

### File Storage

- AWS S3 or compatible object storage

Why:

- standard approach for uploaded enterprise documents
- scalable and easy to manage

### AI/LLM Layer

- OpenAI API for embeddings and answer/report generation

Recommended usage:

- embedding model for document indexing
- chat/completion model for question answering
- structured prompting for report generation

### Background Processing

- Redis plus a job queue such as BullMQ

Why:

- document parsing and embedding jobs should run asynchronously
- improves user experience during upload and indexing

### Authentication

- Enterprise-ready auth provider such as Auth0, Clerk, or Microsoft Entra ID

Why:

- reduces custom auth work
- supports future SSO requirements

### Hosting and Infrastructure

- Vercel for frontend
- AWS, Render, or Railway for backend and database in early stages
- Docker for local development and deployment consistency

## Success Criteria for MVP

The MVP is successful if it proves that teams can find information faster and produce useful draft reports with minimal setup.

Suggested success criteria:

- at least 3 pilot organizations can use separate tenant workspaces successfully
- admins can upload and index documents without engineering help
- employees can get useful answers with source citations from uploaded documents
- report templates can generate first-draft reports that users can edit and reuse
- average document search or answer flow is meaningfully faster than manual search
- early users report clear time savings in knowledge lookup or report writing
- the system shows stable tenant isolation and basic auditability

## Practical MVP Delivery Advice

To keep the first release manageable, build in this order:

1. Tenant setup, authentication, and document storage
2. Document text extraction and indexing pipeline
3. Search and question answering with citations
4. Template-based report generation
5. Basic admin tools and usage logging

A strong MVP is one that works reliably on a limited scope. It is better to support a few document formats and a few report templates well than to build many unfinished enterprise features.
