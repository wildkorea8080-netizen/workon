# S3-b 표 합치기·엑셀·숫자 확인 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 첨부한 여러 표를 비서가 "어떻게 합칠지"만 정하고 프로그램이 쌓기·묶기·합계를 계산해 엑셀(계산 근거 시트 포함)로 내보내며, 답변 속 숫자가 원본·계산 결과에 없으면 "확인되지 않은 숫자"로 표시한다.

**Architecture:** 순수 함수 표 계산 엔진(`src/lib/table-engine/`)이 S3-a의 `ExtractedTable`과 AI의 지시(`CombineSpec`)를 받아 결과 표와 근거(lineage)를 낸다. 능력 `table_merge`가 도구 `combine_tables`로 엔진을 부르고, 요청이 있으면 같은 호출에서 엑셀(`src/lib/xlsx-export.ts`)을 만들어 S2의 생성 파일 보관에 넣는다. 도구가 AI에게 보여 준 숫자를 실행기가 모아 답변과 대조하고(`number-check.ts`) 결과를 메시지와 SSE `done`에 싣는다.

**Tech Stack:** TypeScript · exceljs(이미 의존성, 동적 import) · vitest · 기존 대화 실행기·능력 장치·생성 파일 보관

**Spec:** `docs/superpowers/specs/2026-10-17-s3-file-read-table-merge-design.md` (5절 전부, 6절의 숫자 확인·SSE·배지, 10절 판단 5~9)

## Global Constraints

- **마이그레이션 없음.** 생성 파일은 `generated_files`에 `template_ref='table_merge'`, `template_name='표 합치기'`로 넣는다(0029의 NOT NULL)
- 숫자는 **AI가 계산하지 않는다** — 합계·평균·개수·최소·최대·합계 행은 엔진만 낸다
- 숫자로 못 읽은 칸은 **0이 아니라 '읽지 못함'** — 집계에서 빼고 위치·원래 글을 근거에 남긴다
- 원천의 **'합계'·'소계'·'계'·'총계' 행은 기본으로 뺀다**(첫 칸 글, 공백 무시 비교) — 뺀 행을 근거에 남긴다
- 같은 결과 열로 쌓이는 원천들의 **알려진 단위가 서로 다르면 집계를 거부**하고 원천별 단위를 돌려준다. `scale`을 준 원천 열은 비교에서 빼고 근거에 남긴다. 일부만 단위를 모르면 경고
- 결과 상한 **5,000행**(넘으면 자르고 경고), 도구 결과에 보이는 행은 **처음 30행** + 합계 행
- 엑셀 값은 **계산된 값**(수식 아님), 글자 칸이 `=`·`+`·`-`·`@`로 시작하면 앞에 `'`
- 숫자 확인: 답변에서 **4자리 미만 정수·연도(1900~2100 단독)·날짜·시각**은 뺀다. 표시 문구 그대로: `원본·계산 결과에서 확인되지 않은 숫자: {목록 ' · '로} — 직접 확인하세요`. 답변 글은 고치지 않는다
- 격리: 도구 입력은 ref(`a1`·`t1`)뿐, 표는 `ctx.attachments`와 사용자 조건으로 다시 찾는다(S3-a 규칙)
- 사용 기록 `usage_logs.action='table_merged'`(토큰 없음), `details`: `sources`·`result_rows`·`unreadable`·`exported`·`agent_id` — 파일 이름 없음
- 오류는 한국어, 커밋 끝 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## Review Focus

1. 원천 표 안에 이미 '합계'·'소 계' 행이 있음 → 기본으로 빠져 두 번 더해지지 않는다(Task 2)
2. 파일 A는 '(단위: 천원)', 파일 B는 '예산(원)' → 집계 거부·원천별 단위 안내, `scale`로 맞추면 통과·근거 기록(Task 2)
3. '총무과'와 '총무 과'·전각 공백 '총무과　' → 앞뒤·전각 공백만 다듬어 같게, 가운데 공백은 다른 키 + 비슷한 키 경고(Task 3)
4. 답변의 반올림 값(원본 36.5853 → 답 "36.6%")은 확인됨, 원본에 없는 5자리 숫자는 표시, `1,234`·`△1,234`·`(1,234)` 표기 차이는 같은 값(Task 6)
5. 엑셀 칸 글 `=HYPERLINK("http://x")`·`+1`·`@SUM` → 수식이 아니라 글자로 열린다(Task 4)

---

## 파일 구조

| 파일 | 책임 |
|---|---|
| `src/lib/table-engine/number.ts` | 칸 → 숫자/빈 값/읽지 못함 + 칸 단위 |
| `src/lib/table-engine/units.ts` | 열 단위 찾기(칸·머리글 괄호·캡션), 단위 이름 다듬기 |
| `src/lib/table-engine/types.ts` | `CombineSpec`·`SourceTable`·`CombineResult`·`Lineage` |
| `src/lib/table-engine/combine.ts` | 원천 준비 → 쌓기 → 거르기 → 묶기·집계 → 정렬 → 합계 행 |
| `src/lib/table-engine/describe.ts` | 지시를 사람이 읽는 문장으로(근거 시트·도구 결과) |
| `src/lib/xlsx-export.ts` | 결과·계산 근거 두 시트 엑셀 |
| `src/lib/capabilities/attachment-access.ts` | 턴 안 첨부 찾기·본문 불러오기(캐시) — `file-read.ts`에서 옮김 |
| `src/lib/capabilities/table-merge.ts` | 능력 `table_merge`·도구 `combine_tables` |
| `src/lib/assistant/number-check.ts` | 숫자 뽑기·대조 |

---

### Task 1: 숫자 읽기와 단위

**Files:**
- Create: `src/lib/table-engine/number.ts`, `src/lib/table-engine/units.ts`
- Test: `tests/table-engine-number.test.ts`, `tests/table-engine-units.test.ts`

**Interfaces:**
- Produces:
  - `type Parsed = { kind: 'empty' } | { kind: 'number'; value: number; unit?: string; percent?: boolean } | { kind: 'unreadable'; text: string }`
  - `parseNumber(cell: string | number | null): Parsed`
  - `normalizeUnit(raw: string): string | null` — 알려진 단위 `원`·`천원`·`백만원`·`억원`·`조원`·`%`·`명`·`건`·`개`·`개소`·`회`·`톤`·`kg`·`ha`·`㎡`(공백 제거, `천 원`→`천원`), 모르면 null
  - `columnUnit(input: { columnName: string; caption?: string; cells: (string | number | null)[] }): string | null` — 순서: 칸 표기의 과반 단위 → 열 이름의 괄호(`예산(천원)`·`예산 (단위:천원)`) → 캡션의 `단위` 표기(`(단위: 천원)`·`단위 : 천원`)

`parseNumber` 규칙(설계 5.1 표): 숫자 그대로 · `1,234`/`1234`/`1,234.5` · `1,234원`/`₩1,234`/`1,234 천원`(unit) · `△1,234`/`▲1,234`/`-1,234`/`(1,234)` → 음수 · `12.5%` → 12.5 + percent · 빈칸·공백·`-`·`—`·`–` → empty · 그 밖(`미제출`·`해당없음`·`1,2,3`·`1.2.3`·`12ab`) → unreadable. 앞뒤 공백·전각 공백은 다듬는다.

- [ ] **Step 1: 실패하는 테스트**

```ts
it.each([
  ['1,234', 1234], ['1234', 1234], ['1,234.5', 1234.5], [1234, 1234],
  ['△1,234', -1234], ['▲ 50', -50], ['-1,234', -1234], ['(1,234)', -1234],
])('%s → %s', (cell, value) => expect(parseNumber(cell)).toMatchObject({ kind: 'number', value }));
it('단위가 붙은 칸', () => {
  expect(parseNumber('1,234원')).toEqual({ kind: 'number', value: 1234, unit: '원' });
  expect(parseNumber('1,234 천원')).toEqual({ kind: 'number', value: 1234, unit: '천원' });
  expect(parseNumber('₩1,234')).toEqual({ kind: 'number', value: 1234, unit: '원' });
  expect(parseNumber('12.5%')).toEqual({ kind: 'number', value: 12.5, unit: '%', percent: true });
});
it.each([null, '', '  ', '-', '—', '–'])('빈 값: %s', (c) => expect(parseNumber(c)).toEqual({ kind: 'empty' }));
it.each(['미제출', '해당없음', '1,2,3', '1.2.3', '12ab'])('읽지 못함(0이 아님): %s', (c) =>
  expect(parseNumber(c)).toEqual({ kind: 'unreadable', text: c }));
// units
it('열 단위: 칸 → 머리글 괄호 → 캡션', () => {
  expect(columnUnit({ columnName: '예산', cells: ['100원', '200원', 300] })).toBe('원');
  expect(columnUnit({ columnName: '예산(천원)', cells: [100] })).toBe('천원');
  expect(columnUnit({ columnName: '예산 (단위: 백만원)', cells: [1] })).toBe('백만원');
  expect(columnUnit({ columnName: '예산', caption: '(단위 : 천 원) <표 2>', cells: [1] })).toBe('천원');
  expect(columnUnit({ columnName: '부서', cells: ['총무과'] })).toBeNull();
});
```

- [ ] **Step 2:** `npx vitest run tests/table-engine-number.test.ts tests/table-engine-units.test.ts` → FAIL(모듈 없음)
- [ ] **Step 3:** 구현. 정규식 하나에 모든 꼴을 몰지 말고, 다듬기 → 부호(△▲·괄호·-) → 단위 접미/접두 → 숫자 본문(`^\d{1,3}(,\d{3})+(\.\d+)?$|^\d+(\.\d+)?$`) 순서로
- [ ] **Step 4:** PASS
- [ ] **Step 5: 커밋** `feat: 표 계산 엔진 — 숫자 읽기(△·괄호 음수·단위)와 열 단위 찾기`

---

### Task 2: 원천 준비와 쌓기 (단위 충돌·합계 행 빼기)

**Files:**
- Create: `src/lib/table-engine/types.ts`, `src/lib/table-engine/combine.ts`
- Test: `tests/table-engine-combine.test.ts`

**Interfaces:**
- Consumes: `parseNumber`·`columnUnit` (Task 1), `ExtractedTable`·`Cell`·`TableMerge` (`src/lib/attachments/types.ts`), `columnNames` (`src/lib/attachments/header.ts`)
- Produces (`types.ts`):

```ts
export interface SourceSpec {
  file: string; table: string;
  header_rows?: [number, number];          // 1부터, 화면 표기
  rename?: Record<string, string>;
  scale?: Record<string, number>;
  skip_rows_matching?: string[];
}
export interface CombineSpec {
  sources: SourceSpec[];
  filter?: { column: string; op: '=' | '!=' | '>' | '>=' | '<' | '<=' | 'contains'; value: string | number }[];
  group_by?: string[];
  aggregate?: { column: string; fn: 'sum' | 'count' | 'avg' | 'min' | 'max'; as?: string }[];
  sort?: { column: string; desc?: boolean }[];
  add_source_column?: boolean;
  total_row?: boolean;
}
export interface SourceTable { spec: SourceSpec; fileName: string; table: ExtractedTable }
export interface ResultColumn { name: string; unit: string | null; numeric: boolean }
export interface Lineage {
  sources: { file: string; fileName: string; table: string; title: string; headerRows: [number, number]; rowsIn: number; rowsUsed: number }[];
  renamed: { file: string; from: string; to: string }[];
  scaled: { file: string; column: string; factor: number }[];
  skippedRows: { file: string; table: string; row: number; reason: string; text: string }[];   // row: 원본 1부터
  unreadable: { file: string; table: string; row: number; column: string; text: string }[];
  mergedNumbers: { file: string; table: string; row: number; column: string }[];  // 세로 병합 숫자 — 한 번만 셈
  onlyIn: { column: string; files: string[] }[];
  unitWarnings: string[];
  similarKeys: string[][];
  rowCounts: { stacked: number; filtered: number; result: number };
  truncated: boolean;
}
export type CombineResult =
  | { ok: true; columns: ResultColumn[]; rows: (string | number | null)[][]; total: (string | number | null)[] | null; lineage: Lineage }
  | { ok: false; error: string };
```

- `combineTables(sources: SourceTable[], spec: CombineSpec): CombineResult` (in `combine.ts`) — 이 Task는 **원천 준비와 쌓기**까지(거르기·묶기·정렬·합계 행은 Task 3이 같은 함수에 더한다). 이 Task 끝에서 거르기·묶기 없는 지시는 쌓은 결과를 그대로 돌려준다

원천 준비(원천마다):
1. 머리글: `header_rows`가 있으면 `columnNames(cells, merges, { from: a-1, to: b-1 })`로 다시 만들고, 없으면 `table.header`·`table.columns`
2. 본문 = 머리글 다음 행부터. **세로 병합된 글자 칸은 아래로 채우고**(묶음 키가 비지 않게), 세로 병합된 숫자 칸은 주인 칸에만 두고 `mergedNumbers`에 남긴다. 머리글 병합은 이미 이름에 반영
3. 빈 행(모든 칸 빈 값) 빼기 — 근거에 남기지 않는다
4. 합계 행 빼기: 첫 비지 않은 칸 글에서 공백을 지운 값이 `합계`·`소계`·`계`·`총계` 또는 `skip_rows_matching`의 값(공백 지워 비교)과 같으면 뺀다 → `skippedRows`(reason `'합계 행'` / `'지정한 글'`)
5. `rename` 적용(원래 열 이름 → 새 이름). 없는 원래 이름을 가리키면 실패
6. 열 단위 = `columnUnit({ columnName: 원래 이름, caption, cells })`. `scale`이 있는 열은 숫자에 곱하고 `scaled`에 남긴다(그 열 이름이 없으면 실패)

쌓기: 결과 열 = 원천 열 이름의 합집합(처음 나온 순서). 원천에 없는 열은 null. `add_source_column`이면 맨 앞 `출처` 열(값 = fileName). 한 원천에만 있는 열은 `onlyIn`.
단위: 결과 열마다 scale을 주지 **않은** 원천들의 알려진 단위를 모아 둘 이상이면 **실패**:
`'열 "예산"의 단위가 원천마다 다릅니다: a1/t1=천원, a2/t1=원. scale로 맞춘 뒤 다시 계산하세요(예: a2의 "예산"에 0.001).'`
알려진 단위 1개 + 단위를 모르는 원천이 있으면 `unitWarnings`에 `'열 "예산": a2/t1은 단위를 알 수 없습니다 — 같은 단위인지 확인하세요'`. 결과 열 이름은 단위가 정해지면 `예산(천원)`(이미 괄호 단위가 있으면 그대로).
숫자 열 판정: 그 열의 비지 않은 값의 과반이 number면 `numeric`. 숫자 열의 unreadable 칸은 `unreadable`에 남기고 값은 null(0 아님).
없는 열·없는 표·없는 원천을 가리키면 실패하고 **그 표의 실제 열 이름**을 돌려준다: `'a1/t1에 "예산액" 열이 없습니다. 있는 열: 부서, 예산(천원), 비고'`.

- [ ] **Step 1: 실패하는 테스트** — `tests/table-engine-combine.test.ts`에 작은 `ExtractedTable` 만드는 도우미(`buildTable` 사용)

```ts
it('두 파일을 열 이름으로 쌓고 출처 열을 붙인다', ...);         // columns 출처·부서·예산, rows 4, onlyIn 없음
it('원천의 합계·소 계 행은 기본으로 빠지고 근거에 남는다', ...);  // Review Focus 1 — rows에 '합계' 없음, skippedRows 2건(row 원본 번호)
it('skip_rows_matching으로 더 뺀다', ...);
it('단위가 다르면 거부하고 원천별 단위를 알려 준다', ...);       // Review Focus 2 — ok:false, error에 '천원'·'원'·'scale'
it('scale로 맞추면 통과하고 근거에 남는다', ...);               // a2 예산 0.001 → 값 확인, lineage.scaled
it('일부만 단위를 모르면 경고', ...);
it('읽지 못한 칸은 null로 두고 위치를 남긴다(0 아님)', ...);    // '미제출' → null, unreadable[0] = { row, column, text:'미제출' }
it('세로 병합된 부서 칸은 아래로 채우고, 병합된 숫자는 한 번만', ...);
it('rename으로 열 이름을 맞춘다', ...);
it('없는 열이면 실제 열 이름을 돌려준다', ...);
it('header_rows로 머리글을 다시 잡는다', ...);
```

- [ ] **Step 2:** FAIL 확인
- [ ] **Step 3:** 구현
- [ ] **Step 4:** PASS, `npx tsc --noEmit`
- [ ] **Step 5: 커밋** `feat: 표 계산 엔진 — 원천 준비·쌓기, 합계 행 빼기·단위 충돌 거부`

---

### Task 3: 거르기·묶기·집계·정렬·합계 행·지시 문장

**Files:**
- Modify: `src/lib/table-engine/combine.ts`
- Create: `src/lib/table-engine/describe.ts`
- Test: `tests/table-engine-combine.test.ts`(추가), `tests/table-engine-describe.test.ts`

**Interfaces:**
- Produces: `describeSpec(spec: CombineSpec, fileNames: Record<string, string>): string[]` — 사람이 읽는 문장 목록. 예: `['원천: 예산.xlsx(t1), 현황.xlsx(t1)', '거르기: 구분 = 사업비', '부서 기준으로 묶어 예산(천원) 합계', '정렬: 예산(천원) 큰 순', '맨 아래 합계 행']`

규칙:
- 거르기: 숫자로 읽히는 값끼리는 숫자 비교, 아니면 글자 비교(다듬은 값). `contains`는 글자 포함. 없는 열이면 실패(실제 열 목록)
- 묶음 키 다듬기: 앞뒤 공백·전각 공백(U+3000)·연속 공백 1개로. **가운데 공백은 남긴다**('총무과' ≠ '총무 과'). 공백을 모두 지우면 같아지는 서로 다른 키가 있으면 `similarKeys`에 묶어 남긴다
- 집계: `sum`·`avg`·`min`·`max`는 숫자 열에만(아니면 실패 `'"부서"는 숫자 열이 아니라 합계를 낼 수 없습니다'`), null(빈 값·읽지 못함)은 빼고 계산. `count`는 그 열의 비지 않은 값 수. 결과 열 이름 = `as` 또는 `{열} {합계|개수|평균|최소|최대}`, 단위는 원래 열 단위(`count`는 null). 묶기 없이 집계만 있으면 한 행
- 묶기 없이 집계도 없으면 쌓은 행 그대로
- 정렬: 여러 기준, 숫자 열은 숫자로, 글자는 `localeCompare('ko')`, null은 맨 뒤
- 합계 행(`total_row`): 숫자 열(집계했으면 count 제외 sum/집계 열, 아니면 숫자 열) 합, 첫 글자 열에 `'합계'`, 나머지 null. avg·min·max 열은 합계 행에서 null(합이 의미 없으므로)
- 5,000행 초과 → 자르고 `truncated: true`, `unitWarnings` 아닌 별도 경고는 근거 요약에서 보이게(`truncated`)
- 부동소수 오차: 합·평균은 소수 10자리에서 반올림해 돌려준다(엑셀·답변에 `0.30000000000000004`가 나오지 않게)

- [ ] **Step 1: 실패하는 테스트**

```ts
it('부서 기준 묶어 합계·개수, 합계 행', ...);                 // rows [['총무과',300,2],['기획과',50,1]], total ['합계',350,null]
it('읽지 못한 칸은 합계에서 빠진다(0으로 치지 않음)', ...);    // 100 + '미제출' + 50 → 150, unreadable 1
it('묶음 키는 앞뒤·전각 공백만 다듬고, 가운데 공백은 다른 키 + 비슷한 키 경고', ...); // Review Focus 3
it('거르기: 숫자 비교·contains', ...);
it('정렬: 숫자 큰 순, null은 뒤', ...);
it('0.1 + 0.2 = 0.3', ...);
it('글자 열 합계는 실패', ...);
it('5,000행 초과는 자르고 truncated', ...);
// describe
it('지시를 문장으로', ...);
```

- [ ] **Step 2:** FAIL 확인 → **Step 3:** 구현 → **Step 4:** PASS
- [ ] **Step 5: 커밋** `feat: 표 계산 엔진 — 거르기·묶기·집계·정렬·합계 행, 지시 문장`

---

### Task 4: 엑셀 생성기

**Files:**
- Create: `src/lib/xlsx-export.ts`
- Test: `tests/xlsx-export.test.ts`

**Interfaces:**
- Consumes: `ResultColumn`·`Lineage` (Task 2)
- Produces: `buildResultWorkbook(input: { title: string; columns: ResultColumn[]; rows: (string | number | null)[][]; total: (string | number | null)[] | null; lineage: Lineage; specSentences: string[]; createdAt: Date }): Promise<Buffer>`

시트 1 `결과`: 첫 행 머리글(굵게, 고정 `views: [{ state: 'frozen', ySplit: 1 }]`), 숫자 열 `numFmt` = 값에 소수가 있으면 `#,##0.##`, 아니면 `#,##0`, 열 너비 = 글자 수 기준(한글은 2칸, 최소 8 최대 50), 합계 행 굵게.
시트 2 `계산 근거`: `만든 때`(KST, `YYYY-MM-DD HH:mm`), `원천` 파일·표·머리글 행·행 수, `지시`(specSentences), `이름 맞추기`, `단위 맞추기`, `뺀 행`(파일·표·행·이유·글), `읽지 못한 칸`, `한 번만 센 병합 숫자`, `한쪽에만 있는 열`, `경고`(unitWarnings·similarKeys·truncated). 비어 있는 항목은 `없음`.
값은 계산된 값만(수식 칸 없음). 글자 칸이 `=`·`+`·`-`·`@`로 시작하면 앞에 `'`(근거 시트 포함). 숫자는 number로.

- [ ] **Step 1: 실패하는 테스트** — 만든 버퍼를 exceljs로 다시 읽어 확인

```ts
it('결과·계산 근거 두 시트', ...);
it('숫자 서식·머리글 고정·합계 행 굵게', ...);
it('값은 수식이 아니다', ...);                 // 모든 칸 cell.formula undefined
it('수식 주입 글자는 글자로', ...);             // Review Focus 5 — '=HYPERLINK("http://x")' → "'=HYPERLINK…", '+1', '@SUM', '-x'
it('근거 시트에 뺀 행·읽지 못한 칸·지시 문장', ...);
```

- [ ] **Step 2:** FAIL → **Step 3:** 구현(exceljs 동적 import) → **Step 4:** PASS
- [ ] **Step 5: 커밋** `feat: 엑셀 생성기 — 결과와 계산 근거 시트, 수식 주입 방지`

---

### Task 5: 능력 `table_merge`·도구 `combine_tables`

**Files:**
- Create: `src/lib/capabilities/attachment-access.ts`, `src/lib/capabilities/table-merge.ts`
- Modify: `src/lib/capabilities/file-read.ts`(턴 캐시·불러오기를 attachment-access로 옮김 — 동작 그대로), `src/lib/capabilities/settings.ts`(`CAPABILITY_IDS`에 `'table_merge'`, `CapabilitySettings.table_merge?`, `acceptsChatFiles`가 `table_merge`도 참), `src/lib/capabilities/index.ts`(등록), `src/lib/agent-form.ts`(`AgentSettingsValue.table_merge` 왕복, `createCapabilities`의 `fileRead`가 `file_read`와 `table_merge`를 함께 켬), `src/components/agents/AgentEditorModal.tsx`(체크박스 `['table_merge', '표 합치기·집계', '첨부한 표를 합치고 합계를 계산해 엑셀로 만듭니다']`), `src/components/chat/MessageBubble.tsx`(배지 `.xlsx` → `XLS`), `src/app/api/admin/audit-logs/route.ts`·`src/app/api/admin/usage-summary/route.ts`(`table_merged: '표 합치기'`), `scripts/db-check.mjs`(알려진 능력 목록)
- Test: `tests/table-merge-capability.test.ts`, `tests/capabilities.test.ts`, `tests/agent-form.test.ts`, `tests/file-read-capability.test.ts`(옮긴 뒤에도 통과)

**Interfaces:**
- Consumes: `combineTables`·`describeSpec` (Task 2·3), `buildResultWorkbook` (Task 4), `saveGeneratedFile` (`src/lib/generated-files.ts`), `writeUsageLog`, `describeAttachments`·`FILE_READ_GUIDE` (`file-read.ts`), `columnNames`
- Produces:
  - `attachment-access.ts`: `findAttachment(ctx: TurnContext, ref: string): TurnAttachment | null` · `loadTurnExtract(ctx: TurnContext, attachment: TurnAttachment): Promise<AttachmentExtract | null>`(턴별 캐시, 사용자·대화 조건으로 기록을 다시 찾음 — 지금 `file-read.ts`의 `defaultDeps` 그대로)
  - `ToolOutcome.shownValues?: number[]` (`capabilities/types.ts`) — Task 6이 모은다. 이 Task에서 `combine_tables`가 채운다
  - 능력 `tableMerge: Capability` — `id:'table_merge'`, `label:'표 합치기·집계'`, `acceptsFiles: true`, `isAvailable: () => true`
    - `prepare(ctx)`: 첨부가 없으면 `{}`. `file_read`가 켜져 있으면(`'file_read' in ctx.capabilities`) 안내만, 아니면 `describeAttachments(ctx.attachments)` + 안내
    - 안내(그대로): `표의 합계·평균·개수는 직접 계산하지 말고 combine_tables 결과에 있는 숫자만 옮기세요. 결과에 없는 숫자(비율·차이 등)를 말해야 하면 직접 계산한 값이라고 밝히세요. 읽지 못한 칸·뺀 행·단위 경고가 있으면 답에 밝히세요. 파일마다 열 이름이 다르면 rename으로 맞추고 그렇게 했다고 말하세요. 어느 열끼리 맞출지 확신이 없으면 직원에게 먼저 물으세요. 엑셀 파일이 필요하면 export에 제목을 주어 같은 호출에서 만드세요.`
    - 도구 `combine_tables` inputSchema: `{ spec: CombineSpec(설계 5.1 그대로의 JSON 스키마), export?: { title: string } }`, `required: ['spec']`. 사용자·대화·uuid 없음
    - `execute`: 원천마다 `findAttachment` → `loadTurnExtract` → 표 id로 찾기(없으면 실패: 그 파일의 표 id 목록) → `combineTables`. 실패면 `{ ok:false, text: error }`. 성공이면 결과 글 = `[계산 결과 — 숫자는 이 결과만 옮기세요]` + 열 목록 + 처음 30행 마크다운(+`… 외 N행`) + 합계 행 + 근거 요약(뺀 행 수와 처음 3개, 읽지 못한 칸 수와 처음 5개, 한 번만 센 병합 숫자 수, 단위 경고, 비슷한 키, 한쪽에만 있는 열, 잘림). `shownValues` = 보여 준 30행과 합계 행의 숫자 전부
    - `export`가 있으면: `buildResultWorkbook`(전체 행) → `saveGeneratedFile({ templateRef:'table_merge', templateName:'표 합치기', fileName: safeFileName(title,'xlsx'), extension:'xlsx', mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', … })` → `files`. 결과 글에 `엑셀 파일을 만들었습니다: {이름}`. 저장 실패면 계산 결과는 그대로 돌려주고 `엑셀 파일은 만들지 못했습니다: {이유}`
    - 사용 기록: `writeUsageLog({ action:'table_merged', resourceType:'conversation', resourceId: ctx.conversationId, details:{ sources, result_rows, unreadable, exported, agent_id } })`
- 실행기의 `acceptsFiles` 판정·`attachmentRequestError`는 능력 속성을 보므로 table_merge만 켠 비서도 첨부를 받는다(코드 변경 없이 — 테스트로 확인)

- [ ] **Step 1: 실패하는 테스트**

```ts
it('combine_tables: 두 첨부 표를 합쳐 결과·근거 요약, shownValues', ...);   // deps 주입으로 extract 가짜
it('없는 ref·없는 표 id는 쓸 수 있는 목록과 실패', ...);
it('엔진 실패(단위 충돌)는 그 글 그대로', ...);
it('export가 있으면 같은 호출에서 엑셀 파일 카드', ...);                   // saveGeneratedFile 가짜, files 1개, template_ref 'table_merge'
it('엑셀 저장 실패해도 계산 결과는 돌려준다', ...);
it('입력 스키마에 uuid·사용자·대화가 없다', ...);
it('file_read가 꺼져 있으면 첨부 목록도 붙인다, 켜져 있으면 안내만', ...);
it('table_merge만 켠 비서도 첨부를 받는다', ...);                         // attachmentRequestError(['x'], [tableMerge]) === null
it('사용 기록에 파일 이름이 없다', ...);
// agent-form: table_merge 왕복, createCapabilities({fileRead:true}) → file_read + table_merge
```

- [ ] **Step 2:** FAIL → **Step 3:** 구현(`file-read.ts`는 import만 바꾸고 기존 테스트가 그대로 통과해야 한다) → **Step 4:** `npm test` 전체, `npx tsc --noEmit`
- [ ] **Step 5: 커밋** `feat: 능력 table_merge — combine_tables로 표 합치기·엑셀, 첨부 접근 공용화`

---

### Task 6: 숫자 확인

**Files:**
- Create: `src/lib/assistant/number-check.ts`
- Modify: `src/lib/capabilities/file-read.ts`(`read_attachment` 결과의 숫자를 `shownValues`로), `src/lib/assistant/stream.ts`(턴 동안 `shownValues` 모으기 · 루프 뒤 대조 · 저장 · `done`에 실음), `src/lib/assistant/persist.ts`(`MessageRowInput.numberCheck`), `src/lib/assistant/types.ts`(`done` 데이터에 `number_check: { unverified: string[] } | null`), `src/components/chat/ChatInterface.tsx`(`done` 받아 패치 + 지난 메시지 `source_references.number_check`), `src/components/chat/MessageBubble.tsx`(표시)
- Test: `tests/number-check.test.ts`, `tests/stream-turn.test.ts`, `tests/message-persistence.test.ts`

**Interfaces:**
- Produces:
  - `numbersIn(text: string): number[]` — 글 안의 모든 숫자(쉼표·소수·△▲·괄호 음수·`%` 앞 숫자). 보여 준 값 모으기용
  - `answerNumbers(text: string): { raw: string; value: number; decimals: number }[]` — 대조 대상만: **4자리 미만 정수 제외**(소수는 포함), 연도 1900~2100 단독 정수 제외, 날짜 꼴(`2026.10.21`·`2026-10-21`·`26. 3. 5.`·`10월 21일`의 숫자)·시각 꼴(`10:30`) 제외, `a1`·`t3` 같은 id 제외
  - `checkNumbers(answer: string, shown: number[]): string[]` — 대조해 못 찾은 `raw`(중복 없이, 나온 순서, 최대 10개). 일치: `|v − shown| ≤ 1e-9·max(1,|v|)` 또는 소수 d자리 답이 `round(shown, d)`와 같음
  - `NUMBER_CHECK_NOTE(list: string[]): string` = `` `원본·계산 결과에서 확인되지 않은 숫자: ${list.join(' · ')} — 직접 확인하세요` ``
- 실행기: 이번 턴에 `read_attachment` 또는 `combine_tables`가 한 번이라도 성공했을 때만 대조. 결과가 비면 `number_check: null`. 있으면 답변 행 `source_references.number_check = { unverified }`(두 행 칸 집합은 그대로 — `source_references`는 한 칸)와 `done` 데이터에 같은 값
- 화면: 답변 말풍선 아래 주황 안내(`NUMBER_CHECK_NOTE`). 진행 중 화면은 `done`에서, 지난 대화는 `source_references.number_check`에서

- [ ] **Step 1: 실패하는 테스트**

```ts
it('표기 차이는 같은 값', () => expect(checkNumbers('합계는 1,234천원, 감소 △5,678', [1234, -5678])).toEqual([]));
it('반올림한 답은 확인됨', () => expect(checkNumbers('비율은 36.6%', [36.5853])).toEqual([]));   // Review Focus 4
it('원본에 없는 5자리 숫자는 표시', () => expect(checkNumbers('총 12,345건', [100, 200])).toEqual(['12,345']));
it('4자리 미만 정수·연도·날짜·시각·id는 대조하지 않는다', () =>
  expect(checkNumbers('2026년 10월 21일 10:30에 a1/t3 표의 상위 3곳, 2026.10.21', [])).toEqual([]));
it('괄호 음수·▲', () => expect(checkNumbers('(1,234) 감소, ▲2,000', [-1234, -2000])).toEqual([]));
it('최대 10개, 중복 없음', ...);
it('numbersIn은 작은 수까지 모은다', () => expect(numbersIn('| 총무과 | 3 | 1,200 |')).toEqual([3, 1200]));
// stream-turn
it('첨부 도구를 쓴 턴은 대조해 done과 답변 행에 싣는다', ...);   // 가짜 도구가 shownValues [100], 답변 '합계 12,345' → unverified ['12,345']
it('첨부 도구를 안 쓴 턴은 대조하지 않는다', ...);              // number_check null
// message-persistence: number_check가 있어도 두 행 칸 집합이 같다
```

- [ ] **Step 2:** FAIL → **Step 3:** 구현 → **Step 4:** `npm test`, `npx tsc --noEmit`, `NODE_OPTIONS=--max-old-space-size=4096 npx next build`
- [ ] **Step 5: 커밋** `feat: 숫자 확인 — 답변 속 숫자를 원본·계산 결과와 대조해 '확인되지 않은 숫자' 표시`
- [ ] **Step 6 (사용자 확인 지점, 배포 뒤):** 비서에 '표 합치기·집계' 켜기 → 엑셀 2개 첨부 → "부서별로 합쳐 예산 합계 엑셀로 줘" → 파일 카드 `XLS` 내려받아 결과·계산 근거 시트 확인 → 답변에 지어낸 숫자가 있으면 주황 안내

---

### Task 7: 문서

**Files:**
- Modify: `CLAUDE.md`

CLAUDE.md: 디렉토리 구조(`table-engine/`·`xlsx-export.ts`·`attachment-access.ts`), 능력 여섯(`table_merge`), "표 합치기 (S3-b)" 절 — 숫자는 엔진만(이유: 합계 오류가 치명적), 숫자 읽기 표·읽지 못함은 0이 아님, 합계 행 기본 제외, 단위 충돌 거부와 `scale`, 묶음 키 다듬기 규칙, 결과 30행·5,000행, 엑셀 두 시트·수식 주입 방지·`template_ref='table_merge'`, 숫자 확인 규칙(빼는 것·반올림 일치·표시 문구·답변은 안 고침·오탐 가능)과 한계(4자리 미만 정수 비율 '22%'는 대조 안 됨), 활동 코드 `table_merged`. 테스트 표에 새 파일들, 테스트 수 두 곳.

- [ ] **Step 1:** 고친다 → **Step 2:** `npm test`로 수 확인 → **Step 3: 커밋** `docs: S3-b 표 합치기·엑셀·숫자 확인 반영`

---

## 설계와 달라지는 점

- 첨부 접근(턴 캐시·본문 불러오기)을 `file-read.ts`에서 `attachment-access.ts`로 옮겨 두 능력이 함께 쓴다(동작 같음)
- 비서 만들기 창의 '대화 중 파일 받기'는 `file_read`와 `table_merge`를 함께 켠다(직원에게 둘을 따로 고르게 하면 '읽기만 되고 합계는 안 되는' 비서가 생긴다). 편집 창에서는 따로 켜고 끈다
- 숫자 확인의 '4자리 미만 정수 제외' 때문에 '22%' 같은 정수 비율은 대조하지 않는다 — 대신 안내가 '결과에 없는 숫자는 직접 계산한 값이라고 밝히라'고 지시한다
