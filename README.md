# WORKON

**Multi-tenant SaaS platform for document management, AI-powered Q&A, and report generation**

- 📄 **Document Management**: Upload and manage internal documents (PDF, DOCX, TXT)
- 🤖 **AI Q&A**: Ask questions about documents, get answers with source references
- 📋 **Report Generation**: Create reports from templates using document insights
- 👥 **Multi-Tenant**: Secure department-based data isolation
- 🔐 **Role-Based Access**: Admin and user roles with proper authorization
- 🌐 **Korean Localization**: Full Korean UI and documentation

## Quick Start

### Prerequisites

- Node.js 18+
- npm/yarn
- Git
- Supabase account
- Anthropic API key
- Voyage AI API key

### Local Development

```bash
# 1. Clone and install
git clone <repository-url>
cd WORKON
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your development values

# 3. Run development server
npm run dev
# Open http://localhost:3000
```

**See [DEPLOYMENT.md](./DEPLOYMENT.md) for complete setup instructions.**

## Technology Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | Next.js 14 (App Router) + React 18 + TypeScript + Tailwind CSS |
| **Authentication** | NextAuth.js 4 with Credentials provider |
| **Database** | Supabase (PostgreSQL) with pgvector for embeddings |
| **AI Services** | Claude API (Anthropic) + Voyage AI (embeddings) |
| **Storage** | Supabase Storage (S3-compatible) |
| **Deployment** | Vercel |

## Project Structure

```
WORKON/
├── src/
│   ├── app/                    # Next.js App Router pages
│   │   ├── api/               # REST API routes
│   │   ├── admin/             # Admin dashboard
│   │   ├── auth/              # Authentication pages
│   │   ├── chat/              # Chat interface
│   │   ├── report/            # Report generation
│   │   └── user/              # User dashboard
│   ├── components/             # React components
│   │   ├── admin/             # Admin UI components
│   │   ├── chat/              # Chat UI components
│   │   └── report/            # Report components
│   ├── lib/                    # Utility functions
│   │   ├── auth.ts            # Authentication helpers
│   │   ├── claude.ts          # Claude API wrapper
│   │   ├── db.ts              # Type definitions
│   │   ├── embeddings.ts      # Voyage AI wrapper
│   │   ├── filter.ts          # Content filtering
│   │   ├── rag.ts             # RAG retrieval logic
│   │   ├── supabase.ts        # Client Supabase
│   │   └── supabaseAdmin.ts   # Admin Supabase client
│   ├── middleware.ts           # NextAuth middleware
│   └── types/                  # TypeScript types
├── docs/                       # Documentation
│   ├── DATABASE_SCHEMA.md      # Database design
│   ├── PRODUCT_REQUIREMENTS.md # Product spec
│   ├── SYSTEM_ARCHITECTURE.md  # Architecture details
│   ├── USER_FLOWS.md          # User workflows
│   └── PROJECT_OVERVIEW.md     # Project goals
├── CLAUDE.md                   # Development guidelines (source of truth)
├── DEPLOYMENT.md               # Deployment guide
├── PRODUCTION_NOTES.md         # Production safety notes
├── .env.example                # Environment variables template
└── package.json                # Dependencies

```

## Core Features

### 📄 Document Management
- Upload PDF, DOCX, TXT files
- Automatic text extraction
- Intelligent chunking and embedding
- Storage in secure vector database

### 🤖 AI-Powered Chat
- Ask questions about uploaded documents
- RAG (Retrieval Augmented Generation) search
- Source references for every answer
- Korean language support

### 📋 Report Templates
- Predefined report templates
- Template-based form generation
- AI-powered content generation using Claude
- Export and download reports

### 🛡️ Security & Multi-Tenancy
- Row-level Security (RLS) for data isolation
- Department-based access control
- Admin user management
- Forbidden word filtering

### 📊 Usage Analytics
- Dashboard statistics
- Usage tracking
- Performance monitoring
- Admin reporting

## API Overview

All API responses follow a consistent format:

```typescript
// Success
{ ok: true, data: T }

// Error
{ ok: false, error: { message: string; code?: string } }
```

### Key Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/chat` | Send message and get AI response |
| POST | `/api/upload` | Upload document |
| GET | `/api/stats` | Get usage statistics |
| POST | `/api/report` | Generate report |
| POST | `/api/agents` | Create/manage AI agents |
| GET\|PUT | `/api/forbidden-words` | Manage forbidden words |

## Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Authentication
NEXTAUTH_URL=http://localhost:3000  # Production: https://yourdomain.com
NEXTAUTH_SECRET=your-secret-32-characters-minimum

# AI APIs
ANTHROPIC_API_KEY=sk-ant-v1-xxxxx
VOYAGE_API_KEY=voyage-xxxxx

# Storage
NEXT_PUBLIC_SUPABASE_DOCUMENTS_BUCKET=documents
```

**Full documentation: See [.env.example](./.env.example)**

## Development Guidelines

All development follows guidelines in [CLAUDE.md](./CLAUDE.md):

- **API Response Format**: Consistent `{ok, data/error}` format
- **Authentication**: `getServerAuthSession()` for server routes
- **Database Types**: Centralized in `src/lib/db.ts`
- **Multi-Tenancy**: Department-based RLS policies
- **Korean Documentation**: All comments in Korean
- **Error Handling**: Consistent error responses

## Building & Deployment

### Development Build

```bash
npm run build
npm start
# Application runs on http://localhost:3000
```

### Production Deployment

1. **Configure Services**:
   - Create Supabase project
   - Set up Anthropic API key
   - Set up Voyage AI key

2. **Deploy to Vercel**:
   ```bash
   # Connect GitHub repository to Vercel
   # Add environment variables in Vercel dashboard
   # Deploy automatically on push to main
   ```

3. **Post-Deployment**:
   - Verify authentication flow
   - Test document upload
   - Monitor API costs

**See [DEPLOYMENT.md](./DEPLOYMENT.md) for step-by-step instructions.**

## Production Considerations

- **Monitoring**: Set up error tracking (Sentry recommended)
- **Backups**: Supabase handles automated backups
- **Security**: All secrets must use Vercel environment variables
- **Rate Limiting**: Implement API rate limiting for production
- **Costs**: Monitor Claude API and Voyage AI usage

**Full production safety guide: [PRODUCTION_NOTES.md](./PRODUCTION_NOTES.md)**

## Project Commands

```bash
# Development
npm run dev              # Start development server
npm run lint            # Run ESLint
npm run build           # Build for production
npm start               # Start production server

# Database
supabase db push        # Apply migrations
supabase db pull        # Sync local schema
```

## Documentation

| Document | Purpose |
|----------|---------|
| [CLAUDE.md](./CLAUDE.md) | Development guidelines - **source of truth** |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Complete deployment guide |
| [PRODUCTION_NOTES.md](./PRODUCTION_NOTES.md) | Production safety checklist |
| [docs/](./docs/) | Product and architecture documentation |

## Support & Troubleshooting

### Common Issues

**Build fails with type errors**:
```bash
npm install --legacy-peer-deps
npm run build
```

**Authentication issues**:
- Verify NEXTAUTH_SECRET is 32+ characters
- Check NEXTAUTH_URL matches your domain
- Confirm Supabase connection

**API errors**:
- Check API keys in environment variables
- Verify Supabase RLS policies
- Review Vercel logs

See [DEPLOYMENT.md Troubleshooting](./DEPLOYMENT.md#troubleshooting) for more.

## Architecture Related Files

- [docs/DATABASE_SCHEMA.md](./docs/DATABASE_SCHEMA.md) - Database design
- [docs/SYSTEM_ARCHITECTURE.md](./docs/SYSTEM_ARCHITECTURE.md) - Architecture overview
- [docs/USER_FLOWS.md](./docs/USER_FLOWS.md) - User workflows
- [docs/PROJECT_OVERVIEW.md](./docs/PROJECT_OVERVIEW.md) - Product goals

## Monitoring & Performance

### Key Metrics

- API response time < 2s
- Claude API latency 5-10s (expected)
- Error rate < 0.1%
- Database connection pool usage
- Storage and embedding costs

### Alerts to Set Up

- High error rate
- API latency spike
- Database connection limit reached
- Embedding API failures
- Weekly cost threshold

## Security

✅ **Implemented**:
- Row-level Security policies for multi-tenancy
- NextAuth.js authentication
- API request validation
- Content filtering (forbidden words)
- Secure password storage via Supabase Auth
- Environment-based secret management

⚠️ **Production Requirements**:
- Enable HTTPS only (Vercel default)
- Configure CORS if needed
- Set appropriate database backups
- Monitor access logs
- Regular security audits
- Keep dependencies updated

## License

Project is proprietary. All rights reserved.

## Support

For development questions, refer to [CLAUDE.md](./CLAUDE.md).  
For deployment issues, see [DEPLOYMENT.md](./DEPLOYMENT.md).  
For production concerns, review [PRODUCTION_NOTES.md](./PRODUCTION_NOTES.md).

---

**Project Status**: Production Ready (v0.1.0)  
**Last Updated**: April 15, 2026
