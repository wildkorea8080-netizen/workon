# WORKON Deployment Guide

**Version**: 0.1.0  
**Last Updated**: April 15, 2026  
**Status**: Ready for Production Deployment

## Table of Contents

1. [Local Development Setup](#local-development-setup)
2. [Supabase Configuration](#supabase-configuration)
3. [API Configuration](#api-configuration)
4. [Vercel Deployment](#vercel-deployment)
5. [Environment Variables Checklist](#environment-variables-checklist)
6. [Post-Deployment Verification](#post-deployment-verification)
7. [Production Monitoring](#production-monitoring)
8. [Troubleshooting](#troubleshooting)

## Local Development Setup

### Prerequisites
- Node.js 18+
- npm or yarn
- Git
- Supabase account (https://supabase.com)
- Anthropic account (https://console.anthropic.com)
- Voyage AI account (https://console.voyageai.com)

### Step 1: Clone and Install Dependencies

```bash
# Clone the repository
git clone <repository-url>
cd WORKON

# Install dependencies
npm install

# If npm install fails due to type resolution issues
npm install --legacy-peer-deps
```

### Step 2: Environment Configuration

```bash
# Copy the example configuration
cp .env.example .env

# Edit .env with your local development values
# See .env.example for documentation
nano .env  # or use your preferred editor
```

### Step 3: Run Development Server

```bash
npm run dev
```

Server will be available at `http://localhost:3000`

## Supabase Configuration

### Step 1: Create Supabase Project

1. Go to https://supabase.com and sign in
2. Click "New Project"
3. Choose an organization and project name
4. Set a strong database password
5. Select your region (closest to users for better performance)
6. Click "Create new project" and wait for initialization

### Step 2: Database Setup

The database schema is automatically created via migrations. Apply the schema:

```bash
# From project root, ensure Supabase CLI is installed
npm install -g supabase

# Apply migrations
supabase db push

# Or use the Supabase dashboard SQL editor to run migration scripts
```

**Schema includes**:
- `users` - User accounts and roles
- `departments` - Organization divisions
- `documents` - Uploaded files metadata
- `document_chunks` - Vectorized text chunks
- `chat_sessions` - Conversation history
- `messages` - Individual chat messages
- `agents` - AI agent configurations
- `report_templates` - Template definitions
- `reports` - Generated reports
- `forbidden_words` - Content filtering list
- `usage_stats` - Analytics tracking

### Step 3: Environment Keys

In Supabase Dashboard → Settings → API:

```env
NEXT_PUBLIC_SUPABASE_URL=https://[project-ref].supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=[anon-key]
SUPABASE_SERVICE_ROLE_KEY=[service-role-key]
```

### Step 4: RLS (Row Level Security) Configuration

RLS is critical for multi-tenancy. Verify policies are enabled:

1. Go to Supabase Dashboard → Settings → Database
2. Ensure "Row Level Security (RLS)" is enabled for:
   - `documents`
   - `chat_sessions`
   - `messages`
   - `agents`
   - `report_templates`
   - `forbidden_words`
   - `usage_stats`

### Step 5: Storage Configuration

1. Go to Storage → Buckets
2. Create bucket named `documents`
3. Set to Private
4. Create policy for authenticated users to upload/download

```sql
-- Allow users to upload documents they own
create policy "Users can upload documents"
on storage.objects
for insert
with check (auth.role() = 'authenticated');

-- Allow users to download documents from their department
create policy "Users can download department documents"
on storage.objects
for select
using (auth.role() = 'authenticated');

-- Allow admins to delete documents
create policy "Admins can delete documents"
on storage.objects
for delete
using (
  auth.role() = 'authenticated' and
  exists (
    select 1 from users where id = auth.uid() and role = 'ADMIN'
  )
);
```

## API Configuration

### Anthropic Claude API

1. Go to https://console.anthropic.com
2. Sign in or create account
3. Go to "API keys" section
4. Click "Create key"
5. Copy the key and add to environment:

```env
ANTHROPIC_API_KEY=sk-ant-v1-xxxxxxxxxxxxx
```

**Usage Limits**:
- Model: `claude-3-sonnet-20240229`
- Max tokens per request: 4096
- Rate limits: Check Anthropic dashboard

### Voyage AI Embeddings

1. Go to https://console.voyageai.com
2. Sign in or create account
3. Go to "API keys"
4. Create new API key
5. Add to environment:

```env
VOYAGE_API_KEY=voyage-xxxxxxxxxxxxxxx
```

**Configuration**:
- Model: `voyage-3`
- Embedding dimensions: 1024
- Input limit: Multiple texts per request

## Vercel Deployment

### Step 1: Prepare Repository

```bash
# Ensure .env.example exists
# Ensure .gitignore includes .env
# Commit all changes
git add .
git commit -m "Prepare for deployment"
git push origin main
```

### Step 2: Connect to Vercel

1. Go to https://vercel.com
2. Click "New Project"
3. Select "Import Git Repository"
4. Choose the WORKON repository
5. Configure project:
   - Framework Preset: Next.js
   - Build Command: `npm run build`
   - Output Directory: `.next`

### Step 3: Environment Variables in Vercel

Add in Vercel Dashboard → Settings → Environment Variables:

```
NEXT_PUBLIC_SUPABASE_URL=https://[project-ref].supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=[anon-key]
SUPABASE_SERVICE_ROLE_KEY=[service-role-key]

NEXTAUTH_URL=https://yourdomain.vercel.app  (Update with actual domain)
NEXTAUTH_SECRET=[32+ character random string]

ANTHROPIC_API_KEY=sk-ant-v1-xxxxxxxxxxxxx
VOYAGE_API_KEY=voyage-xxxxxxxxxxxxxxx

NEXT_PUBLIC_SUPABASE_DOCUMENTS_BUCKET=documents
```

**Generate NEXTAUTH_SECRET**:
```bash
openssl rand -base64 32
# or
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### Step 4: Deploy

1. Click "Deploy"
2. Wait for build to complete
3. Verify deployment succeeded

### Step 5: Configure Custom Domain (Optional)

1. In Vercel → Settings → Domains
2. Add your custom domain
3. Update DNS records as instructed
4. Update NEXTAUTH_URL in environment variables

## Environment Variables Checklist

### Required for All Environments

- [ ] `NEXT_PUBLIC_SUPABASE_URL` - Supabase project URL
- [ ] `NEXT_PUBLIC_SUPABASE_ANON_KEY` - Supabase anon key
- [ ] `SUPABASE_SERVICE_ROLE_KEY` - Supabase service role (server only)
- [ ] `NEXTAUTH_URL` - Application URL (http://localhost:3000 for dev)
- [ ] `NEXTAUTH_SECRET` - 32+ character secret
- [ ] `ANTHROPIC_API_KEY` - Claude API key
- [ ] `VOYAGE_API_KEY` - Voyage AI embeddings key

### Optional

- [ ] `NEXT_PUBLIC_APP_NAME` - Application display name (default: WORKON)
- [ ] `NEXT_PUBLIC_SUPABASE_DOCUMENTS_BUCKET` - Storage bucket (default: documents)

### Environment-Specific

**Development (.env)**:
```
NEXTAUTH_URL=http://localhost:3000
# Use development API keys
```

**Production (Vercel)**:
```
NEXTAUTH_URL=https://yourdomain.com
# Use production API keys
```

## Post-Deployment Verification

### Step 1: Health Checks

```bash
# Check if deployment is live
curl https://yourdomain.com

# Expected response: HTML with WORKON page

# Check API health
curl https://yourdomain.com/api/stats
# Expected: 401 response (not authenticated) or account list
```

### Step 2: Authentication Flow

1. Go to https://yourdomain.com
2. Click "Login"
3. Use test credentials:
   - Email: test@example.com
   - Password: TestPassword123!
4. Should redirect to dashboard
5. Check for console errors (F12)

### Step 3: Document Upload

1. As admin, go to Admin → Documents
2. Upload a PDF/DOCX/TXT file
3. Check upload completes successfully
4. Verify file appears in document list

### Step 4: RAG Search

1. Go to Chat
2. Enter a question about uploaded documents
3. Verify response is generated with sources
4. Check Anthropic API costs are increasing

### Step 5: Admin Features

1. Go to Admin → Settings
2. Add a forbidden word
3. Verify it's saved
4. Test chat filtering with the word

## Production Monitoring

### Set Up Error Tracking

**Option 1: Using Sentry**

```bash
npm install @sentry/nextjs
```

Configure in next.config.mjs:
```javascript
import * as Sentry from "@sentry/nextjs";

const nextConfig = {
  // ... existing config
};

export default Sentry.withSentryConfig(nextConfig, {
  org: "your-org",
  project: "workon",
  authToken: process.env.SENTRY_AUTH_TOKEN,
});
```

**Option 2: Using Vercel Analytics**
- Automatically enabled on Vercel
- Go to Vercel Dashboard → Analytics for monitoring

### Monitor API Costs

**Anthropic Claude API**:
- Check https://console.anthropic.com/dashboard
- Set up cost alerts
- Monitor token usage

**Voyage AI**:
- Check https://console.voyageai.com/dashboard
- Monitor embedding API calls

**Supabase**:
- Check https://app.supabase.com/projects
- Monitor database queries and storage

### Key Metrics to Monitor

1. **API Response Times** - Should be < 2s for typical requests
2. **Claude API Latency** - Usually 5-10s for report generation
3. **Error Rate** - Should be < 0.1%
4. **Database Connections** - Monitor connection pool
5. **Storage Usage** - Documents and embeddings storage
6. **User Growth** - New departments and users

## Troubleshooting

### Build Fails

```
Error: Cannot find module '@types/react'
```

**Solution**:
```bash
npm install --legacy-peer-deps
npm run build
```

### Authentication Not Working

```
Error: No token found in API response
```

**Check**:
- [ ] NEXTAUTH_SECRET is 32+ characters
- [ ] NEXTAUTH_URL matches deployment domain
- [ ] Supabase connection is working
- [ ] Database has users table

**Fix**:
```bash
# Regenerate NEXTAUTH_SECRET
openssl rand -base64 32

# Update in Vercel environment variables
# Redeploy
```

### Embeddings Not Working

```
Error: Voyage embeddings 요청 중 오류가 발생했습니다.
```

**Check**:
- [ ] VOYAGE_API_KEY is valid
- [ ] Voyage account has quota remaining
- [ ] Input text is not empty

### Claude API Errors

```
Error: Claude API 오류: 401 - Invalid API Key
```

**Check**:
- [ ] ANTHROPIC_API_KEY starts with `sk-ant-`
- [ ] Key is not expired
- [ ] Account has available balance

### Supabase Connection Issues

```
Error: Failed to connect to database
```

**Check**:
- [ ] NEXT_PUBLIC_SUPABASE_URL is correct
- [ ] SUPABASE_SERVICE_ROLE_KEY is valid
- [ ] Project is not paused
- [ ] Network allows connection to Supabase

### CORS/CORS Errors

```
Error: Access-Control-Allow-Origin header missing
```

**Solution**:
- Verify API requests use credentials
- Check Supabase RLS policies
- Verify NEXTAUTH_URL configuration

## Scaling Considerations

### Database Optimization

```sql
-- Add indexes for frequently queried columns
CREATE INDEX idx_documents_agent_id ON documents(agent_id);
CREATE INDEX idx_chat_sessions_user_id ON chat_sessions(user_id);
CREATE INDEX idx_messages_session_id ON messages(chat_session_id);
```

### Caching Strategy

- Use Vercel's automatic caching for static pages
- Consider Redis for session caching (if using external sessions)
- Cache embedding results in database

### Rate Limiting

Implement rate limiting for API routes:

```typescript
// Simple rate limiting (production: use external service)
const rateLimits = new Map<string, number[]>();

function checkRateLimit(userId: string, maxRequests = 10, windowMs = 60000) {
  const now = Date.now();
  const userLimits = rateLimits.get(userId) || [];
  const recentRequests = userLimits.filter(t => now - t < windowMs);
  
  if (recentRequests.length >= maxRequests) {
    return false;
  }
  
  recentRequests.push(now);
  rateLimits.set(userId, recentRequests);
  return true;
}
```

---

**For production issues or questions: Consult CLAUDE.md for coding standards and architecture guidelines.**
