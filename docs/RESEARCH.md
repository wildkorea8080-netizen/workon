# WORKON 프로젝트 상세 분석 보고서 (RESEARCH.md)

**작성일**: 2026년 4월 17일  
**프로젝트 명**: WORKON v0.1.0  
**분석 범위**: 전체 코드베이스 구조, 데이터 흐름, 함수/클래스 목록, 미구현 부분, 위험 지점

---

## 1. 프로젝트 개요

### 1.1 기본 정보
- **목표**: 다중 테넌트 SaaS 플랫폼으로 문서 관리, AI 기반 Q&A, 보고서 생성 제공
- **기술 스택**: Next.js 14 (App Router) + React 18 + TypeScript + Tailwind CSS
- **인증**: NextAuth.js 4 (Credentials Provider)
- **데이터베이스**: Supabase (PostgreSQL + pgvector)
- **AI 서비스**: Claude API (Anthropic) + Voyage AI (임베딩)
- **저장소**: Supabase Storage (S3 호환)
- **배포**: Vercel

### 1.2 핵심 아키텍처
- **다중 테넌시**: 부서(Department) 기반 데이터 격리
- **권한 제어**: 역할 기반 접근 제어 (ADMIN/USER)
- **RLS (Row Level Security)**: Supabase에서 테넌트 경계 강제
- **문서 처리**: 청킹(1000 단어당 청크) + Voyage AI 임베딩
- **RAG (Retrieval-Augmented Generation)**: 코사인 유사도 기반 검색 (임계값: 0.72)

---

## 2. 디렉토리 구조 및 파일 역할

### 2.1 루트 디렉토리
```
d:\coding\WORKON/
├── src/                          # 소스 코드
├── supabase/                      # 데이터베이스 마이그레이션 및 시드
├── docs/                          # 문서
├── .env.local                     # 로컬 환경 변수 (git 제외)
├── .env.example                   # 환경 변수 템플릿
├── next.config.mjs                # Next.js 설정
├── tailwind.config.ts             # Tailwind CSS 설정
├── tsconfig.json                  # TypeScript 설정
├── package.json                   # 의존성과 스크립트
├── CLAUDE.md                      # 개발 가이드라인 (소스 오브 트루스)
├── README.md                      # 프로젝트 소개
├── DEPLOYMENT.md                  # 배포 가이드
├── DEPLOYMENT_CHECKLIST.md        # 배포 체크리스트
├── PRODUCTION_AUDIT.md            # 프로덕션 준비 감시
├── PRODUCTION_NOTES.md            # 프로덕션 노트
└── create-users.js                # 테스트 사용자 생성 스크립트
```

### 2.2 src/ 디렉토리 구조

#### 2.2.1 src/app/ (페이지 및 API 라우트)
```
src/app/
├── api/                           # API 엔드포인트
│   ├── auth/[...nextauth]/        # NextAuth 핸들러
│   ├── chat/route.ts              # 채팅 메시지 처리 (RAG 포함)
│   ├── upload/route.ts            # 문서 업로드 및 처리
│   ├── report/route.ts            # 보고서 생성 및 템플릿 조회
│   ├── agents/route.ts            # AI 에이전트 관리 (GET/POST)
│   ├── stats/route.ts             # 통계 및 사용량 조회
│   └── forbidden-words/           # 금지어 관리
│       ├── route.ts               # GET (목록), POST (추가)
│       └── [id]/route.ts          # PUT (수정), DELETE (삭제)
├── admin/                         # 관리자 페이지
│   ├── page.tsx                   # 관리자 대시보드
│   ├── agents/                    # 에이전트 관리 페이지
│   ├── documents/                 # 문서 관리 페이지
│   ├── settings/                  # 설정 페이지
│   ├── stats/                     # 통계 페이지
│   ├── templates/                 # 템플릿 관리 페이지
│   ├── users/                     # 사용자 관리 페이지
│   └── logs/                      # 감시 로그 페이지
├── user/                          # 사용자 페이지
│   └── page.tsx                   # 사용자 대시보드
├── employee/                      # 직원 관련 페이지 (미사용 가능성)
├── chat/                          # 채팅 페이지
│   └── page.tsx                   # AI 질의응답 인터페이스
├── report/                        # 보고서 페이지
│   └── page.tsx                   # 보고서 생성 인터페이스
├── login/                         # 로그인 페이지
├── signin/                        # 대체 로그인 페이지
├── layout.tsx                     # 루트 레이아웃 (SessionProvider 포함)
├── page.tsx                       # 메인 페이지 (리다이렉트)
├── globals.css                    # 전역 스타일
└── middleware.ts                  # 인증 미들웨어 (관리자/사용자 경로 보호)
```

#### 2.2.2 src/lib/ (핵심 라이브러리)
```
src/lib/
├── config.ts                      # 환경 변수 관리 및 검증
├── auth.ts                        # 인증 헬퍼 함수
├── nextAuthOptions.ts             # NextAuth 설정 및 Credentials Provider
├── supabase.ts                    # 클라이언트 Supabase (RLS 활성)
├── supabaseAdmin.ts               # 관리자 Supabase (RLS 우회)
├── supabaseClient.ts              # 대체 클라이언트 (구조 불명확)
├── db.ts                          # TypeScript 타입 정의 (13개 타입)
├── claude.ts                      # Claude API 통합
├── embeddings.ts                  # Voyage AI 임베딩
├── document-processor.ts           # 문서 파일 처리 및 청킹
├── rag.ts                         # RAG (정보 검색 및 조립)
├── filter.ts                      # 입력 필터링 (금지어 + 개인정보)
├── forbidden-words.ts             # 금지어 관리 헬퍼
└── openai.ts                      # OpenAI API (미사용, 구현되지 않음)
```

#### 2.2.3 src/components/ (재사용 가능 컴포넌트)
```
src/components/
├── admin/                         # 관리자 UI 컴포넌트
├── chat/                          # 채팅 UI 컴포넌트
├── report/                        # 보고서 UI 컴포넌트
├── Navigation.tsx                 # 주 네비게이션
├── Shell.tsx                      # 페이지 래퍼 레이아웃
└── providers.tsx                  # SessionProvider 래퍼
```

#### 2.2.4 src/types/ 및 기타
```
src/
├── types/next-auth.d.ts           # NextAuth 타입 확장
└── middleware.ts                  # 미들웨어 (경로 보호)
```

### 2.3 supabase/ 디렉토리
```
supabase/
├── migrations/
│   └── 0001_init.sql              # 초기 스키마 마이그레이션
│       - departments 테이블
│       - users 테이블
│       - agents 테이블
│       - documents 테이블 (pgvector with IVFFLAT 인덱스)
│       - conversations 테이블
│       - messages 테이블
│       - report_templates 테이블
│       - forbidden_words 테이블
│       - usage_logs 테이블
└── seed_data.sql                  # MVP 데모 데이터
    - 3개 부서
    - 6개 사용자 (각 부서별 관리자+사용자)
    - 3개 AI 에이전트
    - 3개 보고서 템플릿
    - 6개 금지어
    - 5개 사용 로그 샘플
```

### 2.4 docs/ 디렉토리
```
docs/
├── DATABASE_SCHEMA.md             # DB 스키마 상세 설명
├── PRODUCT_REQUIREMENTS.md        # 제품 요구사항
├── PROJECT_OVERVIEW.md            # 프로젝트 개요
├── SYSTEM_ARCHITECTURE.md         # 시스템 아키텍처
└── USER_FLOWS.md                  # 사용자 흐름
```

---

## 3. 데이터 흐름 분석

### 3.1 전체 데이터 흐름 다이어그램
```
사용자 입력
    ↓
인증 (getServerAuthSession)
    ↓
부서 확인 (department_id)
    ↓
권한 검증 (role check)
    ↓
API/비즈니스 로직
    ↓
데이터베이스 쿼리 (Supabase)
    ↓
응답 (JSON: { ok: true/false, data/error })
```

### 3.2 시나리오별 상세 흐름

#### 🔹 시나리오 1: 문서 업로드 → 임베딩 생성 → DB 저장

**단계별 흐름:**
1. **클라이언트**: 파일 선택 → FormData 생성 → `/api/upload` POST
2. **인증**: `getServerAuthSession()` → 세션 확인 → null이면 401
3. **권한**: `session.user.role === 'ADMIN'` → false면 403
4. **검증**:
   - 파일 타입 확인 (PDF/DOCX/TXT만 허용)
   - 파일 크기 확인 (최대 20MB)
   - agentId 필수 확인
5. **부서 조회**: DB에서 user의 department_id 조회
6. **문서 처리** (`processDocumentFile`):
   - 파일 → 텍스트 추출 (`extractTextFromFile`)
     - PDF: `pdf-parse` 사용
     - DOCX: `mammoth` 사용
     - TXT: UTF-8 디코딩
   - 텍스트 정규화 (공백 정리, 기타 처리)
   - 청킹 (`chunkText`):
     - CHUNK_SIZE = 800 단어
     - CHUNK_OVERLAP = 100 단어
     - 예: 2000단어 → [0-800], [700-1500], [1400-2000] (3개 청크)
   - 각 청크 임베딩 (`getEmbeddings`):
     - Voyage AI API 호출
     - 입력: 청크 텍스트 배열
     - 출력: 1024차원 벡터 배열
   - 평균 임베딩 계산 (`averageEmbedding`)
7. **스토리지 저장**:
   - 경로: `documents/{departmentId}/{timestamp}-{fileName}`
   - Supabase Storage에 업로드
8. **DB 저장**:
   - 테이블: `documents`
   - 데이터:
     ```json
     {
       "department_id": "{deptId}",
       "agent_id": "{agentId}",
       "uploaded_by": "{userId}",
       "storage_path": "documents/...",
       "file_name": "...",
       "title": "...",
       "summary": "첫 250자...",
       "metadata": {
         "chunks": [
           { "index": 0, "text": "...", "embedding": [...] },
           { "index": 1, "text": "...", "embedding": [...] },
           ...
         ],
         "chunk_count": 3
       },
       "embedding": [평균 임베딩 벡터]
     }
     ```
9. **응답**: `{ ok: true, data: { documentId } }`
10. **사용 로그**: `usage_logs` 테이블에 기록

**관련 함수**:
- `processDocumentFile()`: 문서 처리 오케스트레이션
- `extractTextFromFile()`: 파일 타입별 텍스트 추출
- `chunkText()`: 텍스트를 청크로 분할
- `getEmbeddings()`: Voyage AI로 임베딩 생성
- `averageEmbedding()`: 평균 벡터 계산

**관련 테이블**:
- `documents`: 문서 메타데이터 + 청크 + 임베딩
- `usage_logs`: 업로드 이벤트 기록

---

#### 🔹 시나리오 2: 사용자 메시지 → RAG 검색 → Claude 응답

**단계별 흐름**:
1. **클라이언트**: 메시지 입력 → `/api/chat` POST
   ```json
   {
     "agent_id": "{agentId}",
     "message": "...",
     "conversation_id": "{convId or omit}"
   }
   ```
2. **인증**: `getServerAuthSession()` → 403 if not authenticated
3. **검증**: agent_id와 메시지 필수 확인
4. **부서 확인**: user.department_id 조회 → 403 if null
5. **에이전트 검증**:
   - DB에서 agent 조회: `agents.id === agent_id && is_active === true`
   - 권한: `agent.department_id === user.department_id` → 403 if not match
6. **입력 필터링** (`filterUserInput`):
   - 금지어 확인 (`forbidden_words` 조회)
   - 개인정보 패턴 확인 (주민번호/전화/이메일/카드번호/SSN)
   - 400 if blocked
7. **대화 조회 또는 생성**:
   - conversation_id 있으면: 기존 대화 조회
   - 없으면: 새 대화 생성 (`conversations` INSERT)
8. **RAG 검색** (`retrieveRelevantChunks`):
   - 메시지 임베딩: `getEmbeddings([message])`
   - 에이전트의 문서 조회: `documents.agent_id === agent_id`
   - 모든 청크 추출: `metadata.chunks` (각 문서별로)
   - 유사도 계산: `cosineSimilarity(queryEmbedding, chunkEmbedding)`
   - 임계값: 0.72 이상만 선택
   - 상위 5개 선택 (MATCH_COUNT)
   - 결과: `RetrievalResult[]` 반환
9. **Claude 호출** (`callClaudeAPI`):
   - 시스템 프롬프트 구성:
     ```
     agent.system_prompt + "\n\n참고 자료:\n" + [청크 텍스트 목록]
     ```
   - 메시지 구성:
     ```json
     [
       { "role": "user", "content": "사용자 메시지" }
     ]
     ```
   - Claude API 호출:
     - Model: `claude-3-sonnet-20240229`
     - max_tokens: 4096
     - Headers: Anthropic API key
   - 응답 처리: `content[0].text` 추출
10. **응답 조립** (`assembleResponse`):
    ```
    {Claude 응답}

    참고 자료:
    1. {문서제목} (청크 {n}, 유사도 {similarity}%)
    2. ...
    ```
11. **메시지 저장**:
    - `messages` 테이블에 2개 행 INSERT
      - 사용자 메시지 (role: 'user')
      - 어시스턴트 응답 (role: 'assistant', source_references 포함)
12. **사용 로그**:
    ```json
    {
      "action": "chat_message",
      "details": {
        "input_tokens": {...},
        "output_tokens": {...},
        "chunks_retrieved": 3
      }
    }
    ```
13. **응답 반환**:
    ```json
    {
      "ok": true,
      "data": {
        "conversation_id": "{id}",
        "response": "{최종 응답}",
        "chunks": [{...}, ...],
        "usage": { "input_tokens": 1234, "output_tokens": 567 }
      }
    }
    ```

**관련 함수**:
- `filterUserInput()`: 입력 검증 및 필터링
- `retrieveRelevantChunks()`: RAG 검색
- `cosineSimilarity()`: 유사도 계산
- `callClaudeAPI()`: Claude API 호출
- `assembleResponse()`: 응답 조립 (출처 포함)
- `formatSourceReferences()`: 출처 포맷팅

**관련 테이블**:
- `conversations`: 채팅 세션
- `messages`: 메시지 기록
- `documents`: 청크 검색 (metadata.chunks)
- `usage_logs`: 토큰 사용량 기록

**핵심 상수**:
- MATCH_THRESHOLD = 0.72 (코사인 유사도 임계값)
- MATCH_COUNT = 5 (반환할 최대 청크 수)

---

#### 🔹 시나리오 3: 보고서 템플릿 → 폼 데이터 → 보고서 생성

**단계별 흐름**:
1. **클라이언트**: 템플릿 선택 → 폼 작성 → `/api/report` POST
   ```json
   {
     "template_id": "{templateId}",
     "form_data": {
       "project_name": "...",
       "summary": "...",
       ...
     }
   }
   ```
2. **인증**: `getServerAuthSession()` → 403 if not authenticated
3. **검증**: template_id와 form_data 필수
4. **부서 확인**: user.department_id 조회
5. **템플릿 조회**:
   - DB: `report_templates.id === template_id && is_active === true`
   - 권한: `template.department_id === user.department_id` → 403 if not match
6. **템플릿 렌더링**:
   - 템플릿 콘텐츠: `{{field}}` 형식 플레이스홀더
   - form_data로 치함:
     ```
     "사업명: {{project_name}}"
     → "사업명: 2026년 복지사업"
     ```
7. **Claude 호출** (`callClaudeAPI`):
   - 시스템 프롬프트 (고정):
     ```
     당신은 전문적인 비즈니스 보고서 작성자입니다.
     - 정중하고 전문적인 한국어 비즈니스 문체
     - 구조화된 형식 유지
     - 객관적이고 사실 기반
     - 과장이나 불필요한 수사 피하기
     ```
   - 메시지: 렌더링된 템플릿
8. **응답 생성**: Claude가 구조화된 보고서 반환
9. **사용 로그**:
   ```json
   {
     "action": "generate_report",
     "details": {
       "template_name": "...",
       "input_tokens": 1234,
       "output_tokens": 567
     }
   }
   ```
10. **응답 반환**:
    ```json
    {
      "ok": true,
      "data": {
        "report": "...",
        "template_name": "...",
        "usage": { "input_tokens": ..., "output_tokens": ... }
      }
    }
    ```

**관련 함수**:
- `callClaudeAPI()`: Claude로 보고서 생성

**관련 테이블**:
- `report_templates`: 템플릿 정의
- `usage_logs`: 생성 이벤트 기록

---

### 3.3 인증 흐름

**NextAuth.js Credentials Provider 흐름**:
1. 사용자: 로그인 폼 제출 (email + password)
2. NextAuth: `CredentialsProvider.authorize()` 호출
3. Supabase Admin Auth: `auth.signInWithPassword({ email, password })`
4. 성공 시:
   - Supabase Auth 사용자 ID 반환
   - `users` 테이블에서 사용자 조회
   - 없으면: 새 사용자 생성 (role: 'USER', department_id: null)
5. JWT 토큰 생성:
   - `jwt({ token, user })` 콜백: token에 id/role 저장
   - `session({ session, token })` 콜백: session.user에 복사
6. 응답: 세션 쿠키 설정
7. 이후 요청:
   - `getServerAuthSession()`: NextAuth 세션 조회
   - Middleware: JWT 검증 (`getToken({ req, secret })`)
   - Admin 경로: role === 'ADMIN' 확인
   - User 경로: 토큰 존재 확인

**관련 파일**:
- `nextAuthOptions.ts`: Provider 정의
- `auth.ts`: 헬퍼 함수
- `middleware.ts`: 경로 보호

---

## 4. 타입 정의 (db.ts)

### 4.1 주요 타입

```typescript
// API 응답 표준
ApiResponse<T> = { ok: true; data: T } | { ok: false; error: { message: string; code?: string; details?: unknown } }

// 사용자 역할
UserRole = 'ADMIN' | 'USER'
MessageRole = 'system' | 'user' | 'assistant' | 'agent'

// 도메인 타입
Department {
  id: string
  name: string
  slug: string
  description?: string
  created_at: string
  updated_at: string
}

User {
  id: string
  email: string
  full_name?: string
  role: UserRole
  department_id?: string
  created_at: string
  updated_at: string
}

Agent {
  id: string
  department_id: string
  name: string
  description?: string
  system_prompt?: string
  config: Record<string, unknown>
  is_active: boolean
  created_by?: string
  updated_by?: string
  created_at: string
  updated_at: string
}

Document {
  id: string
  department_id: string
  agent_id?: string
  uploaded_by?: string
  storage_path: string
  file_name: string
  file_type?: string
  title?: string
  summary?: string
  metadata: Record<string, unknown>  // { chunks: DocumentChunk[], chunk_count: number }
  created_at: string
  updated_at: string
}

Conversation {
  id: string
  department_id: string
  agent_id?: string
  user_id?: string
  title?: string
  status: string
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
}

Message {
  id: string
  conversation_id: string
  user_id?: string
  role: MessageRole
  content: string
  source_references: Record<string, unknown>  // { chunks: RetrievedChunk[] }
  created_at: string
}

ReportTemplate {
  id: string
  department_id: string
  created_by?: string
  name: string
  description?: string
  content: string  // "사업명: {{project_name}}" 형식
  schema: Record<string, unknown>  // { fields: [{ key, label, type, required }] }
  is_active: boolean
  version: number
  created_at: string
  updated_at: string
}

UsageLog {
  id: string
  department_id?: string
  user_id?: string
  action: string  // 'chat_message', 'upload_document', 'generate_report' 등
  resource_type?: string
  resource_id?: string
  details: Record<string, unknown>  // 동작별 메타데이터
  created_at: string
}

ForbiddenWord {
  id: string
  department_id: string
  word: string
  context?: string
  is_active: boolean
  created_at: string
  updated_at: string
}

DocumentChunk {
  index: number
  text: string
  embedding: number[]  // 1024차원 Voyage 벡터
}

RetrievedChunk {
  documentId: string
  documentTitle?: string
  chunkIndex: number
  text: string
  similarity: number  // 0.0 ~ 1.0 코사인 유사도
}

RetrievalResult {
  query: string
  chunks: RetrievedChunk[]
  totalChunks: number
}
```

---

## 5. 구현된 함수 및 클래스 목록

### 5.1 config.ts
```typescript
function getEnv(key: string, required = true, fallbackKeys: string[] = []): string
  // 환경 변수 조회 (폴백 지원)

const SUPABASE_URL: string
const SUPABASE_ANON_KEY: string
const SUPABASE_SERVICE_ROLE_KEY: string
const NEXTAUTH_URL: string
const NEXTAUTH_SECRET: string
const ANTHROPIC_API_KEY: string
const VOYAGE_API_KEY: string
const SUPABASE_DOCUMENTS_BUCKET: string
const OPENAI_API_KEY: string (NOT REQUIRED - 미사용)
```

### 5.2 auth.ts
```typescript
async function getServerAuthSession(): Promise<Session | null>
  // 서버 세션 조회

async function getAdminSession(): Promise<Session | null>
  // 관리자 세션만 반환

function isAdminSession(session: Session | null): boolean
  // 세션이 관리자인지 확인
```

### 5.3 nextAuthOptions.ts
```typescript
export const authOptions: NextAuthOptions
  // CredentialsProvider 정의
  // authorize(): Supabase Auth + users 테이블 통합
  // callbacks.jwt(): 토큰에 id/role 저장
  // callbacks.session(): session에 id/role 복사
```

### 5.4 supabase.ts
```typescript
export const supabase: SupabaseClient
  // 클라이언트 Supabase (RLS 활성, 세션 미기억)
```

### 5.5 supabaseAdmin.ts
```typescript
export const supabaseAdmin: SupabaseClient
  // 관리자 Supabase (RLS 우회, 세션 미기억)
```

### 5.6 db.ts
- 13개 TypeScript 타입 정의 (위 섹션 4.1 참조)

### 5.7 claude.ts
```typescript
interface ClaudeMessage {
  role: 'user' | 'assistant'
  content: string
}

interface ClaudeResponse {
  content: string
  usage: { input_tokens: number; output_tokens: number }
}

async function callClaudeAPI(
  messages: ClaudeMessage[],
  systemPrompt?: string,
  maxTokens = 4096
): Promise<ClaudeResponse>
  // Claude API 호출 래퍼
  // Model: claude-3-sonnet-20240229
  // Returns: 응답 텍스트 + 토큰 사용량
```

### 5.8 embeddings.ts
```typescript
async function getEmbeddings(inputs: string[]): Promise<number[][]>
  // Voyage AI로 텍스트를 1024차원 벡터로 변환
  // Model: voyage-3
```

### 5.9 document-processor.ts
```typescript
const CHUNK_SIZE = 800
const CHUNK_OVERLAP = 100

function normalizeText(text: string): string
  // 텍스트 정규화 (공백, 줄바꿈 처리)

async function extractTextFromFile(
  fileBuffer: Buffer,
  mimeType: string,
  fileName: string
): Promise<string>
  // PDF/DOCX/TXT → 텍스트 추출

function chunkText(text: string): string[]
  // 텍스트 → 청크 배열 (800단어, 100단어 오버랩)

function averageEmbedding(vectors: number[][]): number[]
  // 벡터 배열 → 평균 벡터

async function processDocumentFile(
  fileBuffer: Buffer,
  mimeType: string,
  fileName: string
): Promise<{
  text: string
  chunks: DocumentChunk[]
  summary: string
  averageEmbedding: number[]
}>
  // 문서 처리 오케스트레이션
```

### 5.10 rag.ts
```typescript
const MATCH_THRESHOLD = 0.72
const MATCH_COUNT = 5

function cosineSimilarity(a: number[], b: number[]): number
  // 코사인 유사도 계산 (0.0 ~ 1.0)

async function retrieveRelevantChunks(
  agentId: string,
  query: string
): Promise<RetrievalResult>
  // RAG 검색:
  // 1. query → 임베딩
  // 2. 에이전트의 문서 조회
  // 3. 모든 청크 유사도 계산
  // 4. 임계값 0.72 이상 필터
  // 5. 상위 5개 반환

function formatSourceReferences(chunks: RetrievedChunk[]): string
  // 청크 배열 → 출처 문자열

function assembleResponse(
  query: string,
  chunks: RetrievedChunk[],
  aiResponse: string
): string
  // AI 응답 + 출처 정보 → 최종 응답
```

### 5.11 filter.ts
```typescript
const PERSONAL_INFO_PATTERNS: RegExp[]
  // 주민번호, 전화, 이메일, 카드번호 등

interface FilterResult {
  isValid: boolean
  blockedWords: string[]
  blockedPatterns: string[]
  filteredText: string
}

async function filterUserInput(
  departmentId: string,
  text: string
): Promise<FilterResult>
  // 입력 검증:
  // 1. DB에서 금지어 조회
  // 2. 개인정보 패턴 검사
  // returns: 유효 여부 + 차단 이유

function sanitizeText(text: string): string
  // 개인정보 → '[개인정보 마스킹]'으로 치환
```

### 5.12 forbidden-words.ts
```typescript
async function getForbiddenWords(departmentId: string): Promise<ForbiddenWord[]>
  // 부서의 금지어 목록 조회

async function addForbiddenWord(
  departmentId: string,
  word: string,
  context?: string
): Promise<ForbiddenWord>
  // 금지어 추가 (중복 체크)

async function toggleForbiddenWord(
  wordId: string,
  departmentId: string,
  isActive: boolean
): Promise<ForbiddenWord>
  // 금지어 활성화/비활성화

async function deleteForbiddenWord(
  wordId: string,
  departmentId: string
): Promise<void>
  // 금지어 삭제
```

### 5.13 openai.ts
```typescript
async function fetchOpenAiResponse(prompt: string)
  // ❌ 미구현 (TODO 댓글만 있음)
  // 반환: { answer, prompt }
```

---

## 6. 아직 구현되지 않은 부분

### 6.1 API 엔드포인트

| 엔드포인트 | 메서드 | 상태 | 비고 |
|-----------|--------|------|------|
| `/api/chat` | POST | ✅ | 채팅 메시지 처리 |
| `/api/upload` | POST | ✅ | 문서 업로드 |
| `/api/report` | POST | ✅ | 보고서 생성 |
| `/api/report` | GET | ✅ | 템플릿 목록 |
| `/api/agents` | GET | ✅ | 에이전트 목록 |
| `/api/agents` | POST | ✅ | 에이전트 생성 |
| `/api/agents/[id]` | PUT | ❌ | 에이전트 수정 |
| `/api/agents/[id]` | DELETE | ❌ | 에이전트 삭제 |
| `/api/forbidden-words` | GET | ✅ | 금지어 목록 |
| `/api/forbidden-words` | POST | ✅ | 금지어 추가 |
| `/api/forbidden-words/[id]` | PUT | ✅ (파일 존재) | 금지어 수정 |
| `/api/forbidden-words/[id]` | DELETE | ✅ (파일 존재) | 금지어 삭제 |
| `/api/stats` | GET | ✅ (미완성) | 통계 조회 |

### 6.2 페이지 및 UI

| 경로 | 상태 | 비고 |
|-----|------|------|
| `/admin` | ⚠️ 구조만 | 대시보드 디자인 필요 |
| `/admin/agents` | ❌ | 에이전트 관리 UI 미구현 |
| `/admin/documents` | ❌ | 문서 관리 UI 미구현 |
| `/admin/templates` | ❌ | 템플릿 관리 UI 미구현 |
| `/admin/users` | ❌ | 사용자 관리 UI 미구현 |
| `/admin/settings` | ❌ | 설정 페이지 UI 미구현 |
| `/admin/stats` | ❌ | 통계 대시보드 UI 미구현 |
| `/admin/logs` | ❌ | 감시 로그 UI 미구현 |
| `/user` | ⚠️ 구조만 | 사용자 대시보드 UI 필요 |
| `/chat` | ⚠️ 구조만 | 채팅 인터페이스 UI 필요 |
| `/report` | ⚠️ 구조만 | 보고서 생성 UI 필요 |

### 6.3 기능

- ❌ 에이전트 수정/삭제 (API 및 UI)
- ❌ 문서 삭제/메타데이터 수정
- ❌ 대화 기록 조회 (목록 및 상세)
- ❌ 보고서 히스토리 (생성된 보고서 목록)
- ❌ 보고서 템플릿 수정/삭제
- ❌ 사용자 관리 (생성/수정/삭제)
- ❌ 토큰 사용량 추적 및 할당량 관리
- ❌ 보고서 PPTX/PDF 내보내기 (텍스트만 반환)

### 6.4 미구현된 라이브러리 함수
- `openai.ts::fetchOpenAiResponse()` - TODO 주석만 있음

---

## 7. 잠재적 충돌 및 위험 지점

### 7.1 🔴 CRITICAL: API 응답 형식 불일치

**문제점**:
- 4개 API 라우트에서 `{ success: true/false }` 사용
- 표준은 `{ ok: true/false }` (CLAUDE.md)
- 클라이언트가 `ok` 필드 기대 → 응답 파싱 실패

**영향받는 파일**:
```
❌ src/app/api/agents/route.ts (GET, POST)
❌ src/app/api/report/route.ts (POST, GET)
❌ src/app/api/forbidden-words/route.ts (GET, POST)
❌ src/app/api/stats/route.ts (GET)
```

**수정 필요**: `success` → `ok`로 변경

---

### 7.2 🔴 CRITICAL: OpenAI API 키 필수 설정

**문제점**:
- `config.ts`에서 `OPENAI_API_KEY` 필수로 처리
- 하지만 코드에서 사용 안 함 (Claude만 사용)
- 프로덕션에서 환경 변수 없으면 시작 실패

**오류**:
```
Error: Missing required environment variable: OPENAI_API_KEY
```

**수정 필요**:
1. `OPENAI_API_KEY`를 선택 항목으로 변경
2. 또는 파일 제거 (`openai.ts`)

---

### 7.3 ⚠️ HIGH: 혼합된 인증 패턴

**문제점**:
- 일부 라우트: `getServerSession(authOptions)` 직접 호출
- 다른 라우트: `getServerAuthSession()` 헬퍼 사용
- NextAuth 권장: 헬퍼만 사용

**영향받는 파일**:
```
❌ src/app/api/agents/route.ts (lines 9-12, 61-64)
❌ src/app/api/forbidden-words/route.ts (lines 8-11, 57-60)
```

**수정 필요**: 모두 `getServerAuthSession()` 사용으로 통일

---

### 7.4 ⚠️ HIGH: DB 테이블 불일치

**문제점**:
- 초기 마이그레이션: `conversations`, `messages` 사용
- `stats.ts` API: `chat_sessions`, `chat_messages` 조회 시도
- 테이블명이 다름

**영향받는 파일**:
```
src/app/api/stats/route.ts (line ~20: chat_sessions, chat_messages)
```

**실제 테이블**:
- `conversations` (chat_sessions 아님)
- `messages` (chat_messages 아님)

**수정 필요**: `stats.ts`의 테이블명 수정

---

### 7.5 ⚠️ MEDIUM: 부서 확인 일관성 부족

**문제점**:
- 일부 라우트: `maybeSingle()` → null 가능
- 다른 라우트: `single()` → 오류 발생
- 부서 미할당 사용자 처리 방식 불명확

**영향받는 파일**:
```
src/app/api/agents/route.ts (maybeSingle 후 직접 사용)
src/app/api/stats/route.ts (maybeSingle 후 직접 사용)
src/app/api/chat/route.ts (single 사용)
```

**개선**: 모두 `single()` 사용 + 명확한 오류 처리

---

### 7.6 ⚠️ MEDIUM: API 에러 응답 형식 불일치

**문제점**:
- 일부 라우트: `{ ok: false, error: { message } }`
- 일부 라우트: `{ success: false, error: { message } }`
- 클라이언트가 처리 불가

**예시**:
```typescript
// ✅ 올바른 형식
{ ok: false, error: { message: "..." } }

// ❌ 잘못된 형식
{ success: false, error: { message: "..." } }
```

---

### 7.7 ⚠️ MEDIUM: 임베딩 벡터 차원 명시 부족

**문제점**:
- `documents` 테이블: `embedding vector(1024)`
- 코드: 1024 하드코딩 (변수 없음)
- Voyage API 변경 시 불일치 가능

**위험**: 향후 다른 프로바이더로 변경 시 유지보수 어려움

---

### 7.8 ⚠️ MEDIUM: RAG 임계값 문서화 부족

**문제점**:
- `rag.ts`: `MATCH_THRESHOLD = 0.72` (고정)
- 어떻게 이 값을 선택했는지 문서 없음
- 조정 필요 시 근거 불명확

**개선**: 임계값 선택 이유 문서화 필요

---

### 7.9 🔵 LOW: supabaseClient 사용 불분명

**문제점**:
```
src/lib/supabaseClient.ts (존재하지만 사용처 불명)
```
- 파일 존재하지만 임포트된 곳 없음
- `supabase.ts`와의 차이점 불명확

**개선**: 파일 삭제 또는 목적 명시

---

### 7.10 🔵 LOW: 에러 로깅 부족

**문제점**:
- 일부 라우트는 `console.error()` 사용
- 다른 라우트는 로깅 없음
- 프로덕션 디버깅 어려움

**개선**: 중앙화된 로깅 시스템 필요

---

### 7.11 🔵 LOW: 보고서 저장 미구현

**문제점**:
- `/api/report` POST: 보고서 텍스트만 반환
- DB에 저장하지 않음 (report_generations 테이블 미사용)
- 히스토리/감시 불가능

---

## 8. 의존성 관계도

### 8.1 계층별 의존성

```
┌─────────────────────────────────────┐
│     클라이언트 (React 컴포넌트)      │
└────────────────┬────────────────────┘
                 │
                 ↓
┌─────────────────────────────────────┐
│   API 라우트 (src/app/api/)         │
│ - chat, upload, report, agents 등  │
└────────────────┬────────────────────┘
                 │
        ┌────────┼────────┐
        ↓        ↓        ↓
    ┌─────────────────────────────┐
    │  Core 라이브러리 (lib/)     │
    ├─────────────────────────────┤
    │ • config.ts (env vars)      │
    │ • auth.ts (auth helpers)    │
    │ • nextAuthOptions.ts (auth) │
    │ • claude.ts (LLM)           │
    │ • embeddings.ts (AI)        │
    │ • document-processor.ts     │
    │ • rag.ts (retrieval)        │
    │ • filter.ts (validation)    │
    │ • forbidden-words.ts        │
    └────────────┬────────────────┘
                 │
        ┌────────┴────────┐
        ↓                 ↓
    ┌──────────────┐  ┌─────────────┐
    │  Supabase    │  │ Voyage AI   │
    │  (Database)  │  │ (Embeddings)│
    └──────────────┘  └─────────────┘
                      ┌─────────────┐
                      │ Claude API  │
                      │ (LLM)       │
                      └─────────────┘
```

### 8.2 파일별 임포트 의존성

**중요 임포트 경로**:

```
chat/route.ts
├─ auth.ts (getServerAuthSession)
├─ supabase.ts (사용자/에이전트/대화/메시지)
├─ claude.ts (callClaudeAPI)
├─ rag.ts (retrieveRelevantChunks)
├─ filter.ts (filterUserInput)
└─ db.ts (타입)

upload/route.ts
├─ auth.ts
├─ supabaseAdmin.ts (저장소 업로드)
├─ document-processor.ts (파일 처리)
├─ embeddings.ts (벡터 생성)
└─ config.ts (SUPABASE_DOCUMENTS_BUCKET)

report/route.ts
├─ auth.ts
├─ supabase.ts (템플릿 조회)
├─ claude.ts (보고서 생성)
└─ db.ts (타입)

agents/route.ts
├─ nextAuthOptions.ts (⚠️ 직접 임포트 - 비권장)
├─ auth.ts (권장)
└─ supabase.ts (에이전트 조회/생성)

stats/route.ts
├─ auth.ts
└─ supabase.ts (통계 조회)

forbidden-words/route.ts
├─ auth.ts
├─ supabase.ts (금지어 조회/관리)
└─ forbidden-words.ts (헬퍼)
```

---

## 9. 데이터베이스 스키마 요약

### 9.1 테이블 관계도

```
departments (부서)
    ├─ users (사용자)
    ├─ agents (AI 에이전트)
    ├─ documents (문서)
    ├─ conversations (대화)
    ├─ report_templates (보고서 템플릿)
    ├─ forbidden_words (금지어)
    └─ usage_logs (사용 로그)

users
    ├─ documents (uploaded_by)
    ├─ conversations (user_id)
    ├─ messages (user_id)
    ├─ agents (created_by, updated_by)
    └─ usage_logs (user_id)

agents
    └─ documents (agent_id)
    └─ conversations (agent_id)

conversations
    └─ messages (conversation_id)
    └─ documents (암시적, RAG)

report_templates
    └─ usage_logs (resource_id)
```

### 9.2 주요 인덱스

```
departments
  - PK: id
  - UNIQUE: slug

users
  - PK: id
  - UNIQUE: email
  - INDEX: department_id, role

agents
  - PK: id
  - UNIQUE: (department_id, name)
  - INDEX: department_id

documents
  - PK: id
  - INDEX: department_id, agent_id, uploaded_by
  - IVFFLAT (embedding)  ← 벡터 검색 인덱스

conversations
  - PK: id
  - INDEX: department_id, agent_id, user_id

messages
  - PK: id
  - INDEX: conversation_id, user_id, role

report_templates
  - PK: id
  - UNIQUE: (department_id, name)
  - INDEX: department_id

usage_logs
  - PK: id
  - INDEX: department_id, user_id, action, created_at
```

---

## 10. 외부 서비스 및 API 통합

### 10.1 Supabase
- **사용처**: 인증, 데이터베이스, 파일 저장
- **인증**: JWT 기반
- **클라이언트**: 2개
  - `supabase.ts`: 클라이언트 (RLS 활성)
  - `supabaseAdmin.ts`: 관리자 (RLS 우회)

### 10.2 Claude API (Anthropic)
- **모델**: claude-3-sonnet-20240229
- **용도**: 채팅 응답, 보고서 생성
- **토큰**: max_tokens = 4096
- **헤더**: Authorization: Bearer {API_KEY}, anthropic-version: 2023-06-01

### 10.3 Voyage AI
- **모델**: voyage-3
- **용도**: 텍스트 임베딩 (1024 차원)
- **배치 처리**: 여러 텍스트 동시 임베딩

### 10.4 NextAuth.js
- **제공자**: Credentials Provider
- **콜백**: jwt(), session()
- **저장소**: HTTP-only 쿠키

---

## 11. 환경 변수

### 11.1 필수 변수

```
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://[project-ref].supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=[anon-key]
SUPABASE_SERVICE_ROLE_KEY=[service-role-key]

# NextAuth
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=[32+ 문자 랜덤 문자열]

# AI APIs
ANTHROPIC_API_KEY=sk-ant-v1-...
VOYAGE_API_KEY=voyage-...

# Storage
NEXT_PUBLIC_SUPABASE_DOCUMENTS_BUCKET=documents
```

### 11.2 선택 변수

```
# 현재 미사용 (제거 권장)
OPENAI_API_KEY=...
```

---

## 12. 성능 고려사항

### 12.1 청킹 전략
- **청크 크기**: 800 단어
- **오버랩**: 100 단어
- **영향**: 검색 정확도 ↔ 처리 시간 트레이드오프

### 12.2 임베딩
- **모델**: Voyage AI (1024 차원)
- **배치 처리**: 여러 청크를 한 요청에
- **저장**: 문서의 `metadata.chunks` + `embedding` 필드

### 12.3 RAG 임계값
- **유사도 임계값**: 0.72
- **반환 최대 개수**: 5개
- **영향**: 관련성 높은 결과 필터링

### 12.4 DB 인덱스
- **IVFFLAT**: 벡터 검색 인덱스 (lists=100)
- **일반 인덱스**: 주요 조회 열 모두 인덱싱됨

---

## 13. 요약 및 권장사항

### 13.1 즉시 수정 필요 (CRITICAL)

1. **API 응답 형식 통일** (success → ok)
   - 파일: agents/(get/post), report/(get/post), forbidden-words/(get/post), stats/
   - 우선순위: 🔴 필수

2. **OPENAI_API_KEY 제거**
   - 파일: config.ts, openai.ts
   - 방법: 선택 항목 변경 또는 파일 삭제
   - 우선순위: 🔴 필수

3. **인증 패턴 통일**
   - 파일: agents/, forbidden-words/
   - 변경: getServerSession(authOptions) → getServerAuthSession()
   - 우선순위: 🔴 필수

### 13.2 중기 개선 (HIGH)

1. **DB 테이블명 확인**
   - stats.ts: chat_sessions → conversations, chat_messages → messages
   
2. **에러 응답 형식 검증**
   - 모든 라우트 감시

3. **부서 확인 일관성**
   - maybeSingle() → single()로 통일

### 13.3 장기 개선 (MEDIUM)

1. **UI 페이지 구현**
   - 관리자 대시보드
   - 문서/에이전트/템플릿 관리
   - 사용자 대시보드

2. **기능 구현**
   - 에이전트 수정/삭제
   - 보고서 저장 및 히스토리
   - 사용자 관리

3. **보고서 내보내기**
   - PPTX/PDF 생성

### 13.4 아키텍처 개선

1. **벡터 차원 설정 변수화**
   - EMBEDDING_DIMENSION = 1024

2. **임계값 설정화**
   - env 또는 config.ts에서 관리

3. **중앙화된 로깅**
   - 모든 라우트에서 구조화된 로깅

4. **에러 처리 표준화**
   - 커스텀 에러 클래스 정의

---

## 14. 결론

WORKON은 기본 아키텍처가 잘 설계된 다중 테넌트 SaaS 플랫폼이며, RAG 기반 AI Q&A 기능이 핵심입니다. 다만 프로덕션 배포 전 **3개의 CRITICAL 이슈**를 반드시 해결해야 하며, 그 외 HIGH/MEDIUM 이슈들도 순차적으로 개선이 필요합니다.

**CRITICAL 이슈 해결 소요 시간**: 약 30분
**전체 프로덕션 준비**: 2-3주 (UI 구현 포함)
