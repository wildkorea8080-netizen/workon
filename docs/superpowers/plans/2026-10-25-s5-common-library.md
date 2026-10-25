# S5 공통 자료실 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 운영자가 기관 유형별 공통 기준 문서를 올리면, 그 유형 기관의 문서 찾기 비서가 자기 문서와 함께 찾아 `[공통]`·기준 연도와 함께 근거로 쓴다.

**Architecture:** 유형마다 NODA 보관함 하나(`workon-c-{열쇠}`)와 표 `common_documents`(0033). S4의 읽기 상태 기계를 표·보관함만 갈라지게 일반화해 공통 문서에도 쓰고, `doc_search`가 비서 보관함과 공통 보관함을 동시에 `/context`로 찾아 번호를 합친다. 운영자는 슈퍼관리자 화면 `/super/common-library`에서 올리고·바꾸고·지운다.

**Tech Stack:** Next.js 14 App Router · TypeScript · Supabase(PostgREST·Storage) · NODA REST(`fetch`) · vitest

**Spec:** `docs/superpowers/specs/2026-10-25-s5-common-library-design.md`

## Global Constraints

- 유형은 정확히 여섯: `중앙행정기관`·`지방자치단체`·`공공기관`·`교육기관`·`협회단체`·`일반기업`, 열쇠 `central`·`local`·`public`·`edu`·`assoc`·`company`
- 공통 보관함 이름 `workon-c-{열쇠}` — 서버가 유형으로만 만든다. 요청값으로 보관함·파일 이름을 받지 않는다
- NODA 파일 이름 `{id}__{다듬은 이름}({기준 연도}){원래 확장자}` — 이름에서 `/ \ : * ? " < > |`·`\p{Cc}`·`\p{Cf}`를 빼고 80자에서 자른다
- `/context` 예산: 한 보관함만 찾으면 4000, 둘 다면 비서 3000 + 공통 2000
- 기준 연도 2000~2100 정수, 이용 조건 기록(`usage_terms`) 필수
- 상태 값: `reading`·`ready`·`failed`·`unreadable`·`deleting`·`retired`
- 삭제 순서 NODA → DB 행 → 저장소 원본. NODA 404는 지운 것
- NODA를 못 부르면(비서·공통 어느 쪽이든) 503 `documents_unavailable` — 대화를 만들기 전
- 운영 기록(`system_logs`)에 파일 이름을 남기지 않는다(문서 id·개수·유형 열쇠만). `super_admin_logs`에는 이름·유형·연도·이용 조건을 남겨도 된다
- 환경 변수는 `src/lib/config.ts` 경유, 외부 API는 `fetch`, 응답은 `{ ok, data | error: { message } }`, 한국어 오류
- 화면 코드는 `config.ts`를 가져오지 않는다(`config-public-guard.test.ts`)
- 커밋 메시지 끝: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. 서브에이전트는 자기 이름을 넣지 않는다
- 테스트는 Git Bash에서 `npm test` (PowerShell은 `find`가 Windows 것이라 일부가 깨진다)

## Review Focus

1. **유형이 바뀐 기관** — 슈퍼관리자가 기관 `type`을 바꾸면 다음 질문부터 새 유형 보관함만 찾아야 한다(옛 유형 근거가 '섞임'으로 잡히면 안 됨). Task 5 시험에 넣는다
2. **새 판이 읽기에 실패** — 옛 판이 계속 검색돼야 한다(`retired`로 바뀌지 않음). Task 3 시험
3. **공통 문서 이름에 확장자 같은 글·마침표·아주 긴 글**(`예산편성기준.pdf 최종본(수정)…`) — NODA 파일 이름이 원래 확장자 하나로 끝나야 한다. Task 1 시험
4. **비서 근거는 전부 빠지고 공통만 남은 턴**(비서 문서가 다른 상태라 조용히 빠짐) — 공통 번호를 밀지 않고 `/verify`는 공통 보관함으로. Task 4·5 시험
5. **공통 문서가 없는 유형의 기관**(type NULL·목록 밖) — 공통 보관함을 부르지도, 공통 행을 조회하지도 않는다. Task 5 시험

---

## 파일 구조

| 파일 | 책임 |
|---|---|
| `supabase/migrations/0033_common_documents.sql` (새) | 표·CHECK·인덱스 |
| `src/lib/org-types.ts` (새, import 없음 — 화면도 읽음) | 유형 여섯·열쇠 표·보관함 이름·NODA 파일 이름 |
| `src/lib/db.ts` | `NodaStatus`에 `'retired'`, `CommonDocument`, `RetrievedChunk.scope`·`editionYear` |
| `src/lib/document-reading.ts` | 표·보관함을 deps로 받게 일반화, `afterReady` 갈고리 |
| `src/lib/common-documents.ts` (새) | 공통 문서 읽기 deps·판 바꾸기(`retireReplacedEdition`)·삭제 |
| `src/lib/noda-webhook.ts` | 공통 보관함 알림 |
| `src/lib/noda.ts` | `getContext`의 `budget` |
| `src/lib/capabilities/doc-search-common.ts` (새) | 번호 합치기·공통 근거 맞추기(순수 함수) |
| `src/lib/capabilities/doc-search.ts` | preflight·prepare가 공통 보관함까지 |
| `src/lib/capabilities/types.ts`·`src/lib/assistant/{types,prepare,stream,persist}.ts` | `verifyTenant`, 조각 새 칸 저장 |
| `src/app/api/super/common-documents/**` (새) | 운영자 API |
| `src/app/super/common-library/page.tsx` (새) · `src/components/super/SuperNav.tsx` | 운영자 화면 |
| `src/components/chat/{source-label.ts,SourceCitation.tsx,SourcePanel.tsx}` | `[공통]` 표시 |
| `src/app/super/organizations/page.tsx` | `ORG_TYPES`를 `org-types.ts`에서 가져옴 |
| `CLAUDE.md` | 문서 |

---

### Task 1: 유형 표 · 보관함·파일 이름 · 0033 · 타입

**Files:**
- Create: `src/lib/org-types.ts`, `supabase/migrations/0033_common_documents.sql`, `tests/org-types.test.ts`
- Modify: `src/lib/db.ts`, `src/app/super/organizations/page.tsx:5`

**Interfaces:**
- Produces:
  - `export const ORG_TYPES = ['중앙행정기관','지방자치단체','공공기관','교육기관','협회단체','일반기업'] as const; export type OrgType = typeof ORG_TYPES[number];`
  - `export const ORG_TYPE_KEYS: Record<OrgType, string>` (위 순서로 `central`·`local`·`public`·`edu`·`assoc`·`company`)
  - `export function isOrgType(v: unknown): v is OrgType`
  - `export function commonTenant(orgType: OrgType): string` → `workon-c-{열쇠}`; 표 밖 값이면 throw
  - `export function orgTypeFromCommonTenant(tenant: string): OrgType | null`
  - `export function commonNodaFilename(input: { id: string; title: string; editionYear: number; fileName: string }): string`
  - `db.ts`: `NodaStatus`에 `'retired'`(주석: 공통 문서만), `export interface CommonDocument { id; org_type: OrgType; title; edition_year: number; usage_terms; file_name; file_type: string | null; size_bytes: number | null; storage_path; noda_status: NodaStatus; noda_reason; noda_filename; noda_doc_id; noda_read_started_at; noda_last_attempt_at; noda_read_at; replaces_id: string | null; retired_at: string | null; uploaded_by: string | null; created_at; updated_at }`, `RetrievedChunk`에 `scope?: 'common'`·`editionYear?: number`

- [ ] **Step 1: 실패하는 시험 — `tests/org-types.test.ts`**

```ts
it('유형 → 공통 보관함', () => {
  expect(commonTenant('지방자치단체')).toBe('workon-c-local');
  expect(() => commonTenant('민간' as OrgType)).toThrow();
  expect(orgTypeFromCommonTenant('workon-c-assoc')).toBe('협회단체');
  expect(orgTypeFromCommonTenant('workon-c-x')).toBeNull();
  expect(orgTypeFromCommonTenant('workon-a11111111222243338444555555555555')).toBeNull();
});
it('NODA 파일 이름 — 다듬은 이름(연도) + 원래 확장자 하나', () => {
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  expect(commonNodaFilename({ id, title: '예산편성기준', editionYear: 2026, fileName: '기준.PDF' })).toBe(`${id}__예산편성기준(2026).PDF`);
  expect(commonNodaFilename({ id, title: '지침/2:개정?', editionYear: 2025, fileName: 'a.hwpx' })).toBe(`${id}__지침2개정(2025).hwpx`);
  const long = commonNodaFilename({ id, title: '가'.repeat(200), editionYear: 2026, fileName: 'a.pdf' });
  expect(long).toBe(`${id}__${'가'.repeat(80)}(2026).pdf`);
  // Review Focus 3 — 이름 속 확장자·마침표는 그대로 글로 남고, 끝은 원래 확장자 하나
  expect(commonNodaFilename({ id, title: '예산편성기준.pdf 최종본', editionYear: 2026, fileName: 'x.docx' }))
    .toBe(`${id}__예산편성기준.pdf 최종본(2026).docx`);
  expect(commonNodaFilename({ id, title: '‮기준\u0007', editionYear: 2026, fileName: 'x.pdf' })).toBe(`${id}__기준(2026).pdf`);
});
it('organizations 화면이 같은 유형 목록을 쓴다', () => {
  expect(readFileSync('src/app/super/organizations/page.tsx', 'utf8')).toContain("from '@/lib/org-types'");
});
```

- [ ] **Step 2: 실행해 실패 확인** — `npx vitest run tests/org-types.test.ts` → 모듈 없음
- [ ] **Step 3: `org-types.ts` 구현** — 아무것도 import하지 않는다. 이름을 다듬은 결과가 비면 `문서`를 쓴다. 확장자는 `fileName`의 마지막 `.` 뒤(없으면 빈 글)
- [ ] **Step 4: 0033 작성** — 머리 주석은 0031 꼴(설계 경로·배포 순서 "**코드 배포 전에 적용**, 사용자가 적용"·상태 뜻). `CREATE TABLE IF NOT EXISTS common_documents` 칸은 설계 4절 그대로. CHECK: `org_type IN (여섯)`, `edition_year BETWEEN 2000 AND 2100`, `noda_status IN ('reading','ready','failed','unreadable','deleting','retired')`, `length(trim(usage_terms)) > 0`, `length(trim(title)) > 0`. `noda_filename text UNIQUE`, `replaces_id uuid REFERENCES common_documents(id) ON DELETE SET NULL`, `uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL`. 인덱스 `(org_type, noda_status)`. `updated_at` 트리거는 다른 마이그레이션이 쓰는 함수가 있으면 그것, 없으면 두지 않는다(코드가 갱신 때 직접 쓴다). RLS 켜지 않는다(CLAUDE.md 구조)
- [ ] **Step 5: `db.ts` 타입·`organizations/page.tsx`가 `ORG_TYPES`를 가져오게** — 화면의 `const ORG_TYPES = [...]`를 지우고 import
- [ ] **Step 6: 실행** — `npx vitest run tests/org-types.test.ts` PASS, `npx tsc --noEmit` 오류 없음(메모리가 모자라 tsc가 죽으면 `NODE_OPTIONS=--max-old-space-size=4096`)
- [ ] **Step 7: 커밋** `feat: S5 — 유형 표·공통 보관함 이름·0033 common_documents`

---

### Task 2: 읽기 상태 기계 일반화

동작은 그대로 두고 표·보관함을 deps가 정하게 한다. 기존 `tests/document-reading.test.ts`·`tests/noda-webhook.test.ts`·`tests/agent-documents.test.ts`가 그대로 통과해야 한다(시험 파일은 타입 맞추기 외에 바꾸지 않는다).

**Files:**
- Modify: `src/lib/document-reading.ts`, `src/lib/noda-webhook.ts`(호출 꼴만), `tests/document-reading.test.ts`(deps 꼴만)

**Interfaces:**
- Produces (in `document-reading.ts`):
  - `ReadingRow`에서 `agent_id`를 뺀다: `{ id; noda_status: NodaStatus | null; noda_filename; noda_read_started_at; noda_last_attempt_at; created_at }`
  - `StoredDocument extends ReadingRow { storage_path; file_name; noda_reason; noda_doc_id; noda_read_at; agent_id?: string | null; org_type?: string | null }`
  - `ReadingDeps` 에 `tenantOf(row: { agent_id?: string | null; org_type?: string | null }): string | null` 와 `afterReady?: (id: string) => Promise<void>` 추가
  - `defaultReadingDeps()`의 `tenantOf`는 `row.agent_id ? nodaTenant(row.agent_id) : null`
  - `readDocument`: `!row || row.noda_status === null`이거나 `tenantOf(row)`가 null이면 `not_found`. 보관함은 `tenantOf(row)`
  - `reconcileReading<T extends ReadingRow & { agent_id?: string | null; org_type?: string | null }>`: 보관함으로 묶는 열쇠가 `tenantOf(row)`
  - `ready`를 쓴 곳(`readDocument`의 결론·`reconcileReading`의 ready)은 쓰기가 성공했을 때 `await deps.afterReady?.(id)` — 실패는 잡아 `deps.log` warning(`{ document_id, error }`)만, 결과는 그대로

- [ ] **Step 1: 시험 추가 — `tests/document-reading.test.ts`**

```ts
it('tenantOf가 보관함을 정한다 — 공통 문서 꼴의 행도 읽힌다', async () => {
  const deps = worldWith([{ ...doc(), agent_id: undefined, org_type: '지방자치단체' }]);
  deps.tenantOf = (r) => (r.org_type ? 'workon-c-local' : null);
  await readDocument(DOC, {}, deps);
  expect(uploads[0].tenant).toBe('workon-c-local');
});
it('tenantOf가 null이면 not_found(보낼 보관함 없음)', ...);
it('ready를 쓰면 afterReady를 한 번 부른다 — readDocument·reconcileReading 둘 다, 실패해도 결과는 ready', ...);
it('afterReady는 unreadable·failed·쓰기 실패 때 부르지 않는다', ...);
```
(`worldWith`·`uploads`는 파일 안 기존 도우미 꼴에 맞춰 쓴다)

- [ ] **Step 2: 실행해 실패 확인**
- [ ] **Step 3: 구현** — `agent_id`를 직접 읽는 곳을 모두 `deps.tenantOf`로. `noda-webhook.ts`는 이 Task에서 동작을 바꾸지 않는다(`row.agent_id` 비교는 `StoredDocument.agent_id`로 그대로 됨)
- [ ] **Step 4: 실행** — `npx vitest run tests/document-reading.test.ts tests/noda-webhook.test.ts tests/agent-documents.test.ts tests/document-routes.test.ts` 전부 PASS, `npx tsc --noEmit`
- [ ] **Step 5: 커밋** `refactor: 읽기 상태 기계 — 보관함을 deps가 정함, ready 갈고리`

---

### Task 3: 공통 문서 읽기·판 바꾸기·삭제·웹훅

**Files:**
- Create: `src/lib/common-documents.ts`, `tests/common-documents.test.ts`
- Modify: `src/lib/noda-webhook.ts`, `tests/noda-webhook.test.ts`

**Interfaces:**
- Consumes: Task 1 `commonTenant`·`orgTypeFromCommonTenant`·`isOrgType`·`CommonDocument`; Task 2 `ReadingDeps`(`tenantOf`·`afterReady`)
- Produces (in `common-documents.ts`):
  - `export function commonReadingDeps(): ReadingDeps` — 표 `common_documents`에 대한 `ReadingStore`(S4 `defaultStore`와 같은 조건부 갱신), `tenantOf: (r) => isOrgType(r.org_type) ? commonTenant(r.org_type) : null`, `afterReady: (id) => retireReplacedEdition(id)`
  - `export interface CommonStore { getRow(id): Promise<CommonDocument | null>; retire(id: string, nowIso: string): Promise<boolean> /* 현재 판(retired_at NULL)·deleting 아님일 때만 noda_status='retired', retired_at */; markDeleting(id): Promise<boolean>; deleteRow(id): Promise<boolean>; removeFile(path): Promise<void> }`
  - `export async function retireReplacedEdition(newId: string, deps?: { store: CommonStore; noda: Pick<NodaClient,'deleteDocument'>; now: () => number; log }): Promise<'retired' | 'none' | 'kept_deleting'>` — 새 판 행이 `ready`이고 `replaces_id`가 있을 때만: 옛 판이 같은 유형이고 현재 판이면 옛 판 NODA 사본 삭제(404 = 지움) → `retire`. NODA 실패면 `markDeleting` → `'kept_deleting'`(system_logs warning `{ document_id, code, status }`). 옛 판이 이미 지난 판·없음·다른 유형이면 `'none'`. 성공하면 system_logs info `공통 문서 지난 판으로 바꿈` `{ document_id: 옛 id, replaced_by: 새 id }`
  - `export async function deleteCommonDocument(id: string, deps?): Promise<{ ok: true } | { ok: false; status: 404 | 502 }>` — 순서 NODA(`noda_status`가 NULL·`retired`가 아니고 `noda_filename`이 있을 때만) → 행 → 원본. NODA 실패면 `markDeleting` 후 502
- `noda-webhook.ts`: `applyNodaEvent`가 `tenant`를 먼저 가른다 — 비서 보관함이면 지금 그대로(`defaultReadingDeps`), `orgTypeFromCommonTenant(tenant)`가 유형을 주면 `commonReadingDeps()`로 같은 처리를 하되 행 맞춤 조건이 `row.org_type === 그 유형 && row.noda_filename === filename`. `applyNodaEvent(event, deps?)`의 deps 인자는 시험용으로 `{ agent?: ReadingDeps; common?: ReadingDeps }`로 바꾸고 기존 시험을 그 꼴로 고친다. `ready`를 쓴 뒤 `deps.afterReady?.(id)`를 부른다(실패는 기록만)

- [ ] **Step 1: 실패하는 시험 — `tests/common-documents.test.ts`**

```ts
it('새 판이 ready가 되면 옛 판 NODA 사본을 지우고 retired', async () => { /* replaces_id = OLD, OLD 현재 판 → deleteDocument('workon-c-local', OLD의 noda_filename), retire(OLD) */ });
it('새 판이 ready가 아니면(읽는 중·실패) 옛 판을 건드리지 않는다', ...);          // Review Focus 2
it('옛 판 NODA 삭제가 실패하면 deleting으로 두고 kept_deleting, warning에 파일 이름 없음', ...);
it('옛 판이 다른 유형·이미 지난 판·없음이면 none', ...);
it('NODA 404는 지운 것', ...);
it('commonReadingDeps.tenantOf — 유형 열쇠 보관함, 유형 밖이면 null', ...);
it('deleteCommonDocument — NODA → 행 → 원본, NODA 실패면 deleting + 502, retired는 NODA를 건너뜀', ...);
```

`tests/noda-webhook.test.ts`에 더함:

```ts
it('공통 보관함 알림은 그 유형의 행만 ready로 바꾸고 afterReady를 부른다', ...);
it('다른 유형의 행·다른 파일 이름이면 건드리지 않고 security warning(파일 이름 없음)', ...);
it('공통 보관함에서 행이 없는 문서가 읽혔으면 그 보관함 사본을 지운다', ...);
```

- [ ] **Step 2: 실행해 실패 확인**
- [ ] **Step 3: 구현**
- [ ] **Step 4: 실행** — 두 시험 파일 + `tests/document-reading.test.ts` PASS, `npx tsc --noEmit`
- [ ] **Step 5: 커밋** `feat: S5 — 공통 문서 읽기·판 바꾸기·삭제·웹훅`

---

### Task 4: 번호 합치기·공통 근거 맞추기(순수 함수) · `/context` 예산

**Files:**
- Create: `src/lib/capabilities/doc-search-common.ts`, `tests/doc-search-common.test.ts`
- Modify: `src/lib/noda.ts`(`getContext`), `tests/noda-client.test.ts`

**Interfaces:**
- Consumes: Task 1 `CommonDocument`·`RetrievedChunk.scope/editionYear`; 기존 `contextPassages`·`SourceMatch`·`NodaSource`·`NodaContextResult`
- Produces:
  - `noda.getContext({ tenant, query, budget? })` — `budget` 없으면 `NODA_CONTEXT_BUDGET`(4000). 상수 `export const CONTEXT_BUDGET_AGENT_SHARED = 3000; export const CONTEXT_BUDGET_COMMON_SHARED = 2000;` (`noda.ts`)
  - `export function shiftContext(result: NodaContextResult, offset: number): NodaContextResult` — 머리 줄 `^\[(\d{1,3})\] `의 번호와 `sources[].n`에 `offset`을 더한다. 0이면 그대로
  - `export function maxCitationNumber(result: NodaContextResult): number` — 머리 줄 번호와 `sources[].n` 중 가장 큰 값, 없으면 0
  - `export type CommonSearchDoc = Pick<CommonDocument, 'id' | 'title' | 'edition_year' | 'org_type' | 'noda_status' | 'retired_at'>`
  - `export function commonSourcesToChunks(sources: NodaSource[], docs: CommonSearchDoc[], passages: Map<number, string>, startIndex: number): SourceMatch` — `ready`이고 `retired_at` NULL인 행만 조각(`scope: 'common'`, `editionYear`, `documentTitle: title`, `chunkIndex`는 `startIndex`부터). 그 밖 상태는 조용히 뺀다. 행 없음·id 못 읽음·깨짐은 `SourceMatch`의 칸에 모은다(`sourcesToChunks`와 같은 꼴 — 위치 칸(page·cellRange·section·ocr) 계산을 공유하도록 `doc-search.ts`에서 조각 만들기 부분을 `export function chunkFromSource(source, base): RetrievedChunk`로 떼어 둘이 쓴다)

- [ ] **Step 1: 실패하는 시험**

```ts
it('shiftContext — 머리 줄과 sources.n이 함께 밀린다, 본문 속 [2]는 그대로', () => {
  const r = { context: '[1] a.pdf · 3쪽\n본문 [2]\n[2] b.pdf\n둘', sources: [{ n: 1, ... }, { n: 2, ... }], dropped: 0 };
  const s = shiftContext(r, 3);
  expect(s.context).toBe('[4] a.pdf · 3쪽\n본문 [2]\n[5] b.pdf\n둘');
  expect(s.sources.map((x) => x.n)).toEqual([4, 5]);
});
it('maxCitationNumber — 머리 줄·sources 중 큰 값, 빈 결과는 0', ...);
it('commonSourcesToChunks — 현재 판 ready만 조각(scope common·editionYear·startIndex), 지난 판·읽는 중은 조용히 뺌', ...);
it('commonSourcesToChunks — 행 없는 id·id 못 읽는 이름·깨진 원소는 따로 모음', ...);
it('근거 창 원문이 민 번호로 이어진다(contextPassages(shiftContext(...)))', ...);
```
`tests/noda-client.test.ts`: `getContext` 본문에 `budget`이 주면 그 값, 없으면 4000.

- [ ] **Step 2: 실행해 실패 확인**
- [ ] **Step 3: 구현** — `chunkFromSource`로 떼어 낸 뒤 `sourcesToChunks` 시험(`tests/doc-search-noda.test.ts`)이 그대로 통과해야 한다
- [ ] **Step 4: 실행** — `npx vitest run tests/doc-search-common.test.ts tests/doc-search-noda.test.ts tests/noda-client.test.ts` PASS
- [ ] **Step 5: 커밋** `feat: S5 — 근거 번호 합치기·공통 근거 맞추기`

---

### Task 5: 문서 찾기가 공통 보관함까지 · 검증 보관함 · 저장

**Files:**
- Modify: `src/lib/capabilities/doc-search.ts`, `src/lib/capabilities/types.ts`, `src/lib/assistant/types.ts`, `src/lib/assistant/prepare.ts`, `src/lib/assistant/stream.ts`, `src/lib/assistant/persist.ts`
- Test: `tests/doc-search-noda.test.ts`, `tests/stream-turn.test.ts`, `tests/message-persistence.test.ts`

**Interfaces:**
- Consumes: Task 1(`commonTenant`·`isOrgType`), Task 4 전부
- Produces:
  - `DocSearchDeps`에 더함: `orgTypeOf(organizationId: string): Promise<string | null>`(`organizations.type`, 실패는 throw), `commonDocumentsOf(orgType: OrgType): Promise<CommonSearchDoc[]>`(그 유형 행 전부, 실패는 throw), `fetchCommonContext(orgType: OrgType, query: string, budget: number): Promise<NodaContextResult>`, `findCommonDocuments(ids: string[]): Promise<{ id: string; org_type: string }[]>`, `deleteCommonOrphan(orgType: OrgType, filename: string): Promise<void>`. `fetchContext(agentId, query, budget?)`
  - `PrepareResult.verifyTenant?: string`, `PreparedTurn.verifyTenant: string | null`; `stream.ts verifyTurn`이 `turn.verifyTenant ?? nodaTenant(turn.ctx.agentId)`
  - `persist.ts`가 조각에 `scope`·`editionYear`를 싣는다(없으면 JSON에서 빠짐)
- 동작(설계 5절):
  - preflight: 비서 문서 행 → 기관 유형(`orgTypeOf`) → 유형이 `isOrgType`이면 공통 행. 셋 중 조회 실패는 지금과 같은 `database` error 기록 + 503. 찾을 곳: 비서 ready 있음 / 공통 ready 현재 판 있음. 둘 다 없으면 NODA 안 부름. 있으면 `Promise.all`로 동시에, 예산은 Global Constraints. 하나라도 실패면 `api` warning + 503. carry에 `{ docs, result?, common?: { orgType, docs, result } }`
  - prepare: 비서 근거는 `matchedChunks` 그대로. 공통 근거는 `commonSourcesToChunks` → 깨끗하지 않으면 `findCommonDocuments`로 가른다: 다른 유형 행이 있으면 **섞임** — 그 턴 근거 전체(비서 것까지) 버리고 critical(`security`) `{ agent_id, org_type_key, foreign_count }`; 나머지는 **고아** — 공통 근거만 버리고 `deleteCommonOrphan`(1.5초까지만), warning; 깨진 원소 — 공통 근거만 버림, warning; 조회 실패 — 공통 근거만 버림, error
  - 번호: 비서 조각이 하나 이상이면 `offset = maxCitationNumber(비서 결과)`, 아니면 0. 공통 결과를 `shiftContext(…, offset)` 한 뒤 맞추고 원문을 자른다. 조각 순서는 비서 → 공통
  - 프롬프트(`docSearchAddendum` 입력에 `commonContext`·`commonOrgType`·`searchedCommon` 추가): 근거가 있으면 `참고 자료(이 기관 문서):`/`참고 자료(공통 기준 — {유형} 공통, 정부 기준 문서):` 머리로 있는 쪽만 싣고, 공통 조각이 있을 때만 인용 규칙 끝에 설계 5.4의 두 줄을 **글자 그대로** 더한다. 근거가 없고 공통을 찾은 턴이면 `NO_RESULT` 둘째 줄을 `이 비서의 문서와 공통 기준 자료에서 이번 질문과 관련된 내용을 찾지 못했습니다.`로
  - `/verify`: 비서 조각만 → `verifySourcesOf(비서 sources)`·`verifyTenant` 없음; 공통 조각만 → `verifySourcesOf(공통 sources)`·`verifyTenant = commonTenant(유형)`; 둘 다 → 빈 배열
  - `searchAgentDocuments`(rag-test)는 비서 보관함만 그대로 둔다(관리자 검색 시험은 그 비서 문서를 본다 — 계획 판단)

- [ ] **Step 1: 실패하는 시험 — `tests/doc-search-noda.test.ts`에 더함**

```ts
it('preflight — 비서·공통 ready 유무에 따라 /context 0·1·2번, 둘이면 3000·2000 예산으로 동시에', ...);
it('preflight — 공통만 실패해도 503 documents_unavailable', ...);
it('preflight — 유형 없는 기관·목록 밖 유형은 공통 행을 조회하지도 않는다', ...);      // Review Focus 5
it('preflight — 유형 조회·공통 행 조회 실패는 503', ...);
it('prepare — 비서 근거 먼저, 공통 번호를 비서 최대 번호만큼 밀고 scope common·editionYear', ...);
it('prepare — 비서 조각이 없으면 공통 번호를 밀지 않고 verifyTenant는 공통 보관함', ...);   // Review Focus 4
it('prepare — 둘 다 조각이 있으면 verifySources 빈 배열', ...);
it('prepare — 다른 유형 공통 근거는 섞임: 전체 근거 버림·critical', ...);
it('prepare — 유형을 바꾼 기관은 새 유형 보관함만 찾는다(옛 유형 행은 조회되지 않음)', ...);  // Review Focus 1
it('prepare — 공통 고아는 공통만 버리고 사본 삭제, 비서 근거는 남음', ...);
it('addendum — 공통 조각이 있을 때만 두 줄·머리 둘, 근거 없음 문구가 공통까지 넓어짐', ...);
```
`tests/stream-turn.test.ts`: `verifyTenant`가 있으면 그 보관함으로 `/verify`. `tests/message-persistence.test.ts`: 조각의 `scope`·`editionYear`가 답변 행에 실리고 두 행의 칸 집합은 같다.

- [ ] **Step 2: 실행해 실패 확인**
- [ ] **Step 3: 구현** — 기본 deps의 `orgTypeOf`는 `organizations.type`, `commonDocumentsOf`는 `common_documents`에서 `id, title, edition_year, org_type, noda_status, retired_at` (`org_type` = 유형)
- [ ] **Step 4: 실행** — `npm test`(Git Bash) 전부 PASS, `npx tsc --noEmit`
- [ ] **Step 5: 커밋** `feat: S5 — 문서 찾기가 공통 보관함까지, 검증 보관함, 조각 칸 저장`

---

### Task 6: 운영자 API

**Files:**
- Create: `src/app/api/super/common-documents/route.ts`(GET 목록·POST 확인), `src/app/api/super/common-documents/upload-url/route.ts`(POST), `src/app/api/super/common-documents/[id]/route.ts`(DELETE), `src/app/api/super/common-documents/[id]/read/route.ts`(POST, `maxDuration = 300`), `src/lib/common-upload.ts`, `tests/common-upload.test.ts`
- Modify: `tests/route-auth.test.ts`(바꿀 것 없으면 그대로 — 모든 핸들러가 `getSuperAdminFromRequest`를 부르는지 이 시험이 본다)

**Interfaces:**
- Consumes: Task 1, Task 3(`commonReadingDeps`·`deleteCommonDocument`), 기존 `checkUploadFile`·`DOCUMENT_CONFIRM_WINDOW_MS`·`readDocument`·`reconcileReading`·`startReadingFields`
- Produces (in `common-upload.ts`, 순수):
  - `export function commonStoragePath(input: { orgType: OrgType; now: number; id: string; ext: string }): string` → `common/{열쇠}/{now}-{id}.{ext}`
  - `export function parseCommonStoragePath(path: string): { key: string; issuedAt: number; id: string; ext: string } | null`
  - `export type CommonConfirmInput = { storage_path; file_name; file_type; org_type; title; edition_year; usage_terms; replaces_id? }`
  - `export function checkCommonConfirm(input: unknown, now: number): { ok: true; value: … } | { ok: false; status: 400 | 410; message: string }` — 유형 밖·이름 빈 글·연도 범위 밖·이용 조건 빈 글·경로 모양·경로 열쇠 ≠ 유형 열쇠·10분 지남(410)을 한국어로 거절
- 라우트 규칙:
  - 모든 핸들러 첫 줄 `const admin = getSuperAdminFromRequest(request); if (!admin) 401` (`{ ok:false, error:{ message:'인증이 필요합니다.' } }`)
  - 발급: `checkUploadFile` 통과 → `createSignedUploadUrl(path)` → `{ ok:true, data:{ path, token } }`
  - 확인: `checkCommonConfirm` → 저장소 크기 확인(문서 확인 라우트의 `storedSize` 꼴, 넘으면 413) → 같은 유형·같은 이름 현재 판이 있고 그 id ≠ `replaces_id`면 409 `같은 이름의 문서가 이미 있습니다 — '바꿀 옛 판'으로 고르세요` → `replaces_id`는 같은 유형·현재 판·`deleting` 아님이어야(아니면 400) → 행 넣기(`startReadingFields`, `noda_filename = commonNodaFilename`, `uploaded_by = admin.sub`) → `super_admin_logs` `common_document_uploaded`(`after_data`: 이름·유형·연도·이용 조건·replaces_id) → `{ ok:true, data:{ id } }`
  - 읽기: `readDocument(id, { retry }, commonReadingDeps())` → `{ ok:true, data: outcome }`
  - 목록: `?org_type=`(없으면 전부) — 행에서 `storage_path`·`noda_filename`·시각 칸을 빼고 내보낸다. `reading` 행은 `reconcileReading(rows, commonReadingDeps())`로 맞추고(실패해도 목록은 그대로) `kick` 하나를 싣는다
  - 삭제: `deleteCommonDocument` → 404·502(`문서 보관소에서 지우지 못했습니다. 잠시 뒤 다시 지워 주세요.`)·200, 성공 시 `super_admin_logs` `common_document_deleted`

- [ ] **Step 1: 실패하는 시험 — `tests/common-upload.test.ts`**

```ts
it('경로 — common/{열쇠}/{발급시각}-{id}.{ext}, 거슬러 오르는 조각 거절', ...);
it('확인 검사 — 유형 밖·이름 빈 글·연도 1999/2101·이용 조건 공백·경로 열쇠 불일치는 400, 10분 지남은 410', ...);
it('라우트 원본 — 다섯 핸들러 모두 getSuperAdminFromRequest, 확인이 409 문구·super_admin_logs, 읽기 maxDuration 300, 목록이 noda_filename·storage_path를 내보내지 않음', ...);
```
- [ ] **Step 2: 실행해 실패 확인**
- [ ] **Step 3: 구현**
- [ ] **Step 4: 실행** — `npx vitest run tests/common-upload.test.ts tests/route-auth.test.ts` PASS, `npx tsc --noEmit`
- [ ] **Step 5: 커밋** `feat: S5 — 공통 자료실 운영자 API`

---

### Task 7: 운영자 화면

**Files:**
- Create: `src/app/super/common-library/page.tsx`, `src/lib/common-upload-client.ts`, `tests/common-library-ui.test.ts`
- Modify: `src/components/super/SuperNav.tsx`

**Interfaces:**
- Consumes: Task 6 API, Task 1 `ORG_TYPES`
- Produces: `uploadCommonDocument(file: File, meta: { org_type; title; edition_year; usage_terms; replaces_id? }, onStage?): Promise<{ ok: true; id: string } | { ok: false; message: string }>` — 발급 → `supabase.storage.from(SUPABASE_DOCUMENTS_BUCKET).uploadToSignedUrl` → 확인 → 읽기 요청(`keepalive`, 기다리지 않음). `document-upload-client.ts`와 같은 꼴, `config-public.ts`만 가져온다
- 화면(설계 6절): 슈퍼관리자 화면의 기존 다크 스타일(`organizations/page.tsx` 꼴). 메뉴 `{ href: '/super/common-library', label: '공통 자료실', icon: '📚' }`를 '기관 관리' 다음에. 유형 탭 · 현재 판 표(이름·연도·상태 칩·올린 때·크기·지우기·실패 시 다시 시도) · 접힌 '지난 판' · 올리기 폼(파일·이름·연도·이용 조건 필수·바꿀 옛 판 선택). 목록 새로고침은 `DocumentsManager`처럼 앞 응답 뒤 `setTimeout` 사슬(읽는 중이 있을 때만, 5초), 늦게 온 응답은 순번으로 버림, `kick` 행이 오면 그 id로 읽기 요청

- [ ] **Step 1: 시험 — `tests/common-library-ui.test.ts`** (원본 글 검사, 기존 `chat-documents-ui.test.ts` 꼴): 메뉴 항목, `setTimeout` 사슬·`setInterval` 없음, 순번 검사, 이용 조건 필수, `config.ts` import 없음, 화면 문구 `지난 판`·`바꿀 옛 판`
- [ ] **Step 2: 실행해 실패 확인**
- [ ] **Step 3: 구현**
- [ ] **Step 4: 실행** — `npx vitest run tests/common-library-ui.test.ts tests/config-public-guard.test.ts` PASS, `npx tsc --noEmit`
- [ ] **Step 5: 커밋** `feat: S5 — 공통 자료실 운영자 화면`

---

### Task 8: 대화 화면의 `[공통]` 표시

**Files:**
- Modify: `src/components/chat/source-label.ts`, `src/components/chat/SourceCitation.tsx`, `src/components/chat/SourcePanel.tsx`
- Test: `tests/chat-documents-ui.test.ts`

**Interfaces:**
- Produces: `export function sourceTitleLabel(c: { documentTitle?: string; scope?: 'common'; editionYear?: number }): string` — 공통이면 `[공통] {제목}({연도})`(연도 없으면 괄호 없이), 아니면 지금 제목 그대로(`{uuid}__` 떼기 유지)
- 칩: `[1] [공통] 예산편성기준(2026) · p.12`. 근거 창 머리 아래 한 줄 `공통 기준 · {연도}년 판`(유형 이름은 조각에 없으므로 싣지 않는다 — 계획 판단)

- [ ] **Step 1: 시험** — `sourceTitleLabel` 세 경우, 칩·창이 이 함수를 쓰는지(원본 검사), `scope` 없는 옛 조각은 그대로
- [ ] **Step 2: 실행해 실패 확인**
- [ ] **Step 3: 구현**
- [ ] **Step 4: 실행** — `npx vitest run tests/chat-documents-ui.test.ts` PASS
- [ ] **Step 5: 커밋** `feat: S5 — 출처에 [공통]·기준 연도`

---

### Task 9: 문서 · 마무리 검증

**Files:**
- Modify: `CLAUDE.md`, `docs/superpowers/specs/2026-10-14-workon-service-definition-design.md`(9절 표 S5에 `✅ 2026-10 구현`)

- [ ] **Step 1: `CLAUDE.md`** — 디렉토리 구조(`org-types.ts`·`common-documents.ts`·`doc-search-common.ts`·`common-upload*.ts`), 라우트 수(100 → 104)·슈퍼관리자 그룹(`/api/super/**` 38개), 마이그레이션 표에 0033(**코드 배포 전에 적용**), 'RAG 파이프라인'에 '공통 자료실 (S5)' 절(보관함·파일 이름·찾기 흐름·번호·검증 표·판 바꾸기·섞임/고아·운영자 화면), 배포 순서 절(설계 9절), 테스트 표에 새 시험 파일 행·`npm test` 개수
- [ ] **Step 2: 검증** — Git Bash `npm test` 전부 PASS(개수 기록), `npx tsc --noEmit`, `npx next build`(메모리가 모자라면 그 사실을 기록하고 tsc·test로 갈음)
- [ ] **Step 3: 커밋** `docs: S5 공통 자료실 — CLAUDE.md`
