# S4-b — NODA 검증 합치기 · 첨부 스캔 PDF 읽기 · 옛 검색 걷어 내기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 문서 근거로 답한 턴도 '확인되지 않은 숫자'를 보이고 NODA `/verify` 결과를 감사용으로 남긴다. 첨부한 스캔 PDF를 NODA `/parse`로 읽는다. Voyage·자체 임베딩·업로드 OCR 코드와 임베딩 칸을 걷어 낸다.

**Architecture:** NODA 클라이언트(`src/lib/noda.ts`)에 `verifyAnswer`·`parseDocument`를 더한다. 대화 실행기는 문서 근거가 있었던 턴에 숫자 확인을 켜고(시스템 프롬프트에 NODA 근거 묶음이 들어 있으므로 기존 대조가 곧 '근거 합집합' 대조다), 같은 턴의 NODA 원 출처로 `/verify`를 불러 결과를 `source_references.verify`에 저장한다. 첨부 읽기(`attachments/reader.ts`)는 글자 층 없는 PDF를 NODA `/parse`로 읽어 글과 표(`ExtractedTable`)를 만든다. 마지막으로 옛 길을 지우고 0032로 임베딩 칸을 비운다.

**Tech Stack:** Next.js 14 · TypeScript · vitest · NODA HTTP API(`/verify`·`/parse`) · Supabase(마이그레이션 SQL만 작성)

**Spec:** `docs/superpowers/specs/2026-10-21-s4-noda-document-layer-design.md` — S4-b = 10절 둘째 행. 5.1·7·8절이 근거. NODA 계약: `https://api.readlayer.kr/docs/api.md`(`/verify` 절), `docs/schema.md`(문서 JSON·`tables`)

## Global Constraints

- 외부 API는 SDK 없이 `fetch`, 환경 변수는 `src/lib/config.ts` 경유. NODA 키·`DATABASE_URL`을 로그·오류 글·응답에 싣지 않는다
- 숫자 확인 문구는 그대로 `NUMBER_CHECK_NOTE`(`원본·계산 결과에서 확인되지 않은 숫자: … — 직접 확인하세요`). '틀렸다'가 아니라 '확인되지 않았다'
- 답변 글은 고치지 않는다. `/verify`가 실패해도 답은 그대로 나가고 검증만 빠진다(운영 기록에 남김)
- `/verify` 요청: `{ tenant, answer, sources }` — `sources`는 그 턴 `/context`의 `sources[]`를 **받은 순서 그대로** `{doc_id, chunk_id}`만(답의 `[n]`이 `sources[n-1]`을 가리킨다). `citations`는 보내지 않는다(인용 검사는 뒤로)
- `/verify` 한 번 시간 제한 5초(`5_000`), 다시 시도 없음 — 답을 붙잡지 않는다
- 저장: 답변 행 `source_references.verify = { grounded, unsupported_numbers, unknown_refs }`(검증을 부른 턴만, 없으면 칸을 두지 않음) — 두 메시지 행의 키 집합은 같아야 한다
- `/parse` 한 번 시간 제한 60초(`60_000`), 재시도 창 30초(429·503은 `Retry-After`). 첨부 확인 라우트는 `maxDuration = 60`이다
- 스캔 첨부 경고 문구(그대로): `글자 층이 없는 PDF라 글자 인식(OCR)으로 읽었습니다 — 숫자·글자가 원문과 다를 수 있습니다`
- NODA 장애로 스캔 첨부를 못 읽으면(그대로): `스캔 문서를 지금 읽지 못했습니다. 잠시 뒤 다시 올려 주세요.` · 키가 없으면 지금 문구 `스캔 문서(글자 층이 없는 PDF)는 아직 읽지 못합니다.`
- 마이그레이션 0032는 **사용자가 적용**한다(되돌릴 수 없음 — 옮긴 것을 확인한 뒤). 이 계획은 SQL 파일만. 푸시하지 않는다
- 커밋 끝: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## Review Focus

1. 문서 근거는 있는데 답의 숫자가 근거 묶음·도구 결과·질문 어디에도 없을 때 — 주황 안내가 뜬다(예전엔 첨부 도구를 쓴 턴만 떴다) → Task 2
2. 법령 도구가 준 숫자를 답에 옮긴 문서 턴 — 근거 묶음엔 없어도 도구가 보여 준 값이라 '확인되지 않음'에 걸리지 않는다 → Task 2
3. NODA `/verify`가 느리거나 실패할 때 — 답과 저장은 정상, `verify` 칸만 없다, 5초를 넘기지 않는다 → Task 2
4. 스캔 PDF 첨부에 표가 있을 때 — 병합 칸이 주인 칸에만 값이 있는 `ExtractedTable`이 되어 표 합치기가 두 번 더하지 않는다 → Task 3
5. 옛 길을 지운 뒤 — 어떤 코드도 `embeddings`·`rag`·`document-processor`·`pdf-ocr`·`VOYAGE_API_KEY`를 부르지 않고 빌드가 된다 → Task 4

## 판정

- **R1** 보이는 '확인되지 않은 숫자'는 **로컬 대조 하나**로 낸다: 첨부 도구가 성공했거나 **문서 근거(`turn.chunks`)가 있었던** 턴에 `checkNumbers(답, 도구 값 ∪ 시스템 프롬프트 숫자 ∪ 질문 숫자)`. 시스템 프롬프트에 NODA 근거 묶음이 있으므로 이것이 설계 5.1의 '어느 근거에도 없는 숫자'(근거 합집합)다. NODA `/verify`의 `unsupported_numbers`는 근거 묶음만 보고 도구 값을 모르므로 화면 목록에 더하지 않고 **감사 기록으로만** 저장한다 — 설계의 합치기 식과 같은 뜻을 더 단순하게
- **R2** 슈퍼관리자 화면의 'Voyage 키' 칸(`super/api-keys`·기관 상세의 키 확인 라우트)은 이번에 손대지 않는다 — 키 보관 화면이고 코드 경로가 아니다. 후속 정리로 남긴다
- **R3** `spreadsheet.ts`는 옛 업로드에서만 쓰여(첨부는 `attachments/tables-sheet.ts`) 함께 지운다. `pptx.ts`·`hwp.ts`는 첨부·양식이 쓰므로 남긴다. `isLikelyScanned`는 `src/lib/attachments/scan.ts`로 옮긴다

---

### Task 1: NODA 클라이언트 — `verifyAnswer` · `parseDocument`

**Files:**
- Modify: `src/lib/noda.ts`
- Test: `tests/noda-client.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface NodaVerifyResult { grounded: boolean; unsupported_numbers: string[]; unknown_refs: number[] }
  export interface NodaParsedCell { r: number; c: number; rowspan?: number; colspan?: number; text?: string | null }
  export interface NodaParsedTable { id: string; n_rows: number; n_cols: number; caption?: string | null; cells: NodaParsedCell[] }
  export interface NodaParsedBlock { type?: string; text?: string | null; page?: number }
  export interface NodaParsedDocument { readable: boolean; reason: string | null; pages: number; blocks: NodaParsedBlock[]; tables: NodaParsedTable[] }
  // NodaClient에 더함
  verifyAnswer(input: { tenant: string; answer: string; sources: { doc_id: string; chunk_id: string }[] }): Promise<NodaVerifyResult>;
  parseDocument(input: { filename: string; bytes: Uint8Array }): Promise<NodaParsedDocument>;
  export const VERIFY_TIMEOUT_MS = 5_000; export const PARSE_TIMEOUT_MS = 60_000; export const PARSE_RETRY_WINDOW_MS = 30_000;
  ```
  `parseDocument`는 응답의 `access.readable`·`access.reason`·`source.pages`·`blocks`·`tables`를 위 꼴로 정리한다(없는 칸은 빈 배열·0·null). `X-Filename`은 `encodeURIComponent`. `verifyAnswer`는 재시도 없음.

- [ ] **Step 1: 실패하는 테스트**
  ```ts
  it('verifyAnswer는 tenant·answer·sources(doc_id·chunk_id만, 순서 그대로)를 보내고 5초 제한, 다시 시도하지 않는다', async () => { /* 본문 JSON 확인, 503이면 fetch 1번 뒤 NodaError */ });
  it('verifyAnswer 응답의 빠진 칸은 기본값', async () => { /* {} → { grounded:false, unsupported_numbers:[], unknown_refs:[] } */ });
  it('parseDocument는 X-Filename 인코딩·바이트 본문, 503은 Retry-After 따라 다시', async () => {});
  it('parseDocument는 access·source·blocks·tables를 정리한다', async () => { /* readable:false + reason 'PASSWORD_PROTECTED' 그대로, pages 0 기본 */ });
  ```
- [ ] **Step 2: 실패 확인** — `npx vitest run tests/noda-client.test.ts` → FAIL
- [ ] **Step 3: 구현** — 기존 `withRetry`·한 번 시간 제한 장치를 그대로 쓴다
- [ ] **Step 4: 통과 확인** — 같은 명령 PASS, `npx tsc --noEmit`
- [ ] **Step 5: 커밋** — `feat: NODA 클라이언트 — 답변 검증(/verify)·문서 읽기(/parse)`

### Task 2: 문서 턴의 숫자 확인 · NODA 검증 기록

**Files:**
- Modify: `src/lib/capabilities/types.ts`, `src/lib/capabilities/doc-search.ts`, `src/lib/assistant/types.ts`, `src/lib/assistant/prepare.ts`, `src/lib/assistant/stream.ts`, `src/lib/assistant/persist.ts`
- Test: `tests/stream-turn.test.ts`, `tests/message-persistence.test.ts`, `tests/doc-search-noda.test.ts`

**Interfaces:**
- Consumes: Task 1 `noda.verifyAnswer`·`NodaVerifyResult`, `nodaTenant`
- Produces:
  ```ts
  // capabilities/types.ts PrepareResult에
  verifySources?: { doc_id: string; chunk_id: string }[];   // 그 턴 /context sources[] 원 순서 그대로(형식이 깨진 원소는 뺀다 — 단, 순서가 바뀌면 [n]이 어긋나므로 하나라도 깨졌으면 아예 비운다)
  // assistant/types.ts PreparedTurn에
  verifySources: { doc_id: string; chunk_id: string }[];
  // persist.ts MessageRowInput에
  verify?: NodaVerifyResult | null;
  // stream.ts — 주입 가능한 검증 함수(테스트용)
  export type VerifyFn = (input: { tenant: string; answer: string; sources: { doc_id: string; chunk_id: string }[] }) => Promise<NodaVerifyResult>;
  ```
  `streamTurn(turn, send, deps?: { verify?: VerifyFn })` — 기본은 `noda.verifyAnswer`. 검증은 메시지 저장 **전**에 부르고(결과를 함께 저장), `turn.verifySources`가 비었거나 답이 비었으면 부르지 않는다. 실패는 `system_logs`(api, warning, `{ agent_id, code, status }`)에만.

- [ ] **Step 1: 실패하는 테스트** — `tests/stream-turn.test.ts`
  ```ts
  it('문서 근거가 있는 턴이면 첨부 도구가 없어도 숫자를 대조한다', async () => {
    // turn.chunks 1개, systemPrompt에 '예산 12,345천원', 답 '예산은 12,345천원이고 총액 98,765천원' → number_check.unverified = ['98,765']
  });
  it('법령 도구가 보여 준 숫자는 근거 묶음에 없어도 확인된다', async () => { /* 도구 shownValues에 98765 */ });
  it('문서 근거도 첨부 도구도 없는 턴은 대조하지 않는다', async () => {});
  it('NODA 검증 결과를 답변 행 source_references.verify에 저장한다', async () => { /* fake verify → {grounded:false, unsupported_numbers:['50'], unknown_refs:[3]} */ });
  it('검증은 그 턴 sources를 받은 순서 그대로 보낸다', async () => {});
  it('검증이 실패하면 답과 저장은 그대로, verify 칸이 없고 운영 기록만 남는다', async () => {});
  it('검증이 5초 넘게 걸리면 기다리지 않는다', async () => { /* 가짜 verify가 영영 안 끝남 → streamTurn이 끝나고 verify 칸 없음 (가짜 타이머) */ });
  it('verifySources가 비었으면 검증을 부르지 않는다', async () => {});
  ```
  `tests/message-persistence.test.ts`: `verify`가 있으면 답변 행에만 `source_references.verify`, 없으면 칸 없음, 두 행 키 집합 같음.
  `tests/doc-search-noda.test.ts`: prepare가 `verifySources`에 `/context` 순서대로 `{doc_id, chunk_id}`를 싣는다 · 형식이 깨진 원소가 하나라도 있으면 빈 배열.
- [ ] **Step 2: 실패 확인** → FAIL
- [ ] **Step 3: 구현** — 숫자 확인 조건을 `result.attachmentToolSucceeded || turn.chunks.length > 0`로(판정 R1). 검증 시간 제한은 `Promise.race`로 5초(`VERIFY_TIMEOUT_MS`) — 넘기면 검증 없이 진행(진행 중인 요청은 버린다)
- [ ] **Step 4: 통과 확인** — `npm test`, `npx tsc --noEmit`
- [ ] **Step 5: 커밋** — `feat: 문서 근거 턴도 숫자 확인, NODA 답변 검증을 감사 기록으로 저장`

### Task 3: 첨부 스캔 PDF를 NODA `/parse`로

**Files:**
- Create: `src/lib/attachments/scan.ts` (`isLikelyScanned` 옮김 + `parsedToExtract`)
- Modify: `src/lib/attachments/reader.ts`
- Test: `tests/attachments-reader.test.ts`, `tests/attachments-scan.test.ts`(새로)

**Interfaces:**
- Consumes: Task 1 `noda.parseDocument`·`NodaParsedDocument`·`NodaError`; 기존 `buildTable(id, title, cells, merges, caption, truncated)`(`attachments/header.ts`)
- Produces:
  ```ts
  export function isLikelyScanned(text: string, pageCount: number): boolean;     // pdf-ocr.ts에서 그대로 옮김(페이지당 50자 미만)
  export const SCAN_WARNING = '글자 층이 없는 PDF라 글자 인식(OCR)으로 읽었습니다 — 숫자·글자가 원문과 다를 수 있습니다';
  export function parsedToExtract(doc: NodaParsedDocument): { text: string; tables: ExtractedTable[]; pages: number };
  // reader.ts
  export async function readAttachment(bytes: Buffer, fileName: string, deps?: { parseScanned?: (b: Buffer, name: string) => Promise<NodaParsedDocument> }): Promise<AttachmentExtract>;
  ```
  `parsedToExtract`: 글은 `blocks`를 읽는 차례대로 `type !== 'footer'`인 블록의 `text`를 줄바꿈으로 잇는다(표 블록 글도 넣는다 — 지금 PDF 첨부 본문과 같은 성격). 표는 `cells`를 `n_rows × n_cols` 격자로 펴되 **병합은 주인 칸(r,c)에만 값**, 덮인 칸은 null, 병합 범위는 `merges`로(S3-a 규칙과 같음). 표 id `t1…`, 제목 `표 N`, 캡션은 NODA `caption`.

- [ ] **Step 1: 실패하는 테스트** — `tests/attachments-scan.test.ts`
  ```ts
  it('글은 꼬리글을 빼고 차례대로', () => {});
  it('병합 칸은 주인 칸에만 값, 덮인 칸은 null, merges에 범위', () => {
    // cells: {r:0,c:0,rowspan:2,text:'구분'}, {r:0,c:1,text:'예산'}, {r:1,c:1,text:'100'} → cells[1][0] === null, merges에 {r:0,c:0,rowspan:2,colspan:1}
  });
  it('isLikelyScanned — 페이지당 50자 미만이면 스캔', () => {});
  ```
  `tests/attachments-reader.test.ts`: 스캔 PDF(글자 층 없는 PDF 바이트 — 기존 테스트의 스캔 PDF 만들기를 따름)에 가짜 `parseScanned` → 본문·표·경고 맨 앞 `SCAN_WARNING` · `readable:false` → `AttachmentReadError`(NODA `reason` 코드는 그대로 보이지 않고 `스캔 문서를 읽지 못했습니다(사유: 암호가 걸린 파일)`처럼 — 사유 표는 `PASSWORD_PROTECTED`→'암호가 걸린 파일', `DRM`→'보안(DRM)이 걸린 파일', 그 밖→'읽을 수 없는 파일') · `NodaError` → `스캔 문서를 지금 읽지 못했습니다. 잠시 뒤 다시 올려 주세요.` · 키 없음(`missing_key`) → `스캔 문서(글자 층이 없는 PDF)는 아직 읽지 못합니다.`
- [ ] **Step 2: 실패 확인** → FAIL
- [ ] **Step 3: 구현** — 기본 `parseScanned`는 `noda.parseDocument({ filename, bytes })`. 글자 층 있는 PDF는 지금과 같다(NODA를 부르지 않는다)
- [ ] **Step 4: 통과 확인** — `npm test`, `npx tsc --noEmit`
- [ ] **Step 5: 커밋** — `feat: 첨부 스캔 PDF를 NODA로 읽기 — 글·표, 글자 인식 경고`

### Task 4: 옛 검색·임베딩·업로드 OCR 걷어 내기

**Files:**
- Delete: `src/lib/embeddings.ts`, `src/lib/rag.ts`, `src/lib/document-processor.ts`, `src/lib/pdf-ocr.ts`, `src/lib/spreadsheet.ts`, `tests/pdf-ocr.test.ts`, `tests/spreadsheet.test.ts`
- Modify: `src/lib/config.ts`(`VOYAGE_API_KEY` 제거), `.env.example`(VOYAGE 줄 제거), `scripts/connector-probe.mjs`·`scripts/noda-check.mjs`·`scripts/noda-migrate.mjs`(필수 환경 목록에서 `VOYAGE_API_KEY` 제거), 그 밖에 지운 모듈을 가리키는 테스트·주석
- Test: `tests/legacy-removed.test.ts`(새로)

- [ ] **Step 1: 실패하는 테스트** — `tests/legacy-removed.test.ts`
  ```ts
  it('옛 검색·임베딩·업로드 OCR 파일이 없다', () => {
    for (const f of ['src/lib/embeddings.ts','src/lib/rag.ts','src/lib/document-processor.ts','src/lib/pdf-ocr.ts','src/lib/spreadsheet.ts']) expect(existsSync(f), f).toBe(false);
  });
  it('src·scripts 어디에도 VOYAGE_API_KEY·옛 모듈 import가 없다', () => { /* src/**, scripts/** 원본 글 훑기 — '@/lib/embeddings' '@/lib/rag' '@/lib/document-processor' '@/lib/pdf-ocr' '@/lib/spreadsheet' 'VOYAGE_API_KEY' 없음. 슈퍼관리자 키 화면의 'voyage' 글자는 판정 R2로 대상 아님 */ });
  ```
- [ ] **Step 2: 실패 확인** → FAIL
- [ ] **Step 3: 지우기** — `pdf-ocr.test.ts`의 스캔 판정 테스트는 Task 3의 `attachments-scan.test.ts`가 이미 맡는다. `llm-boundary.test.ts`의 예외 목록에 `pdf-ocr`가 있으면 그 줄도 뺀다
- [ ] **Step 4: 확인** — `npm test`, `npx tsc --noEmit`, `npx next build` 통과
- [ ] **Step 5: 커밋** — `chore: 옛 검색(Voyage·pgvector)·자체 임베딩·업로드 OCR 코드 제거`

### Task 5: 0032 임베딩 칸 비우기 · 문서

**Files:**
- Create: `supabase/migrations/0032_documents_drop_embeddings.sql`
- Modify: `CLAUDE.md`, `docs/superpowers/specs/2026-10-21-s4-noda-document-layer-design.md`(5.1에 판정 R1 한 줄)
- Test: 없음(SQL). `npm test`·`npx tsc --noEmit`

- [ ] **Step 1: 0032 SQL** — 0031 머리 주석 꼴. **되돌릴 수 없다 · `noda:migrate` 뒤 옮긴 것을 확인하고 적용 · RPC(`search_agent_chunks`·`search_document_chunks`)와 `embedding` 칸 자체는 지우지 않는다(값만 비움)**:
  ```sql
  UPDATE documents
     SET embedding = NULL,
         metadata  = metadata - 'chunks'
   WHERE noda_status IS NOT NULL
     AND (embedding IS NOT NULL OR metadata ? 'chunks');
  ```
  끝에 확인 쿼리 주석(남은 행 수: `SELECT count(*) FROM documents WHERE embedding IS NOT NULL OR metadata ? 'chunks';`)
- [ ] **Step 2: CLAUDE.md** — 스택 표(Voyage·pgvector·옛 파싱 '남음' 표시를 지움), 디렉터리(지운 파일 줄 삭제, `attachments/scan.ts` 추가), 'S4-b까지 남은 옛 길' 블록과 옛 스캔 PDF·표 문서·발표자료 절을 지우거나 '옛 길은 S4-b에서 지움' 한 줄로, 환경 변수에서 `VOYAGE_API_KEY` 삭제, 마이그레이션 표에 0032(**옮긴 것 확인 뒤 사용자가 적용**), 숫자 확인 절에 '문서 근거 턴도 대조, NODA `/verify`는 `source_references.verify`에 감사 기록', 파일 첨부 절의 '첨부에는 스캔 PDF 판독이 없습니다'를 NODA `/parse`로 고침, 테스트 표(지운 두 파일 행 삭제·새 테스트 행), 테스트 수
- [ ] **Step 3: 확인** — `npm test` 수 기록, `npx tsc --noEmit`
- [ ] **Step 4: 커밋** — `docs: S4-b — 0032(임베딩 칸 비우기), CLAUDE.md 갱신`

---

## 배포 메모 (사용자 몫)

1. 코드 푸시(배포 확인) — 마이그레이션 없이 돈다(0032는 값만 비움)
2. 대화에서 문서 근거 답의 숫자 안내, 스캔 PDF 첨부를 한 번 확인
3. 문서가 모두 NODA로 옮겨진 것(`npm run noda:migrate -- --dry-run`이 0건)을 확인한 뒤 0032 적용
4. Vercel·`.env.local`의 `VOYAGE_API_KEY`는 지워도 된다(코드가 더 읽지 않음)
