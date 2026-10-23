# S4-a — 참고 문서를 NODA로 옮기기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 비서 참고 문서의 읽기·검색을 Voyage·pgvector에서 NODA(국내)로 옮긴다. 업로드는 '읽는 중'으로 버티고, 대화는 근거 없이 답하지 않는다.

**Architecture:** `src/lib/noda.ts`(fetch 클라이언트, 재시도·시간 제한) 위에 `document-reading.ts`(읽기 상태 전이·맞추기)와 `document-upload.ts`(직접 올리기 검사)를 둔다.
라우트는 얇게: 주소 발급 → 브라우저가 Supabase에 직접 → 확인(행 `reading`) → 읽기 라우트(Supabase → NODA). 대화는 `doc_search` 능력이
대화를 만들기 **전**(preflight)에 NODA `/context`를 불러, 못 부르면 대화를 만들지 않고 거절한다.

**Tech Stack:** Next.js 14 App Router · TypeScript · Supabase(service role, Storage 서명 업로드) · vitest · NODA HTTP API(`https://api.readlayer.kr`)

**Spec:** `docs/superpowers/specs/2026-10-21-s4-noda-document-layer-design.md` (S4-a 범위 = 10절 첫 행). 4·5·6·8·9·11절이 이 계획의 근거다.

## Global Constraints

- 외부 API는 SDK 없이 `fetch`로 (`src/lib/noda.ts`). 환경 변수는 `src/lib/config.ts` 경유 — `NODA_API_URL`(기본 `https://api.readlayer.kr`) · `NODA_API_KEY`(선택: 없으면 빌드는 되고 호출 때 `NodaError('missing_key')`)
- **NODA 키를 로그·오류 글·응답에 싣지 않는다.** 오류 글에 요청 머리(Authorization)를 넣지 않는다
- 보관함 이름 = `workon-a{agent_id에서 하이픈 뺀 32자}` — **서버가 비서 id로만 만든다.** 요청값으로 보관함·파일 이름을 받지 않는다
- NODA 파일 이름 = `{document_id}__{원래 파일 이름}` — 원래 확장자를 **그대로** 둔다(NODA는 `.txt`·`.csv`·`.tsv`를 확장자로 가린다). 변환하지 않는다
- 업로드는 **항상 `replace=1`**. `X-Filename`은 `encodeURIComponent`로
- 시간: NODA 업로드 한 번 5분(`300_000`ms), 업로드 재시도 창 1분(`60_000`), `/context` 재시도 창 10초(`10_000`)·간격 2.5초(`2_500`), 그 밖 호출 재시도 창 10초. 재시도 대상 = HTTP 429·502·503·네트워크 오류. `Retry-After`(초)를 따르되 창을 넘기면 멈춘다
- `/context` 요청: `budget: 4000`, `min_similarity: 0.80` — 상수 `NODA_MIN_SIMILARITY`(실측 표를 주석에, 테스트가 0.80~0.82 고정)
- 읽기 상태: `reading` · `ready` · `failed`(다시 시도 가능) · `unreadable`(NODA `readable:false` — 다시 시도해도 같음) · `deleting`(NODA 삭제 실패). `NULL` = 옮기기 전(옛 문서)
- 읽는 중 다시 걸기 `READ_KICK_AFTER_MS = 120_000`, 포기 `READ_GIVE_UP_MS = 600_000`, 직접 올리기 확인 창 `DOCUMENT_CONFIRM_WINDOW_MS = 600_000`
- 고정 문구(그대로):
  - 대화 거절: `참고 문서를 지금 불러오지 못했습니다 — 잠시 뒤 다시 물어 주세요`
  - 거절 뒤 버튼: `다시 묻기` · `문서 없이 일반 답변 받기`
  - 일반 답변 표시: `참고 문서 없이 답함`
  - 읽기 포기 이유: `읽기가 너무 오래 걸려 멈췄습니다. 다시 시도해 주세요.`
  - 삭제 실패: `문서 보관소에서 지우지 못했습니다. 잠시 뒤 다시 지워 주세요.`
  - 인용 규칙 추가 줄: `- 참고 자료에 질문의 답이 없으면 지어내지 말고 "문서에서 찾지 못했습니다"라고 답하세요.`
- 모델이 보는 글과 화면에 `{document_id}__` 앞부분이 나오면 안 된다
- 오류 응답은 `{ ok: false, error: { message } }`(한국어). 새 라우트의 **모든 핸들러**에 인증, 비서를 바꾸는 핸들러에는 `agent-permissions` 판정(`tests/agent-route-permissions.test.ts`의 목록에 추가)
- 배치 insert 행은 **모두 같은 키 집합**(CLAUDE.md)
- 마이그레이션 0031은 **사용자가 적용**한다(코드 배포 전). 이 계획은 SQL 파일만 만든다. 푸시하지 않는다
- 커밋 메시지 끝: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (하위 에이전트는 자기 이름을 넣지 않는다)

## Review Focus

1. 이름에 한글·공백·괄호·대문자 확장자가 있는 파일(`2026 예산(최종).CSV`) — `X-Filename`이 인코딩되고 NODA 파일 이름에 `.CSV`가 그대로 남는다 → Task 1·3 테스트
2. 읽는 도중 문서를 지움 — 읽기가 끝나 행이 없으면 NODA 사본을 지워 고아를 남기지 않는다 → Task 2 테스트
3. 문서가 하나도 없는(또는 `ready`가 없는) 비서와 NODA 장애 중에 대화 — NODA를 부르지 않고 평소처럼 답한다 → Task 6 테스트
4. 두 탭·두 번 클릭으로 같은 문서 읽기가 동시에 걸림 — NODA 업로드는 한 번만 나간다(조건부 갱신으로 차지) → Task 2 테스트
5. NODA 근거에 이 비서의 문서가 아닌 조각이 섞임(버그·보관함 혼선) — 근거 전체를 버리고 '근거 없음'으로, 운영 기록 critical → Task 6 테스트

## 판정(설계와 다르게/더 정한 것)

- **R1** `noda_status`에 `unreadable`을 더하고, 칸 `noda_last_attempt_at`을 더한다. `noda_read_started_at`은 '이번 읽기 시작'(확인·다시 시도 때만), `noda_last_attempt_at`은 'NODA에 보낸 마지막 때'(다시 걸기 판정). 설계 9절을 Task 8에서 고친다
- **R2** 상태 조회 라우트(`GET /api/documents/{id}`)를 만들지 않는다. 문서 목록(`GET /api/documents`)이 맞추기를 하고 화면은 목록을 다시 부른다. 문서를 보여 주는 화면은 `DocumentsManager` 하나뿐이다
- **R3** '다시 걸기'는 서버가 직접 하지 못한다(Vercel은 응답 뒤 일을 이어 가지 못함). 목록 응답이 오래된 `reading` 행 **최대 하나**에 `kick: true`를 달고, 그 목록을 받은 화면이 읽기 라우트를 부른다. 읽기 라우트의 조건부 갱신이 중복을 막는다. **알려진 공백**: 아무도 목록을 열지 않으면 멈춘 행은 다음에 목록을 열 때까지 `reading`이다(클라우드 서버로 옮기면 예약 작업으로 바꾼다)
- **R4** 대화 거절은 대화를 만들기 **전**에 한다 — 능력에 `preflight` 단계를 둔다. 기존 원칙("거절될 요청으로 빈 대화가 쌓이지 않게")과 같고, 새 대화의 첨부가 묶였다 지워지지 않는다
- **R5** NODA 근거는 DB에서 **이 비서의 행**과 맞춰 본다. 행이 없는 조각이 하나라도 있으면 근거 전체를 버린다(Review Focus 5). `deleting` 행의 조각은 남긴다(지우는 중)
- **R6** `ready` 문서가 없는 비서는 NODA를 부르지 않는다(Review Focus 3)
- **R7** 새 문서는 `summary` NULL, `metadata` `{}`, `embedding` NULL — 읽기는 NODA가 한다
- **R8** 업로드 라우트(`/api/upload`)는 지운다. 거기 있던 검사(위험한 이름·막는 확장자·형식·크기·권한·개수)는 `document-upload.ts`로 옮겨 발급·확인 두 곳이 쓴다. 업로드 경로의 스캔 판독(Anthropic)과 `document_ocr` 기록은 여기서 사라진다(`pdf-ocr.ts` 파일 자체와 `document-processor.ts`는 S4-b가 지운다)
- **R9** `/verify`용 원 출처 보관은 S4-b에서 한다(YAGNI)

---

### Task 1: NODA 클라이언트 · 설정

**Files:**
- Create: `src/lib/noda.ts`
- Modify: `src/lib/config.ts` (끝에 NODA 두 줄), `.env.example` (`NODA_API_URL=`·`NODA_API_KEY=` 빈 값과 한 줄 설명)
- Test: `tests/noda-client.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const NODA_MIN_SIMILARITY = 0.8;
  export const NODA_CONTEXT_BUDGET = 4000;
  export function nodaTenant(agentId: string): string;            // uuid가 아니면 throw
  export function nodaFilename(documentId: string, fileName: string): string; // '/' '\\' 와 제어 문자는 '_'로, 확장자 유지
  export function documentIdFromNodaFilename(name: string): string | null;
  export function stripNodaPrefixes(text: string): string;        // 모든 'uuid__' 앞부분 제거
  export class NodaError extends Error { status: number | null; code: 'missing_key' | 'http' | 'network' | 'timeout' }
  export interface NodaUploadResult { tenant: string; filename: string; bytes: number; stored: boolean; doc_id: string | null; readable: boolean; reason: string | null; chunks: number; cache_purged?: number }
  export interface NodaListing { documents: { filename: string; doc_id?: string }[]; receiving: { filename: string; seconds: number }[] }
  export interface NodaAnchor { page?: number; bbox?: unknown; cell_range?: string | null }
  export interface NodaSource { n: number; chunk_id: string; doc_id: string; filename: string; kind?: string; path?: string; outline?: string | string[] | null; anchors?: NodaAnchor[]; extractors?: string[]; score?: number; similarity?: number; found_by?: string; chars?: number; cut?: boolean }
  export interface NodaContextResult { context: string; sources: NodaSource[]; dropped: number }
  export interface NodaClient {
    uploadDocument(input: { tenant: string; filename: string; bytes: Uint8Array }): Promise<NodaUploadResult>;
    listDocuments(tenant: string): Promise<NodaListing>;
    deleteDocument(tenant: string, filename: string): Promise<{ deleted: boolean }>; // 404 → { deleted: false }, throw 안 함
    getContext(input: { tenant: string; query: string }): Promise<NodaContextResult>;
    getHealth(): Promise<Record<string, unknown>>;
  }
  export function createNodaClient(deps: { baseUrl: string; apiKey: string; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => number }): NodaClient;
  export const noda: NodaClient; // config 값으로 만든 기본 인스턴스(키가 비면 호출마다 NodaError('missing_key'))
  ```
  응답 칸 이름은 `https://api.readlayer.kr/openapi.json`을 따른다. 위에 없는 칸은 무시하고, 목록·근거 응답에 칸이 빠지면 빈 배열·0으로 채운다.

- [ ] **Step 1: 실패하는 테스트 쓰기** — `tests/noda-client.test.ts` (가짜 `fetch`·`sleep`·`now`로)

  ```ts
  it('보관함 이름은 비서 id로만 — 하이픈을 뺀 32자', () => {
    expect(nodaTenant('3f2a1b4c-0000-4000-8000-00000000abcd')).toBe('workon-a3f2a1b4c00004000800000000000abcd');
    expect(() => nodaTenant('../workon')).toThrow();
    expect(() => nodaTenant('')).toThrow();
  });
  it('NODA 파일 이름은 문서 id + 원래 이름, 확장자를 지킨다', () => {
    const id = '11111111-2222-4333-8444-555555555555';
    expect(nodaFilename(id, '2026 예산(최종).CSV')).toBe(`${id}__2026 예산(최종).CSV`);
    expect(nodaFilename(id, 'a/b\\c.txt')).toBe(`${id}__a_b_c.txt`);
    expect(documentIdFromNodaFilename(`${id}__x.pdf`)).toBe(id);
    expect(documentIdFromNodaFilename('x.pdf')).toBeNull();
  });
  it('근거 글에서 문서 id 앞부분을 모두 뗀다', () => {
    const id = '11111111-2222-4333-8444-555555555555';
    expect(stripNodaPrefixes(`[1] ${id}__규정.hwp p.3\n[2] ${id}__표.xlsx!A1:B2`)).toBe('[1] 규정.hwp p.3\n[2] 표.xlsx!A1:B2');
  });
  it('업로드는 항상 replace=1, X-Filename 인코딩, Bearer', async () => { /* 요청 URL에 tenant=…&replace=1, 머리 X-Filename === encodeURIComponent(이름), Authorization === 'Bearer k' */ });
  it('503 두 번 뒤 성공하면 결과를 돌려준다(업로드 창 1분 안)', async () => { /* fetch 호출 3번, sleep이 불림 */ });
  it('Retry-After가 창을 넘기면 기다리지 않고 NodaError(http, 429)', async () => { /* Retry-After: 120, 업로드 창 60초 → sleep 120000을 부르지 않음 */ });
  it('401은 다시 시도하지 않는다', async () => { /* fetch 1번, NodaError status 401 */ });
  it('getContext는 budget 4000·min_similarity 0.8을 싣고, 10초 창을 2.5초 간격으로', async () => { /* 본문 JSON 확인, 네트워크 오류 계속이면 now가 10초 넘을 때 NodaError('network') */ });
  it('getContext 응답에 dropped가 없으면 0, sources가 없으면 []', async () => {});
  it('deleteDocument 404는 deleted:false로 끝난다', async () => {});
  it('listDocuments는 receiving이 없어도 빈 배열', async () => {});
  it('키가 비면 fetch 없이 NodaError(missing_key)', async () => {});
  it('오류 글에 키가 없다', async () => { /* 500 응답 → err.message에 'k-secret' 미포함 */ });
  it('NODA_MIN_SIMILARITY는 실측 구간 0.80~0.82 안', () => {
    expect(NODA_MIN_SIMILARITY).toBeGreaterThanOrEqual(0.8);
    expect(NODA_MIN_SIMILARITY).toBeLessThanOrEqual(0.82);
  });
  ```

- [ ] **Step 2: 실패 확인** — `npx vitest run tests/noda-client.test.ts` → 모듈 없음으로 FAIL
- [ ] **Step 3: `src/lib/noda.ts` 구현** — 재시도는 내부 함수 하나(`withRetry(attempt, { windowMs, intervalMs })`)로: 429·502·503·네트워크 오류면 `Retry-After`(없으면 간격; 업로드·기타 기본 간격 3초) 뒤 다시, 다음 시도가 창을 넘으면 마지막 오류를 던진다. 한 번의 시간 제한은 `AbortSignal.timeout`(업로드 300초, 그 밖 30초) → `NodaError('timeout')`이며 시간 제한은 재시도하지 않는다. 비-2xx 오류 글은 `NODA {status}: {본문 앞 200자}`. `config.ts`에 `NODA_API_URL = process.env.NODA_API_URL ?? 'https://api.readlayer.kr'`, `NODA_API_KEY = getEnv('NODA_API_KEY', false)`. `NODA_MIN_SIMILARITY` 주석에 설계 5절의 실측 표(0.80/0.81/0.82 세 줄)를 옮긴다
- [ ] **Step 4: 통과 확인** — `npx vitest run tests/noda-client.test.ts` → PASS
- [ ] **Step 5: 커밋** — `git add src/lib/noda.ts src/lib/config.ts .env.example tests/noda-client.test.ts && git commit -m "feat: NODA 클라이언트 — 보관함·파일 이름 규칙, 재시도·시간 제한"`

### Task 2: 마이그레이션 0031 · 읽기 상태 전이

**Files:**
- Create: `supabase/migrations/0031_documents_noda.sql`, `src/lib/document-reading.ts`
- Modify: `src/lib/db.ts` (`Document` 타입에 `noda_status`·`noda_reason`·`noda_filename`·`noda_doc_id`·`noda_read_started_at`·`noda_last_attempt_at`·`noda_read_at` — 모두 `string | null`, `noda_status`는 `NodaStatus | null`)
- Test: `tests/document-reading.test.ts`

**Interfaces:**
- Consumes: Task 1 `noda`·`nodaTenant`·`NodaListing`·`NodaError`
- Produces:
  ```ts
  export type NodaStatus = 'reading' | 'ready' | 'failed' | 'unreadable' | 'deleting'; // db.ts에 둔다
  export const READ_KICK_AFTER_MS = 120_000;
  export const READ_GIVE_UP_MS = 600_000;
  export const READ_TIMEOUT_REASON = '읽기가 너무 오래 걸려 멈췄습니다. 다시 시도해 주세요.';
  export interface ReadingRow { id: string; agent_id: string | null; noda_status: NodaStatus | null; noda_filename: string | null; noda_read_started_at: string | null; noda_last_attempt_at: string | null; created_at: string }
  export type ReadDecision = 'ready' | 'reading' | 'kick' | 'give_up';
  export function decideReadState(row: ReadingRow, listing: NodaListing, now: number): ReadDecision;
  export type ReadOutcome = { status: NodaStatus | 'not_found' | 'busy'; reason?: string | null };
  export function readDocument(documentId: string, opts?: { retry?: boolean }, deps?: ReadingDeps): Promise<ReadOutcome>;
  export function reconcileReading<T extends ReadingRow>(rows: T[], deps?: ReadingDeps): Promise<(T & { kick?: true })[]>;
  export function startReadingFields(now: Date): { noda_status: 'reading'; noda_read_started_at: string; noda_last_attempt_at: null; noda_reason: null };
  ```
  `ReadingDeps`는 DB·저장소·NODA·시계를 감싼 주입 객체(기본값은 `supabaseAdmin`·`SUPABASE_DOCUMENTS_BUCKET`·`noda`·`Date.now`). 모양은 구현자가 정하되 테스트가 가짜로 바꿀 수 있어야 한다.

- [ ] **Step 1: 0031 SQL 쓰기** — 0030처럼 머리 주석(설계 경로, **배포 순서: 이 파일 → `npm run noda:migrate` → S4-a 코드**, NULL은 옮기기 전 문서). 내용:
  ```sql
  ALTER TABLE documents
    ADD COLUMN IF NOT EXISTS noda_status text CHECK (noda_status IN ('reading','ready','failed','unreadable','deleting')),
    ADD COLUMN IF NOT EXISTS noda_reason text,
    ADD COLUMN IF NOT EXISTS noda_filename text UNIQUE,
    ADD COLUMN IF NOT EXISTS noda_doc_id text,
    ADD COLUMN IF NOT EXISTS noda_read_started_at timestamptz,
    ADD COLUMN IF NOT EXISTS noda_last_attempt_at timestamptz,
    ADD COLUMN IF NOT EXISTS noda_read_at timestamptz;
  CREATE INDEX IF NOT EXISTS documents_agent_noda_status_idx ON documents(agent_id, noda_status);
  ```
- [ ] **Step 2: 실패하는 테스트 쓰기** — `tests/document-reading.test.ts`
  ```ts
  describe('decideReadState', () => {
    // row: started 0, last_attempt null, filename 'F'
    it('receiving에 있으면 reading — documents에도 옛 판이 있어도', () => expect(decideReadState(row, { documents: [{ filename: 'F' }], receiving: [{ filename: 'F', seconds: 5 }] }, 60_000)).toBe('reading'));
    it('documents에 있으면 ready', ...);                 // → 'ready'
    it('둘 다 없고 마지막 시도가 2분 넘었으면 kick', ...); // now = 120_001 → 'kick'
    it('둘 다 없어도 2분 전이면 reading', ...);           // now = 119_999 → 'reading'
    it('시작 10분이 지났고 documents에 없으면 give_up', ...); // now = 600_001, receiving 비어 → 'give_up'
    it('10분이 지나도 NODA가 아직 받는 중이면 reading', ...); // receiving에 있음 → 'reading'
  });
  describe('readDocument', () => {
    it('Supabase 원본을 NODA로 보내고 readable이면 ready', ...);            // upload 1번, 행 ready·noda_doc_id·noda_read_at
    it('readable:false면 unreadable + reason(200자에서 자름)', ...);
    it('같은 문서를 동시에 두 번 불러도 NODA 업로드는 한 번', ...);           // 두 번째는 { status: 'busy' }, upload 1번
    it('읽기가 끝났는데 행이 지워졌으면 NODA 사본을 지운다', ...);           // markReady가 0행 → deleteDocument 1번
    it('NodaError면 reading 그대로 두고 던지지 않는다', ...);                // 다음 맞추기·다시 걸기에 맡김
    it('원본이 20MB를 넘으면 NODA로 보내지 않고 unreadable', ...);          // MAX_UPLOAD_BYTES
    it('retry는 failed만 받는다 — 시작 시각을 새로 찍고 읽는다', ...);       // unreadable·ready에 retry → 바꾸지 않음
    it('비서 없는 문서는 보내지 않는다', ...);                              // agent_id null → { status: 'not_found' }
  });
  describe('reconcileReading', () => {
    it('보관함마다 목록을 한 번만 부르고, ready·give_up을 행에 쓴다', ...);
    it('kick 대상이 여럿이면 가장 오래된 하나에만 kick', ...);
    it('목록 호출이 실패하면 그 보관함 행은 그대로', ...);
    it('한 번에 보관함 5개까지만 본다', ...);
  });
  ```
- [ ] **Step 3: 실패 확인** — `npx vitest run tests/document-reading.test.ts` → FAIL
- [ ] **Step 4: `src/lib/document-reading.ts` 구현**
  - 차지(claim): `update ... set noda_last_attempt_at = now where id = $1 and noda_status = 'reading' and (noda_last_attempt_at is null or noda_last_attempt_at < now - READ_KICK_AFTER_MS)` → 0행이면 `busy`. retry면 먼저 `failed`인 행만 `startReadingFields`로 바꾼 뒤 차지
  - 상태를 쓰는 갱신은 모두 `.eq('noda_status', 'reading')` 조건 — 그 사이 지워졌거나(`deleting`) 다른 경로가 끝냈으면 덮지 않는다. ready 갱신이 0행이고 행이 아예 없으면 NODA 사본을 지운다
  - NodaError는 `system_logs`(category `api`, level `warning`)에 `{ document_id, code, status }`만 — 파일 이름을 남기지 않는다
  - 맞추기: `reading` 행만, `agent_id`별 묶음, 보관함 최대 5개(`MAX_TENANTS_PER_RECONCILE = 5`) 차례로
- [ ] **Step 5: 통과 확인** — `npx vitest run tests/document-reading.test.ts` → PASS, `npx tsc --noEmit` 통과
- [ ] **Step 6: 커밋** — `feat: 문서 읽기 상태 — 0031, 차지·맞추기·다시 걸기·고아 정리`

### Task 3: 직접 올리기 — 주소 발급 · 확인 · 읽기 라우트

**Files:**
- Create: `src/lib/document-upload.ts`, `src/app/api/documents/upload-url/route.ts`, `src/app/api/documents/confirm/route.ts`, `src/app/api/documents/[id]/read/route.ts`
- Delete: `src/app/api/upload/route.ts`
- Modify: `tests/agent-route-permissions.test.ts` (목록에서 upload 빼고 `upload-url` POST·`confirm` POST·`[id]/read` POST 추가, '고른 비서 전부' 테스트는 `document-upload.ts`를 본다), `tests/agent-guide.test.ts` ('업로드 상한은 한 곳에만'의 파일을 `src/lib/document-upload.ts`로), `tests/pdf-ocr.test.ts` ('업로드 라우트가 정책으로 모델을…' 테스트를 지운다 — 업로드 경로에 판독이 없다. 판독 함수 테스트는 S4-b까지 둔다)
- Test: `tests/document-upload.test.ts`

**Interfaces:**
- Consumes: Task 1 `nodaFilename`; Task 2 `startReadingFields`·`readDocument`
- Produces:
  ```ts
  export const DOCUMENT_CONFIRM_WINDOW_MS = 600_000;
  export function checkUploadFile(input: { fileName: string; size: number; mimeType: string }): { ok: true; ext: string } | { ok: false; status: 400 | 413 | 415; message: string; securityReason?: 'dangerous_filename' | 'blocked_extension' };
  export function documentStoragePath(input: { departmentId: string; userId: string; ext: string; now: number; id: string }): string; // `documents/{dept}/{user}/{now}-{id}.{ext}`
  export function parseDocumentStoragePath(path: string): { departmentId: string; userId: string; issuedAt: number; ext: string } | null;
  export function checkUploadTargets(agentIds: unknown, actor: ActorScope): Promise<{ ok: true; agentIds: string[]; targets: Map<string, AgentAccessInfo> } | { ok: false; status: number; message: string }>; // 중복 제거·권한(canEditAgent)·비서당 개수(MAX_AGENT_DOCUMENTS)
  export function buildNewDocumentRows(input: { ids: string[]; agentIds: string[]; targets: Map<string, AgentAccessInfo>; departmentId: string; userId: string; storagePath: string; fileName: string; fileType: string | null; title: string; visibility: 'organization' | 'department'; now: Date }): Record<string, unknown>[];
  ```
  라우트:
  - `POST /api/documents/upload-url` 본문 `{ file_name, size, file_type, agent_ids }` → 검사 전부(인증·소속·대상 비서·파일) → `createSignedUploadUrl(path)` → `{ ok: true, data: { path, token } }`. 위험한 이름·막는 확장자는 지금처럼 `logSecurityEvent(..., 'high')`
  - `POST /api/documents/confirm` 본문 `{ storage_path, file_name, file_type, title?, visibility?, agent_ids }` → 경로가 요청자 것(부서·사용자 일치)이고 발급 10분 안인지 → 같은 `storage_path` 행이 이미 있으면 409 → 저장소 크기(`list(dir, { search })`의 `metadata.size`)가 없거나 `MAX_UPLOAD_BYTES` 초과면 객체를 지우고 413, 지난 확인은 객체를 지우고 410 → 대상 비서·파일 다시 검사 → 행 insert(Task 2 상태, 행마다 `crypto.randomUUID()` id와 `noda_filename`) → 비서마다 `recordAgentEvent('document_added')`·`enableAgentCapability('doc_search')` → `{ ok: true, data: { documentIds } }`
  - `POST /api/documents/[id]/read` 본문 `{ retry?: boolean }`, `maxDuration = 300` → 문서를 요청자 기관으로 한정해 읽고 → retry면 `canEditAgent`(그 문서의 비서), 아니면 `canReadDocument` → `readDocument` → `{ ok: true, data: ReadOutcome }`(`not_found`면 404)

- [ ] **Step 1: 실패하는 테스트 쓰기** — `tests/document-upload.test.ts`
  ```ts
  it('위험한 이름·막는 확장자·허용 밖 형식·20MB 초과를 거른다', () => {
    expect(checkUploadFile({ fileName: '../a.pdf', size: 1, mimeType: 'application/pdf' })).toMatchObject({ ok: false, status: 400, securityReason: 'dangerous_filename' });
    expect(checkUploadFile({ fileName: 'a.exe', size: 1, mimeType: '' })).toMatchObject({ ok: false, status: 415 });
    expect(checkUploadFile({ fileName: 'a.pdf', size: 20 * 1024 * 1024 + 1, mimeType: 'application/pdf' })).toMatchObject({ ok: false, status: 413 });
    expect(checkUploadFile({ fileName: '2026 예산(최종).CSV', size: 10, mimeType: 'text/csv' })).toEqual({ ok: true, ext: 'csv' });
    expect(checkUploadFile({ fileName: '메모.txt', size: 10, mimeType: 'text/plain' })).toMatchObject({ ok: true });
  });
  it('저장소 경로는 부서·사용자·발급 시각을 담고 다시 읽힌다', () => {
    const p = documentStoragePath({ departmentId: 'd', userId: 'u', ext: 'pdf', now: 1700000000000, id: 'x' });
    expect(p).toBe('documents/d/u/1700000000000-x.pdf');
    expect(parseDocumentStoragePath(p)).toEqual({ departmentId: 'd', userId: 'u', issuedAt: 1700000000000, ext: 'pdf' });
    expect(parseDocumentStoragePath('documents/d/1700000000000-x.pdf')).toBeNull(); // 옛 경로
    expect(parseDocumentStoragePath('chat-uploads/o/u/x.pdf')).toBeNull();
  });
  it('새 문서 행은 모두 같은 키 집합 · reading · 행마다 다른 NODA 파일 이름(원래 이름 그대로)', () => { /* buildNewDocumentRows 두 비서(공식·부서) → Object.keys 같음, noda_filename === `${ids[i]}__2026 예산(최종).CSV`, summary null, metadata {}, embedding null, 부서 비서 행은 visibility 'department' */ });
  ```
  라우트 단위: `tests/document-upload.test.ts`에 원본 읽기 검사 하나 — confirm 라우트 원본에 `DOCUMENT_CONFIRM_WINDOW_MS`·`parseDocumentStoragePath`·`MAX_UPLOAD_BYTES`가 있고, read 라우트에 `maxDuration = 300`이 있다.
- [ ] **Step 2: 실패 확인** — `npx vitest run tests/document-upload.test.ts` → FAIL
- [ ] **Step 3: 구현** — 검사 순서와 문구는 지운 `/api/upload`의 것을 그대로 옮긴다(형식 415 문구 `지원되지 않는 파일 형식입니다. ${UPLOAD_FORMATS_LABEL}만 허용됩니다.` 등). 비서당 개수는 `deleting` 행도 센다
- [ ] **Step 4: 통과 확인** — `npm test` 전체 PASS(옮긴 테스트 포함), `npx tsc --noEmit` 통과
- [ ] **Step 5: 커밋** — `feat: 참고 문서 직접 올리기 — 주소 발급·확인·읽기 라우트, /api/upload 제거`

### Task 4: 목록 맞추기 · 삭제 순서 · 다른 비서에 붙이기

**Files:**
- Modify: `src/app/api/documents/route.ts` (GET·DELETE), `src/app/api/documents/assign/route.ts`, `src/lib/document-files.ts` (`buildAssignedDocumentRow`)
- Test: `tests/document-routes.test.ts` (새로), 기존 assign 관련 테스트가 있으면 함께 고침

**Interfaces:**
- Consumes: Task 1 `noda`·`nodaTenant`·`nodaFilename`; Task 2 `reconcileReading`·`startReadingFields`
- Produces:
  - `GET /api/documents` 행에 `noda_status`·`noda_reason`이 더해지고, 맞추기 뒤 최대 한 행에 `kick: true`
  - `DELETE /api/documents` 순서: (NODA에 간 적 있는 행 = `agent_id`와 `noda_filename`이 있고 `noda_status`가 NULL이 아님) NODA `deleteDocument` → 실패면 `noda_status='deleting'`으로 바꾸고 502 `문서 보관소에서 지우지 못했습니다. 잠시 뒤 다시 지워 주세요.` → 성공·404면 DB 행 삭제 → `removeStorageFileIfUnused`
  - `buildAssignedDocumentRow(src, target, id: string, now: Date)` — `id`·`noda_filename`(`nodaFilename(id, src.file_name)`)·`startReadingFields(now)`를 넣고 `metadata` `{}`·`embedding` NULL. 키 집합은 모든 행이 같다
  - `POST /api/documents/assign` 응답 `{ ok: true, data: { added, documentIds } }`

- [ ] **Step 1: 실패하는 테스트 쓰기** — `tests/document-routes.test.ts`
  ```ts
  it('붙인 행은 새 id·자기 NODA 파일 이름·reading이고 키 집합이 같다', () => { /* buildAssignedDocumentRow 공식·부서 두 비서 */ });
  it('삭제는 NODA → DB → 원본 순서', () => { /* DELETE 원본 글에서 deleteDocument 위치 < from('documents').delete() 위치 < removeStorageFileIfUnused 위치 */ });
  it('NODA 삭제가 실패하면 행을 지우지 않고 deleting', () => { /* 원본 글에 noda_status: 'deleting' 와 정한 문구 */ });
  it('목록은 reading 행을 맞추고 noda_status를 싣는다', () => { /* GET 원본 글에 reconcileReading, select에 noda_status */ });
  ```
  (이 파일의 라우트 검사는 기존 `agent-route-permissions.test.ts`처럼 원본 글을 읽는 방식이다 — 라우트를 실행하는 장치가 이 저장소에 없다. 순서·조건의 동작은 Task 2의 함수 테스트가 맡는다.)
- [ ] **Step 2: 실패 확인** → FAIL
- [ ] **Step 3: 구현** — GET은 `visibilityFilter` 범위 안 행만 맞춘다(범위를 넓히지 않음). 맞추기 실패는 목록을 막지 않는다
- [ ] **Step 4: 통과 확인** — `npm test` PASS, `npx tsc --noEmit`
- [ ] **Step 5: 커밋** — `feat: 문서 목록 상태 맞추기·NODA 먼저 지우기·붙인 문서 새로 읽기`

### Task 5: 화면 — 올리기 · 읽는 중 · 다시 시도

**Files:**
- Create: `src/lib/browser-storage.ts` (`storageClient()` — `attachments/upload-client.ts`에서 옮김, 그 파일은 이것을 import), `src/lib/document-upload-client.ts`
- Modify: `src/components/admin/DocumentsManager.tsx`, `src/components/chat/CreateAgentModal.tsx`, `src/lib/attachments/upload-client.ts`
- Test: `tests/document-upload-client.test.ts`, `tests/attachments-upload-client.test.ts`(옮긴 뒤에도 통과), `tests/config-public-guard.test.ts`(새 화면 모듈이 `config.ts`를 가져오지 않음 — 가드 대상 목록에 `document-upload-client.ts`·`browser-storage.ts`를 더한다)

**Interfaces:**
- Consumes: Task 3·4 라우트
- Produces:
  ```ts
  export type DocumentUploadStage = 'uploading' | 'registering';
  export function uploadReferenceDocument(file: File, meta: { agentIds: string[]; title?: string; visibility?: 'organization' | 'department' }, onStage?: (s: DocumentUploadStage) => void): Promise<{ ok: true; documentIds: string[] } | { ok: false; message: string }>;
  export function startReading(documentIds: string[], opts?: { retry?: boolean }): void; // 차례로 POST /api/documents/{id}/read, keepalive: true, 기다리지 않음·오류 삼킴
  ```

- [ ] **Step 1: 실패하는 테스트 쓰기** — `tests/document-upload-client.test.ts` (가짜 fetch와 supabase-js 흉내는 `attachments-upload-client.test.ts`와 같은 방식)
  ```ts
  it('발급 → 저장소 직접 → 확인 순서, 확인한 문서 id를 돌려준다', ...);
  it('발급 거절 문구를 그대로 돌려준다', ...);
  it('저장소 올리기가 실패하면 확인을 부르지 않는다', ...);
  it('startReading은 keepalive로 문서마다 읽기 라우트를 부른다', ...);   // fetch(`/api/documents/${id}/read`, { method: 'POST', keepalive: true, ... })
  it('화면 검사: 20MB 초과는 발급 전에 거절', ...);
  ```
- [ ] **Step 2: 실패 확인** → FAIL
- [ ] **Step 3: 구현**
  - `DocumentsManager`: 올리기 → `uploadReferenceDocument` → `startReading(ids)`, 안내 `문서를 올렸습니다. 읽는 중입니다 — 다 읽으면 비서가 찾을 수 있습니다.` 붙이기(assign) 성공 뒤에도 `startReading(data.documentIds)`
  - 행 상태 표시: `reading` 칩 `읽는 중`, `failed` `읽기 실패` + 버튼 `다시 시도`(→ `startReading([id], { retry: true })` 후 목록 다시), `unreadable` `읽지 못함 — {noda_reason}`(버튼 없음), `deleting` `삭제 대기` + 삭제 버튼 그대로(누르면 다시 지움), `ready`·NULL은 표시 없음
  - `reading` 행이 하나라도 있으면 5초마다 목록을 다시 부른다(없으면 멈춤, 화면을 떠나면 멈춤). 목록 행에 `kick`이 있으면 그 id를 이 화면에서 **한 번만** `startReading`
  - `CreateAgentModal`: 파일마다 `uploadReferenceDocument(file, { agentIds: [agentId] })` → `startReading`. 하나라도 실패하면 비서는 만들어졌다는 사실과 실패한 파일 이름을 오류 칸에 보이고 창을 닫지 않는다
- [ ] **Step 4: 통과 확인** — `npm test` PASS, `npx tsc --noEmit`
- [ ] **Step 5: 커밋** — `feat: 문서 화면 — 직접 올리기·읽는 중 표시·다시 시도·다시 걸기`

### Task 6: 대화 — `doc_search`를 NODA `/context`로

**Files:**
- Modify: `src/lib/capabilities/types.ts`, `src/lib/capabilities/doc-search.ts`, `src/lib/assistant/prepare.ts`, `src/lib/assistant/types.ts`, `src/lib/assistant/persist.ts`, `src/lib/assistant/stream.ts`, `src/lib/db.ts` (`RetrievedChunk`), `src/app/api/rag-test/route.ts`, `src/app/api/chat/route.ts`(거절의 `code`를 `error.code`로 싣는지 확인, 없으면 더함)
- Test: `tests/capabilities.test.ts`(doc_search 부분 고침), `tests/doc-search-noda.test.ts`(새로), `tests/prepare-attachments.test.ts` 또는 새 `tests/prepare-preflight.test.ts`, `tests/message-persistence.test.ts`, `tests/stream-turn.test.ts`

**Interfaces:**
- Consumes: Task 1 `noda.getContext`·`nodaTenant`·`stripNodaPrefixes`·`documentIdFromNodaFilename`·`NodaError`·`NodaSource`
- Produces:
  ```ts
  // capabilities/types.ts
  export interface PreflightInput { organizationId: string; agentId: string; message: string; skipDocuments: boolean }
  export type PreflightResult = { ok: true; carry?: unknown } | { ok: false; status: number; message: string; code: string };
  // Capability에: preflight?(input: PreflightInput): Promise<PreflightResult>;
  // TurnContext에: preflight: Partial<Record<CapabilityId, unknown>>; skipDocuments: boolean;
  // PrepareResult에: dropped?: number; documentsSkipped?: boolean;
  // db.ts RetrievedChunk에 선택 칸: page?: number | null; cellRange?: string | null; section?: string | null; ocr?: boolean;
  // doc-search.ts
  export const DOCUMENTS_UNAVAILABLE_MESSAGE = '참고 문서를 지금 불러오지 못했습니다 — 잠시 뒤 다시 물어 주세요';
  export const DOCUMENTS_UNAVAILABLE_CODE = 'documents_unavailable';
  export interface ReadyDocument { id: string; title: string | null; file_name: string; noda_status: NodaStatus }
  export interface DocSearchDeps { documentsOf(agentId: string): Promise<ReadyDocument[]>; fetchContext(agentId: string, query: string): Promise<NodaContextResult> }
  export function sourcesToChunks(sources: NodaSource[], docs: ReadyDocument[]): RetrievedChunk[] | null; // 이 비서 행이 없는 조각이 하나라도 있으면 null
  export function docSearchAddendum(input: { context: string | null; chunks: RetrievedChunk[]; hasDocuments: boolean; skipped: boolean }): string | undefined;
  export function searchAgentDocuments(agentId: string, query: string, deps?: DocSearchDeps): Promise<{ chunks: RetrievedChunk[]; dropped: number }>; // rag-test가 쓴다
  // PreparedTurn에: documentsSkipped: boolean; docDropped: number | null;
  // MessageRowInput에: documentsSkipped: boolean;
  ```
  - `documentsOf`: 이 비서의 행 중 `noda_status in ('ready','deleting')` (`ready`가 하나도 없으면 '문서 없음'으로 친다)
  - 요청 본문 `skip_documents === true`일 때만 건너뛴다(다른 값은 false)

- [ ] **Step 1: 실패하는 테스트 쓰기** — `tests/doc-search-noda.test.ts`
  ```ts
  const id = '11111111-2222-4333-8444-555555555555';
  it('근거를 쪽·칸·절·스캔 판독이 붙은 chunk로', () => {
    const chunks = sourcesToChunks([{ n: 1, chunk_id: 'c1', doc_id: 'd', filename: `${id}__규정.hwp`, outline: ['제3장', '여비'], anchors: [{ page: 12 }], extractors: ['ocr'], similarity: 0.86 },
                                    { n: 2, chunk_id: 'c2', doc_id: 'd2', filename: `${id}__표.csv`, anchors: [{ page: 0, cell_range: '표.csv!A3:D20' }], similarity: 0.83 }],
                                   [{ id, title: '여비 규정', file_name: '규정.hwp', noda_status: 'ready' }])!;
    expect(chunks[0]).toMatchObject({ documentId: id, documentTitle: '여비 규정', chunkIndex: 0, page: 12, section: '제3장 › 여비', ocr: true, similarity: 0.86 });
    expect(chunks[1]).toMatchObject({ page: null, cellRange: '표.csv!A3:D20', ocr: false });
  });
  it('이 비서 행이 없는 조각이 섞이면 null(근거 전체를 버림)', ...);
  it('deleting 행의 조각은 남긴다', ...);
  it('preflight: ready 문서가 없으면 NODA를 부르지 않는다', ...);              // fetchContext 0번, ok
  it('preflight: NODA가 끝내 실패하면 503 documents_unavailable, 정한 문구', ...);
  it('preflight: skipDocuments면 NODA를 부르지 않는다', ...);
  it('prepare: 근거 글의 문서 id 앞부분이 모델에 가지 않는다', ...);             // systemAddendum에 `${id}__` 없음
  it('prepare: sources가 비면 [문서 검색 결과 없음]', ...);
  it('prepare: 섞인 근거는 [문서 검색 결과 없음] + system_logs critical', ...);
  it('prepare: skip이면 일반 답변 안내와 documentsSkipped', ...);              // addendum에 '참고 문서 없이' 포함
  it('인용 규칙에 "문서에서 찾지 못했습니다" 줄이 있다', ...);                   // Global Constraints의 줄 그대로
  ```
  `tests/prepare-preflight.test.ts`: `prepareTurn`이 preflight 거절이면 **대화를 insert하지 않고** 첨부도 묶지 않으며 `{ ok:false, status:503, details:{ code:'documents_unavailable' } }`를 돌려준다(기존 `prepare-attachments.test.ts`의 가짜 supabase 방식을 따른다).
  `tests/message-persistence.test.ts`: `documentsSkipped`가 참이면 답변 행 `source_references.documents_skipped === true`, 거짓이면 키가 없고, 두 행 키 집합은 같다. chunk의 `page`·`cellRange`·`section`·`ocr`가 저장된다.
  `tests/stream-turn.test.ts`: 대화 사용 기록 `details.doc_dropped`가 실린다(없으면 null).
- [ ] **Step 2: 실패 확인** → FAIL
- [ ] **Step 3: 구현**
  - `prepareTurn`: 금지어 검사 뒤·대화 블록 **앞**에서 켜진 능력의 `preflight`를 차례로 부른다. 거절이면 `reject(message, status, { code })`. 결과 `carry`는 `ctx.preflight[cap.id]`로
  - `doc_search.preflight`: skip → `{ ok:true, carry:{ skipped:true } }`; `documentsOf`에 `ready`가 없으면 `{ ok:true, carry:{ docs:[] } }`; 아니면 `fetchContext`(NodaError → 거절, `system_logs` api warning에 `{ agent_id, code, status }`); 성공 → `carry:{ docs, result }`
  - `doc_search.prepare`: carry로 addendum·chunks·dropped를 만든다. 근거 묶음은 `stripNodaPrefixes(result.context)`를 `참고 자료:` 아래에 그대로. 섞인 근거(`sourcesToChunks` null)는 '근거 없음' + `system_logs` critical(`{ agent_id, source_count }`)
  - skip addendum:
    ```
    [참고 문서 없이 답함]
    직원이 참고 문서를 찾지 않고 일반 답변을 요청했습니다. 답의 첫머리에 이 답이 기관 자료에 근거하지 않는다고 밝히세요.
    구체적인 수치·자격요건·기한은 지어내지 말고 어디서 확인해야 하는지 안내하세요.
    ```
  - `rag-test` 라우트: `searchAgentDocuments`로 바꾸고 응답 `data.chunks`·`data.dropped`. 관리자 검사·요청자 기관의 비서인지 확인(지금 없음 — `loadAgentAccess` 후 기관 비교) 추가
  - `doc-search.ts`는 더 이상 `rag.ts`를 import하지 않는다
- [ ] **Step 4: 통과 확인** — `npm test` PASS, `npx tsc --noEmit`
- [ ] **Step 5: 커밋** — `feat: 문서 찾기를 NODA /context로 — 하한 0.80, 못 부르면 답하지 않음, 문서 없이 일반 답변`

### Task 7: 대화 화면 — 거절 안내 · 일반 답변 · 쪽·절 출처

**Files:**
- Modify: `src/components/chat/ChatInterface.tsx`, `src/components/chat/MessageBubble.tsx`, `src/components/chat/SourceCitation.tsx`
- Test: `tests/chat-documents-ui.test.ts`(새로 — 순수 함수만), 화면 확인은 수동(사용자 몫)

**Interfaces:**
- Consumes: Task 6 응답 `error.code === 'documents_unavailable'`, `source_references.documents_skipped`, chunk의 `page`·`cellRange`·`section`·`ocr`
- Produces (`src/components/chat/source-label.ts`):
  ```ts
  export function sourceLocationLabel(c: { page?: number | null; cellRange?: string | null; section?: string | null; chunkIndex: number; similarity: number }): string;
  // page 있으면 'p.12 · 제3장 › 여비', cellRange면 '표.csv!A3:D20', 둘 다 없고 section만이면 section, 셋 다 없으면 옛 표시 '청크 N • 유사도: X%'
  ```

- [ ] **Step 1: 실패하는 테스트 쓰기** — `tests/chat-documents-ui.test.ts`
  ```ts
  it('쪽과 절', () => expect(sourceLocationLabel({ page: 12, section: '제3장 › 여비', chunkIndex: 0, similarity: 0.8 })).toBe('p.12 · 제3장 › 여비'));
  it('칸 주소', () => expect(sourceLocationLabel({ page: null, cellRange: '표.csv!A3:D20', chunkIndex: 1, similarity: 0.8 })).toBe('표.csv!A3:D20'));
  it('옛 메시지는 옛 표시', () => expect(sourceLocationLabel({ chunkIndex: 2, similarity: 0.456 })).toBe('청크 3 • 유사도: 45.6%'));
  it('NODA 파일 이름 앞부분은 보이지 않는다', () => { /* cellRange 'uuid__표.csv!A1' → '표.csv!A1' (stripNodaPrefixes는 화면에서도 쓸 수 있게 noda.ts가 아니라 source-label.ts에 같은 정규식을 둔다 — noda.ts는 config.ts를 가져온다) */ });
  ```
- [ ] **Step 2: 실패 확인** → FAIL
- [ ] **Step 3: 구현**
  - `ChatInterface`: JSON 거절의 `error.code`가 `documents_unavailable`이면 답변 자리에 안내 말풍선(문구 = 서버 메시지)과 버튼 `다시 묻기`(같은 질문·같은 첨부로 다시 보냄)·`문서 없이 일반 답변 받기`(같은 요청 + `skip_documents: true`). 사용자 말풍선은 지우지 않는다. 대화가 만들어지지 않았으므로 `conversation_id`는 보내던 값 그대로
  - 일반 답변으로 받은 답에는 말풍선 위 작은 표시 `참고 문서 없이 답함` — 이번 응답은 보낸 요청으로, 지난 대화는 `source_references.documents_skipped`로(숫자 확인 `number_check`를 읽는 자리와 같은 곳)
  - `SourceCitation`: 위치 줄을 `sourceLocationLabel`로, `ocr`면 `스캔 판독` 배지(원문과 다르게 읽혔을 수 있다는 `title` 툴팁). 조각 글(`text`)이 비면 미리보기 칸을 그리지 않는다
- [ ] **Step 4: 통과 확인** — `npm test` PASS, `npx tsc --noEmit`, `npx next lint`가 있으면 통과
- [ ] **Step 5: 커밋** — `feat: 대화 화면 — 문서 불러오기 실패 안내·일반 답변 표시·쪽·절 출처`

### Task 8: 옮기기·점검 스크립트 · 문서

**Files:**
- Create: `scripts/noda-migrate.mjs`, `scripts/noda-check.mjs`
- Modify: `package.json` (`"noda:migrate": "tsx scripts/noda-migrate.mjs"`, `"noda:check": "tsx scripts/noda-check.mjs"`), `CLAUDE.md`, `docs/superpowers/specs/2026-10-21-s4-noda-document-layer-design.md`(9절 칸 목록을 R1대로, 4절 상태 조회를 R2대로), `docs/superpowers/specs/2026-10-14-workon-service-definition-design.md`(6절 표 아래와 8.5절에 백업 7일)
- Test: 없음(스크립트는 실서버용). `npm test`·`npx tsc --noEmit`·`npx next build`로 확인

**Interfaces:**
- Consumes: Task 1 `createNodaClient`·`nodaTenant`·`nodaFilename`; Task 2 `readDocument`·`startReadingFields`
- 두 스크립트 모두 `scripts/connector-probe.mjs`처럼 `.env.local`을 먼저 읽고 `../src/lib/*.ts`를 동적 import. **키·`DATABASE_URL`을 출력하지 않는다**

- [ ] **Step 1: `scripts/noda-migrate.mjs`** — `agent_id`가 있고 `noda_status`가 NULL인 행: `noda_filename = nodaFilename(id, file_name)`·`startReadingFields`로 바꾼 뒤 `readDocument(id)`를 차례로. 문서마다 `id 앞 8자 · 결과 상태 · 이유`를 한 줄로(파일 이름은 찍지 않음). `--dry-run`이면 대상 수만. `agent_id` NULL 행은 '비서 없음 — 건너뜀' 수만 센다
- [ ] **Step 2: `scripts/noda-check.mjs`** — ① `/health`: `search.vectors`가 참이 아니면 실패, `llm.external`이 참이면 **실패**(`운영 서버에 바깥 LLM 연결이 남아 있습니다 — 보안 자료에 '바깥 연결 없음'을 쓰지 마세요`) ② `--roundtrip`이면 보관함 `workon-check`에 작은 글 파일(`noda-check.txt`, 한국어 세 줄)을 올림 → `/context`로 그 내용을 물어 근거가 나오고 쪽·출처가 있는지 → 엉뚱한 질문(`김치찌개 맛있게 끓이는 법`)은 `sources`가 비는지 → 삭제 → 목록에서 사라졌는지. 단계마다 `OK`/`FAIL` 한 줄, 하나라도 FAIL이면 종료 코드 1
- [ ] **Step 3: CLAUDE.md 고치기** — 스택 표(임베딩 줄 → `NODA(국내) — 읽기·OCR·검색, Voyage는 S4-b까지 남음`), 디렉터리(`noda.ts`·`document-reading.ts`·`document-upload.ts`), 검증 장치 표에 `noda:check`·`noda:migrate`, 마이그레이션 표에 0031(**코드 배포 전, 그 뒤 `npm run noda:migrate`**), 'RAG 파이프라인' 절의 업로드·채팅 흐름을 NODA로(하한 0.80 두 겹·못 부르면 답하지 않음·보관함 = 비서·삭제 순서·백업 7일), 환경 변수에 `NODA_API_URL`·`NODA_API_KEY`, 테스트 표에 새 테스트 파일들, 테스트 수 갱신
- [ ] **Step 4: 확인** — `npm test` 전체 PASS(수 기록), `npx tsc --noEmit`, `npx next build` 통과
- [ ] **Step 5: 커밋** — `feat: NODA 옮기기·점검 스크립트, 문서 갱신`

---

## 배포 메모 (사용자 몫, 실행 순서)

1. `.env.local`과 Vercel에 `NODA_API_KEY`(필요하면 `NODA_API_URL`)를 직접 넣는다
2. `npm run noda:check -- --roundtrip` — 모두 OK인지. S4-a 배포 전 한 번: 큰 문서(45MB 브로슈어)를 올리고 호출을 일찍 끊은 뒤 `receiving` → `documents`로 옮겨 가는지(설계 4절 시간 제한 전제)
3. 마이그레이션 0031 적용
4. 코드 푸시(배포 확인)
5. 곧바로 `npm run noda:migrate` — 기존 문서 2건을 NODA로. **푸시 뒤에 돌린다**(최종 검토 판정 G): 옛 코드는 문서를 지울 때 NODA 사본을 지우지 않아, 먼저 옮기면 배포 전까지 지운 문서가 NODA에 고아로 남는다. 푸시와 이 단계 사이에는 옛 문서(noda_status NULL)가 근거로 쓰이지 않는다(비서는 문서 없이 답함) — 사이를 짧게 둔다
6. 문서 화면에서 올리기·읽는 중·삭제, 대화에서 근거·쪽 번호·엉뚱한 질문의 '근거 없음' 확인
