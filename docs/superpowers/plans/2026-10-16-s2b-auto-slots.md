# S2-b 기관 양식 그대로 채우기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기관이 `{{…}}` 표시 없이 올린 HWPX 양식은 번호 제목·표 빈칸을 자동으로 찾아 채우고, DOCX 양식의 표시를 채우며, 채울 수 없는 양식(옛 HWP·자리 없음)은 목차만 읽어 표준 보고서로 대신 만든다.

**Architecture:** S2-a 엔진(`src/lib/doc-fill/`)을 넓힌다. HWPX 공통 처리(열기·문단 훑기·새 문단·편집 적용·zip 다시 묶기)를 `hwpx-core.ts`로 떼고, 표시 채우기(`hwpx.ts`)와 자동 자리(`hwpx-auto.ts`)가 그것을 쓴다. 판정 규칙(번호 제목 급·자리 표시 글자·항목명 다듬기)은 `slots.ts`의 순수 함수다. DOCX는 `docx.ts`, 대체 경로는 `fallback.ts`. 입구 `index.ts`가 "표시 → 자동 자리 → 대체" 순으로 고른다.

**Tech Stack:** TypeScript · `jszip` · `mammoth`(이미 있음, DOCX 본문 읽기) · `hwp.ts`(이미 있음, HWP/HWPX 본문 읽기) · vitest — 새 의존성 없음

**Spec:** `docs/superpowers/specs/2026-10-15-s2-document-fill-design.md` (4.1 자리 · 4.2 채우기 · 4.4 대체 · 4.5 DOCX · 10절 S2-b)

**선행:** S2-a가 main에 병합돼 있다(엔진·`document` 능력·생성 파일). 배포 여부와 무관하다 — S2-b에는 마이그레이션이 없다.

## Global Constraints

- 응답 규약 `{ ok, data }` / `{ ok: false, error: { message } }`, 사용자에게 보이는 문구는 한국어
- **표시가 하나라도 있으면 자동 찾기를 하지 않는다**(설계 4.1)
- HWPX는 본문 XML(`Contents/section*.xml`)만 문자열 단위로 고친다. 서식 정의·그림은 내용 그대로, zip 항목은 원래 압축 방식, `mimetype` 맨 앞 무압축(S2-a 그대로)
- 여분 줄은 원래 문단을 복제하지 않고 **새 문단**(여는 태그 + 글자 서식 하나 + 글 하나)으로 만든다. 쪽·단 나눔은 넘기지 않는다
- 채울 수 없는 것(구역 설정·표·그림 컨트롤을 품은 문단)은 자리로 내놓지 않는다
- 상한: 자리 100곳, 자리 하나 6,000자. 넣는 글의 XML 금지 문자는 뺀다
- 대체 경로는 결과에 그 사실과 이유를 밝힌다(설계 4.4)
- 엔진(`doc-fill/*`)은 DB·저장소·파일 시스템을 모른다 — 바이트를 받아 바이트를 돌려준다
- 커밋 메시지 끝: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## Review Focus

- **결재란 같은 빈칸이 자리로 쏟아진다** — 공문 양식의 결재·협조 칸(항목명만 있고 빈 칸)이 수십 개 자리가 된다 → 그래도 목차 확인 단계에서 거르지만, 표 머리 행의 빈칸·두 항목명 사이 칸이 엉뚱한 이름을 갖지 않아야 한다. Task 3의 '항목명 고르기' 테스트가 고정한다.
- **구역의 첫 문단(구역 설정 `secPr`)이 빈 문단이다** — 자리로 잡혀 통째로 바뀌면 구역 설정이 사라진다 → 컨트롤을 품은 문단은 자리가 아니다. Task 3의 'secPr 문단' 테스트가 고정한다.
- **같은 이름의 자리가 여러 개(비고·비고)** — 이름으로 묶으면 한쪽만 채운다 → 자동 자리는 이름이 아니라 번호로 채운다. Task 3·4의 '같은 이름 두 칸' 테스트가 고정한다.
- **DOCX 문단 속성에 구역 나눔(`w:sectPr`)·쪽 나눔이 있다** — 여분 줄이 그것을 복제하면 줄마다 새 구역·새 쪽이 된다 → 새 문단의 `w:pPr`에서 뺀다. Task 5의 테스트가 고정한다.
- **대체 경로인데 표준 보고서 파일이 아직 없다** — 조용히 실패하면 안 된다 → "표준 서식이 아직 준비되지 않아 대신 만들 수 없다"는 이유를 돌려준다. Task 7의 테스트가 고정한다.

## 설계와 달라지는 점

- **DOCX는 표시만 채운다.** 표시 없는 DOCX는 대체 경로(표준 보고서)로 간다. DOCX 자동 자리는 HWPX의 쓰임을 본 뒤 정한다 — 같은 규칙을 두 형식에 한꺼번에 넣으면 고칠 곳이 둘이 된다
- **문장 속 자리 표시(`일시: ○○○`)는 자리가 아니다.** 문단·칸 전체가 비었거나 자리 표시뿐일 때만 자리다. 문장 속 표시를 자리로 삼으려면 앞뒤 글을 이름으로 갈라야 해서 틀릴 일이 많다 — 기관이 `{{일시}}`로 바꾸면 된다(양식 탭 안내에 적는다)
- **번호 제목 자리는 본문 최상위 문단만.** 표 안의 번호 문단은 표 칸 자리로 다룬다
- **번호 제목 아래에 채울 빈 문단이 없으면 그 제목은 자리가 아니다.** 제목 문단의 서식으로 본문을 쓰면 본문이 제목처럼 보인다

---

## File Structure

| 파일 | 책임 |
|---|---|
| `src/lib/doc-fill/hwpx-core.ts` (새) | HWPX 공통 — 열기·항목 읽기·문단 훑기·새 문단·편집 적용·미리보기·다시 묶기 (S2-a `hwpx.ts`에서 옮김) |
| `src/lib/doc-fill/hwpx.ts` (줄어듦) | 표시 읽기·채우기만 |
| `src/lib/doc-fill/slots.ts` (넓힘) | `headingLevel` · `isPlaceholderText` · `normalizeLabel` |
| `src/lib/doc-fill/hwpx-auto.ts` (새) | 번호 제목·표 빈칸 자리 읽기·채우기 |
| `src/lib/doc-fill/docx.ts` (새) | DOCX 표시 읽기·채우기 |
| `src/lib/doc-fill/fallback.ts` (새) | 대체 경로 — 목차 뽑기·표준 보고서 채우기 |
| `src/lib/doc-fill/index.ts` (고침) | 고르기(표시 → 자동 → 대체) · `mode` · 형식별 결과 |
| `src/lib/capabilities/document.ts` (고침) | 대체용 표준 보고서 넘기기 · `mode`·`reason` 싣기 · 기록에 `mode` |
| `src/components/chat/MessageBubble.tsx` (고침) | 파일 카드 표지(HWP/DOC)를 확장자로 |
| `src/components/agents/TemplatesPanel.tsx` (고침) | 양식 탭 안내 |
| `tests/fixtures/hwpx.ts` (넓힘) · `tests/fixtures/docx.ts` (새) | 시험용 파일 |

---

### Task 1: HWPX 공통 처리 떼어 내기 (동작 그대로)

**Files:**
- Create: `src/lib/doc-fill/hwpx-core.ts`
- Modify: `src/lib/doc-fill/hwpx.ts`

**Interfaces:**
- Produces (`hwpx-core.ts`에서 export — 이름은 S2-a `hwpx.ts` 안의 것을 그대로 쓴다):
  ```typescript
  export interface TextPiece { start: number; end: number; text: string; charPr: string | null }
  export interface Para { start: number; end: number; openTag: string; pieces: TextPiece[]; text: string;
    lineSegs: { start: number; end: number }[]; hasChild: boolean; ancestors: number[] }
  export interface Edit { start: number; end: number; text: string }
  export interface HwpxDoc { zip: JSZip; sections: string[]; methods: Map<string, 'STORE' | 'DEFLATE'> }
  export async function openHwpx(bytes: Buffer): Promise<HwpxDoc>;
  export async function readEntry(zip: JSZip, name: string): Promise<string>;
  export function scanParagraphs(xml: string, prefix: string): Para[];
  export function pieceOffsets(para: Para): number[];
  export const textXml: (s: string) => string;
  export function freshParagraph(openTag: string, charPr: string | null, line: string, prefix: string): string;
  export function valueLines(text: string): string[];   // \r\n 정리 · 금지 문자 제거 · 탭→공백 (planParagraph의 그 처리)
  export function dedupeDeletes(edits: Edit[]): Edit[];
  export function applyEdits(xml: string, edits: Edit[]): string;
  export function ancestorLineSegDeletes(para: Para, byStart: Map<number, Para>): Edit[];
  /** 섹션별 편집을 적용하고 미리보기·mimetype·압축 방식을 맞춰 다시 묶는다 */
  export async function writeHwpx(doc: HwpxDoc, editedSections: Map<string, string>): Promise<Buffer>;
  ```
  `writeHwpx`는 S2-a `fillHwpx`의 뒷부분(바뀐 섹션 쓰기 → 미리보기 다시 쓰기 → mimetype STORE → 항목별 압축 → generateAsync, 실패면 `DocFillError`)을 그대로 옮긴 것이다. 미리보기 글은 `editedSections`와 안 바뀐 섹션을 모두 다시 훑어 만든다.

- [ ] **Step 1: 기존 시험이 초록인지 확인** — Run: `npx vitest run tests/doc-fill-hwpx.test.ts tests/doc-fill-index.test.ts` / Expected: PASS
- [ ] **Step 2: 옮기기** — 위 목록을 `hwpx-core.ts`로 옮기고 `hwpx.ts`는 `readHwpxMarkers`·`fillHwpx`(표시용 `planParagraph`·`labelsInOrder`)만 남겨 core를 import한다. 동작·문구·주석은 바꾸지 않는다
- [ ] **Step 3: 같은 시험이 그대로 초록** — Run: `npx vitest run && npx tsc --noEmit` / Expected: 전부 PASS, 시험 파일은 손대지 않음
- [ ] **Step 4: Commit** — `refactor: HWPX 공통 처리를 hwpx-core로 떼어 냄`

---

### Task 2: 판정 규칙 — 번호 제목 급·자리 표시 글자·항목명

**Files:**
- Modify: `src/lib/doc-fill/slots.ts`
- Test: `tests/doc-fill-slots.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  /** 번호 제목이면 급(작을수록 위), 아니면 null. 앞 공백은 무시 */
  export function headingLevel(text: string): number | null;
  /** 비었거나 자리 표시 글자뿐인가(앞의 번호 기호는 떼고 본다) */
  export function isPlaceholderText(text: string): boolean;
  /** 표 항목명 다듬기: 앞뒤 공백·끝의 ':' 제거, '취    급'처럼 한 글자씩 띄운 것은 붙인다 */
  export function normalizeLabel(text: string): string;
  export const PLACEHOLDER_PATTERNS: readonly RegExp[];
  ```
- 급 표 (설계 4.1 — 이 순서가 값이다):

  | 급 | 기호 (문단 맨 앞) |
  |---|---|
  | 1 | `Ⅰ.`~`Ⅹ.` |
  | 2 | `1.`~`99.` (뒤에 숫자가 바로 오면 아님 — `1.5`) · `□` · `■` |
  | 3 | `가.`~`하.` · `○` · `●` |
  | 4 | `1)`~`99)` · `-` · `–` (뒤에 공백) |
  | 5 | `가)`~`하)` |
  | 6 | `(1)`~`(99)` |
  | 7 | `(가)`~`(하)` |
  | 8 | `①`~`⑳` |
  | 9 | `㉮`~`㉻` |

  제목 판정 조건: 기호 뒤 글이 1~40자이고 문장 끝 표시(`다.`·`요.`·`음.`·`함.`)로 끝나지 않는다 — 본문 글머리(`○ 사업기간은 1년이다.`)를 제목으로 잡지 않기 위해서다.
- 자리 표시 글자: `○○○`·`OOO`·`ㅇㅇㅇ`처럼 같은 글자 3개 이상 반복, `(내용)`·`(작성)`·`(기재)`·`(입력)`·`(예시)`·`내용 입력`·`내용을 입력하세요`.

- [ ] **Step 1: 실패하는 테스트**

```typescript
// tests/doc-fill-slots.test.ts
import { describe, it, expect } from 'vitest';
import { headingLevel, isPlaceholderText, normalizeLabel } from '@/lib/doc-fill/slots';

describe('번호 제목 급', () => {
  it.each([
    ['Ⅱ. 추진 계획', 1], ['1. 사업 개요', 2], ['□ 개요', 2], ['가. 현황', 3], ['○ 추진 방향', 3],
    ['1) 인력', 4], ['- 세부 일정', 4], ['가) 예산', 5], ['(1) 1분기', 6], ['(가) 시범', 7], ['① 대상', 8], ['㉮ 비고', 9],
  ])('%s → %d', (text, level) => expect(headingLevel(text)).toBe(level));

  it('제목이 아닌 것', () => {
    expect(headingLevel('1.5배 증가')).toBeNull();
    expect(headingLevel('○ 사업기간은 2026년 1월부터 12월까지 1년이다.')).toBeNull();
    expect(headingLevel('일반 문장')).toBeNull();
    expect(headingLevel('□')).toBeNull();
  });
});

describe('자리 표시 글자', () => {
  it.each(['', '   ', '○○○', 'OOOO', '(내용)', '○ (내용)', '- (작성)', '내용을 입력하세요'])('"%s"는 빈 자리', (t) =>
    expect(isPlaceholderText(t)).toBe(true));
  it.each(['홍길동', '일시: ○○○', '○ 추진 방향', '해당 없음'])('"%s"는 빈 자리가 아니다', (t) =>
    expect(isPlaceholderText(t)).toBe(false));
});

describe('항목명', () => {
  it('공백·콜론을 다듬고 한 글자씩 띄운 이름을 붙인다', () => {
    expect(normalizeLabel('  회의명 : ')).toBe('회의명');
    expect(normalizeLabel('취    급')).toBe('취급');
    expect(normalizeLabel('기 안 자')).toBe('기안자');
    expect(normalizeLabel('사업 기간')).toBe('사업 기간');
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run tests/doc-fill-slots.test.ts` / Expected: FAIL (export 없음)
- [ ] **Step 3: 구현** — 위 급 표·조건·자리 표시 목록을 `slots.ts`에 둔다. 목록은 이 파일 한 곳에만
- [ ] **Step 4: 통과 확인** — 같은 명령 / Expected: PASS
- [ ] **Step 5: Commit** — `feat: 양식 자동 자리 판정 규칙(번호 제목 급·자리 표시·항목명)`

---

### Task 3: HWPX 자동 자리 — 번호 제목과 표 빈칸

**Files:**
- Create: `src/lib/doc-fill/hwpx-auto.ts`
- Modify: `tests/fixtures/hwpx.ts` (표 칸 주소·빈 문단·구역 설정 문단 도우미)
- Test: `tests/doc-fill-hwpx-auto.test.ts`

**Interfaces:**
- Consumes: Task 1 core, Task 2 규칙
- Produces:
  ```typescript
  export interface AutoSlot { id: string; label: string; kind: 'section' | 'cell'; path: string[]; hint: string | null }
  export async function readHwpxAutoSlots(bytes: Buffer): Promise<AutoSlot[]>;          // id: s1.. 문서 순서
  export async function fillHwpxAutoSlots(bytes: Buffer, values: Map<string, string>): Promise<{ bytes: Buffer; filled: string[]; unfilled: string[] }>;
  ```
  `values`·`filled`·`unfilled`의 키는 **자리 id**다(같은 이름의 자리가 있을 수 있다). 읽기와 채우기는 같은 바이트에서 같은 순서로 자리를 다시 계산한다 — 결정적이어야 한다.

규칙 (설계 4.1의 구체화 — 이 규칙이 결정이다):
- **채울 수 있는 문단**: 중첩 문단을 품지 않고(`!hasChild`), 여는 태그 뒤에 글 조각 말고 컨트롤(`secPr`·`ctrl`·`tbl`·`pic`·`equation`)이 없고, 글이 `isPlaceholderText`인 문단
- **section 자리**: 본문 최상위(`ancestors`가 빈) 문단 중 `headingLevel !== null`인 제목. 영역 = 그 제목 다음부터 다음 최상위 제목(급 무관) 전까지의 최상위 문단. 영역에 채울 수 있는 문단이 하나 이상일 때만 자리. 이름 = 제목 글(앞뒤 공백 정리), `path` = 그보다 급이 높은(숫자가 작은) 앞선 제목들, `hint` = 첫 채울 수 있는 문단의 자리 표시 글자(빈 문단이면 null)
- **section 채우기**: 영역의 첫 채울 수 있는 문단을 통째로 `freshParagraph`(그 문단의 여는 태그, 그 문단 첫 조각의 글자 서식 — 조각이 없으면 null) 줄 수만큼으로 바꾼다. 영역의 나머지 채울 수 있는 문단 중 자리 표시 글이 든 것은 글을 지운다(빈 문단은 그대로)
- **cell 자리**: 표(`tbl`) 안의 칸(`tc`) 중 그 칸의 모든 문단이 채울 수 있는 문단인 칸. 칸 위치는 `cellAddr`의 `colAddr`·`rowAddr`, 없으면 행 안 순서. 이름 = 같은 행 왼쪽 칸 중 가장 가까운 '빈 자리가 아닌' 칸의 글, 없으면 같은 열 위쪽 칸 중 가장 가까운 그런 칸의 글(`normalizeLabel`). 둘 다 없으면 자리가 아니다. `path` = 그 표를 품은 최상위 문단 앞의 가장 가까운 section 제목들, `hint` = 칸의 자리 표시 글자
- **cell 채우기**: 칸의 첫 문단을 `freshParagraph` 줄 수만큼으로 바꾸고, 칸의 나머지 문단 중 자리 표시 글이 든 것은 글을 지운다. 바깥 문단들의 줄 배치 캐시는 `ancestorLineSegDeletes`로 지운다
- 자리는 문서(시작 위치) 순서, id `s1..`

- [ ] **Step 1: 시험용 도우미** — `tests/fixtures/hwpx.ts`에 더한다: `emptyPara(paraPr?)`(글 조각 없는 빈 문단), `secPrPara()`(`<hp:p …><hp:run><hp:secPr …/><hp:ctrl><hp:colPr/></hp:ctrl></hp:run></hp:p>` 꼴, 글 없음), `tableAt(rows, { addr: true })`(칸마다 `<hp:cellAddr colAddr rowAddr/>`)
- [ ] **Step 2: 실패하는 테스트**

```typescript
// tests/doc-fill-hwpx-auto.test.ts — 고정할 것
it('번호 제목 아래 빈 문단을 자리로, 급으로 경로를 단다')
  // secPrPara() + para('1. 추진 배경') + emptyPara() + para('가. 현황') + para('(내용)') + para('2. 일정') + emptyPara()
  // → [{label:'1. 추진 배경', kind:'section', path:[]}, {label:'가. 현황', path:['1. 추진 배경'], hint:'(내용)'}, {label:'2. 일정', path:[]}]
it('채울 빈 문단이 없는 제목은 자리가 아니다')            // para('1. 개요') + para('2. 현황') + emptyPara() → ['2. 현황']만
it('구역 설정을 품은 빈 문단은 자리도, 채울 곳도 아니다')  // secPrPara()가 영역 안에 있어도 건드리지 않음: 채운 뒤 secPr 1개 그대로
it('표 빈칸은 왼쪽 항목명, 없으면 위쪽 항목명')
  // tableAt([['회의명','',''],['일시','(작성)','장소'],['','','']], { addr: true })
  // → 자리 (행,열) 순: (0,1)'회의명' · (0,2)'회의명' · (1,1)'일시' hint '(작성)' · (2,0)'일시'(위쪽) · (2,2)'장소'(위쪽)
  //   (1,2)'장소'는 글이 있어 자리 아님 · (2,1)은 왼쪽·위쪽 모두 빈칸뿐이라 자리 아님
it('결재란처럼 항목명도 위쪽 칸도 없는 빈칸은 자리가 아니다')  // tableAt([['','']]) → []
it('같은 이름 두 칸은 따로 채운다')     // tableAt([['비고',''],['비고','']]) → s1·s2 둘 다 '비고', 채우면 각각 다른 글
it('section·cell 채우기 — 다시 읽으면 글이 있고 자리 표시가 없으며, 여러 줄은 새 문단')
  // fillHwpxAutoSlots 뒤 extractTextFromHwp로 넣은 글 확인, '(내용)' 사라짐, 영역 문단의 paraPrIDRef 유지
it('표 칸이 늘면 바깥 문단의 줄 배치 캐시가 지워진다')
it('채우지 않은 자리는 원래대로, unfilled에 id로 남는다')
it('읽기와 채우기의 자리 번호가 같다 — 같은 바이트면 같은 목록')
```

- [ ] **Step 3: 실패 확인** — Run: `npx vitest run tests/doc-fill-hwpx-auto.test.ts` / Expected: FAIL (모듈 없음)
- [ ] **Step 4: 구현** — 위 규칙대로. 표 구조는 `scanTags`로 `tbl`·`tr`·`tc`·`cellAddr`을 훑어 칸마다 그 안의 문단 시작 위치 목록을 모은다(`scanParagraphs`의 결과와 시작 위치로 맞춘다)
- [ ] **Step 5: 통과 확인** — Run: `npx vitest run tests/doc-fill-hwpx-auto.test.ts && npx tsc --noEmit` / Expected: PASS
- [ ] **Step 6: Commit** — `feat: HWPX 자동 자리 — 번호 제목 영역과 표 빈칸`

---

### Task 4: 입구 — 표시 → 자동 자리 → (대체 자리 비움)

**Files:**
- Modify: `src/lib/doc-fill/index.ts`
- Test: `tests/doc-fill-index.test.ts`

**Interfaces:**
- Consumes: Task 3 `readHwpxAutoSlots`·`fillHwpxAutoSlots`, S2-a `readHwpxMarkers`·`fillHwpx`
- Produces (S2-a 형을 넓힌다 — 기존 호출자는 그대로 컴파일돼야 한다):
  ```typescript
  export type ReadResult =
    | { ok: true; format: 'hwpx' | 'docx'; mode: 'fill' | 'fallback'; reason?: string; slots: Slot[] }
    | { ok: false; reason: string };
  export type FillOutcome =
    | { ok: true; bytes: Buffer; mimeType: string; extension: 'hwpx' | 'docx'; mode: 'fill' | 'fallback'; filled: string[]; unfilled: string[] }
    | { ok: false; reason: string };
  export async function fillTemplate(bytes: Buffer, fileName: string, values: { slot_id: string; text: string }[],
    opts?: { title?: string; fallbackTemplate?: Buffer | null }): Promise<FillOutcome>;
  export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  ```
  `filled`·`unfilled`는 사람이 읽는 **이름**으로 돌려준다(자동 자리는 id → 이름으로 바꿔서). 이 Task에서는 대체 경로가 아직 없다 — 자리를 못 찾은 HWPX는 S2-a의 `NO_MARKERS` 실패 그대로.

고르기 규칙: HWPX → 표시가 있으면 표시(`mode:'fill'`, kind `marker`) / 없으면 자동 자리가 있으면 자동(`mode:'fill'`) / 없으면 실패(Task 7에서 대체로 바뀜). 자동 자리 채우기는 `slot_id`를 그대로 `fillHwpxAutoSlots`에 넘긴다.

- [ ] **Step 1: 실패하는 테스트** — `tests/doc-fill-index.test.ts`에 더한다:
  - `'표시 없는 양식은 자동 자리를 돌려준다'`: `para('1. 개요') + emptyPara()` → `{ ok:true, format:'hwpx', mode:'fill', slots:[{ id:'s1', label:'1. 개요', kind:'section' }] }`(toMatchObject)
  - `'표시가 하나라도 있으면 자동 찾기를 하지 않는다'`: `para('{{제목}}') + para('1. 개요') + emptyPara()` → 자리 1개, kind `marker`
  - `'자동 자리를 번호로 채우고 결과는 이름으로'`: 같은 이름 칸 둘(`비고`) → `fillTemplate(…, [{slot_id:'s1',text:'가'},{slot_id:'s2',text:'나'}])` → `filled: ['비고','비고']`, 다시 읽은 본문에 '가'·'나'
  - 기존 결과 객체 기대값에 `mode: 'fill'`을 더한다
- [ ] **Step 2: 실패 확인** — Run: `npx vitest run tests/doc-fill-index.test.ts` / Expected: 새 테스트 FAIL
- [ ] **Step 3: 구현** — 위 고르기 규칙. 상한(100곳·6,000자)과 없는 자리 번호 거절은 S2-a 그대로 모든 경로에 건다
- [ ] **Step 4: 통과 확인** — Run: `npx vitest run && npx tsc --noEmit` / Expected: PASS
- [ ] **Step 5: Commit** — `feat: 양식 입구 — 표시가 없으면 자동 자리`

---

### Task 5: DOCX 표시 채우기

**Files:**
- Create: `src/lib/doc-fill/docx.ts`, `tests/fixtures/docx.ts`
- Modify: `src/lib/doc-fill/index.ts`
- Test: `tests/doc-fill-docx.test.ts`

**Interfaces:**
- Consumes: `findMarkers`(slots.ts), `escapeXml`·`stripInvalidXmlChars`·`scanTags`·`unescapeXml`(xml-scan.ts), `valueLines`(Task 1), `DocFillError`
- Produces:
  ```typescript
  export async function readDocxMarkers(bytes: Buffer): Promise<string[]>;
  export async function fillDocx(bytes: Buffer, values: Map<string, string>): Promise<{ bytes: Buffer; filled: string[]; unfilled: string[] }>;
  ```
  index.ts: `docx`이고 표시가 있으면 `format:'docx'`, `mode:'fill'`, 결과 `extension:'docx'`, `mimeType: DOCX_MIME`. 표시가 없으면 이 Task에서는 실패 이유 `'Word(DOCX) 양식은 {{항목 이름}} 표시가 있어야 채울 수 있습니다.'` — Task 7에서 대체 경로로 바뀐다.

규칙 (설계 4.5의 구체화):
- 대상 부분: `word/document.xml`, `word/header*.xml`, `word/footer*.xml`. 그 밖의 항목은 내용 그대로, 원래 압축 방식으로
- 문단 = `w:p`, 글 = `w:r` 안의 `w:t`. 문단 안 글을 이어 붙여 표시를 찾고 조각 위치로 되짚는다(HWPX와 같은 계산). `w:t`를 고칠 때 `xml:space="preserve"`를 붙인다(앞뒤 공백이 지워지지 않게)
- 여분 줄 = 새 `w:p`: 원래 문단의 `w:pPr`에서 `w:sectPr`·`w:pageBreakBefore`·`w:numPr`(번호 매김이 줄마다 늘지 않게)를 뺀 것 + 표시가 든 `w:r`의 `w:rPr` + `<w:t xml:space="preserve">글</w:t>`
- `w:pPr`·`w:rPr`가 없으면 그 부분 없이 만든다

- [ ] **Step 1: 시험용 DOCX 도우미** — `tests/fixtures/docx.ts`: `wp(text|string[], opts?: { pPr?: string; rPr?: string })`, `buildDocx(bodyXml, opts?: { header?: string })` — `[Content_Types].xml`·`_rels/.rels`·`word/document.xml`(`w:` 네임스페이스)·`word/_rels/document.xml.rels`·선택 `word/header1.xml`
- [ ] **Step 2: 실패하는 테스트** — `tests/doc-fill-docx.test.ts`:
  - `'표시를 문서 순서로 읽는다 — 조각난 표시·머리글 포함'`
  - `'채우면 다시 읽은 본문에 글이 있고 표시가 없다'` (mammoth `extractRawText`로 확인)
  - `'여분 줄은 새 문단 — pPr의 sectPr·pageBreakBefore·numPr는 넘기지 않고 rPr는 표시의 것'`: `wp('{{본문}}', { pPr: '<w:pPr><w:pStyle w:val="Body"/><w:numPr><w:ilvl w:val="0"/></w:numPr><w:pageBreakBefore/><w:sectPr/></w:pPr>', rPr: '<w:rPr><w:b/></w:rPr>' })`에 'a\nb' → 둘째 문단에 `w:pStyle` 있음, `numPr`·`pageBreakBefore`·`sectPr` 없음, `<w:b/>` 있음, `sectPr`는 문서 전체에 1개
  - `'앞뒤 공백을 지키고 특수문자를 이스케이프한다'`: ' A & <B> ' → `xml:space="preserve"`, `&amp;`·`&lt;`
  - `'다른 항목은 내용 그대로'`: `[Content_Types].xml` 같음
  - `tests/doc-fill-index.test.ts`에: `'DOCX 표시 양식은 docx로 채운다'` → `extension:'docx'`, `mimeType` = DOCX_MIME
- [ ] **Step 3: 실패 확인** — Run: `npx vitest run tests/doc-fill-docx.test.ts` / Expected: FAIL
- [ ] **Step 4: 구현** — 위 규칙. zip 다시 묶기는 HWPX와 같은 원칙(바뀐 항목만 다시 쓰기, `createFolders:false`, 원래 압축 방식)
- [ ] **Step 5: 통과 확인** — Run: `npx vitest run && npx tsc --noEmit` / Expected: PASS
- [ ] **Step 6: Commit** — `feat: DOCX 양식의 표시 채우기`

---

### Task 6: 대체 경로 — 목차만 읽어 표준 보고서로

**Files:**
- Create: `src/lib/doc-fill/fallback.ts`
- Test: `tests/doc-fill-fallback.test.ts`

**Interfaces:**
- Consumes: `extractTextFromHwp`(`@/lib/hwp` — HWP·HWPX 본문 글), `mammoth.extractRawText`(DOCX), `headingLevel`(Task 2), `fillHwpx`(S2-a 표시 채우기), `DocFillError`
- Produces:
  ```typescript
  export async function fallbackOutline(bytes: Buffer, format: 'hwpx' | 'docx' | 'hwp'): Promise<{ label: string; level: number }[]>;
  export async function fillFallback(reportTemplate: Buffer, title: string, outline: { label: string }[],
    values: Map<number, string>): Promise<{ bytes: Buffer; filled: string[]; unfilled: string[] }>;
  ```
  - `fallbackOutline`: 본문 글을 줄로 나눠 `headingLevel !== null`인 줄을 순서대로(같은 글 중복 제거). 하나도 없으면 `[{ label: '본문', level: 2 }]`. 본문을 못 읽으면(`HwpParseError` 등) `DocFillError('양식의 본문을 읽지 못해 목차를 만들 수 없습니다.')`
  - `fillFallback`: 기본 보고서 양식(S2-a `builtin:report`, 표시 `제목`·`작성일`·`작성부서`·`개요`·`추진 경과`·`주요 내용`·`향후 계획`·`건의 사항`)에 `제목` ← title, `주요 내용` ← 목차 순서대로 "항목 이름 줄 + 그 항목 글 줄들"(값 없는 항목은 이름 줄만), 나머지 표시 ← 빈 글(설계 7.1). `values`의 키는 목차 순번(0부터). `filled`·`unfilled`는 목차 항목 이름

- [ ] **Step 1: 실패하는 테스트** — `tests/doc-fill-fallback.test.ts`:
  - `'HWPX 본문에서 번호 제목만 목차로'`: 시험 HWPX(`para('1. 사업 개요')`+`para('본문 글')`+`para('2. 추진 일정')`) → `[{label:'1. 사업 개요',level:2},{label:'2. 추진 일정',level:2}]`
  - `'번호 제목이 없으면 본문 하나'` → `[{ label:'본문', level:2 }]`
  - `'DOCX 본문에서도 목차'` (Task 5 도우미로 만든 DOCX)
  - `'표준 보고서에 제목과 항목을 채우고 나머지 표시는 비운다'`: 시험용 보고서 양식(`buildHwpx`로 8개 표시를 넣은 것) → 다시 읽은 본문에 제목·'1. 사업 개요'·그 글, `{{` 없음
  - `'깨진 파일은 이유를 돌려준다'` → `DocFillError`
- [ ] **Step 2: 실패 확인** — Run: `npx vitest run tests/doc-fill-fallback.test.ts` / Expected: FAIL
- [ ] **Step 3: 구현** — 위 인터페이스대로
- [ ] **Step 4: 통과 확인** — Run: `npx vitest run tests/doc-fill-fallback.test.ts && npx tsc --noEmit` / Expected: PASS
- [ ] **Step 5: Commit** — `feat: 채울 수 없는 양식의 대체 경로 — 목차만 읽어 표준 보고서로`

---

### Task 7: 입구와 능력에 대체 경로 연결 · 화면 안내

**Files:**
- Modify: `src/lib/doc-fill/index.ts`, `src/lib/capabilities/document.ts`, `src/components/chat/MessageBubble.tsx`, `src/components/agents/TemplatesPanel.tsx`
- Test: `tests/doc-fill-index.test.ts`, `tests/document-capability.test.ts`

**Interfaces:**
- Consumes: Task 4 형, Task 6 `fallbackOutline`·`fillFallback`
- index.ts 고르기 규칙(최종): HWPX 표시 → HWPX 자동 → DOCX 표시 → **대체**(옛 HWP, 자리 없는 HWPX, 표시 없는 DOCX). 대체 `read`는 `{ ok:true, format, mode:'fallback', reason, slots }`(slot kind `section`, id `s1..` = 목차 순번+1). `fill`은 `opts.fallbackTemplate`이 없으면 `{ ok:false, reason:'표준 서식(일반 보고서) 파일이 아직 준비되지 않아 대신 만들 수 없습니다. 관리자에게 알려 주세요.' }`, 있으면 `fillFallback` 결과를 `extension:'hwpx'`, `mode:'fallback'`으로
- `reason` 문구:
  - 옛 HWP: `'옛 한글(HWP) 형식이라 양식에 직접 채울 수 없어 표준 서식으로 만듭니다. 한글에서 HWPX로 다시 저장해 올리면 양식 그대로 채웁니다.'`
  - 자리 없는 HWPX: `'이 양식에서 채울 자리를 찾지 못해 표준 서식으로 만듭니다. 채울 자리에 {{항목 이름}} 표시를 넣어 다시 올리면 양식 그대로 채웁니다.'`
  - 표시 없는 DOCX: `'Word(DOCX) 양식은 {{항목 이름}} 표시가 있어야 직접 채울 수 있어 표준 서식으로 만듭니다.'`
- document.ts:
  - `read_template` 결과에 `mode`·`reason`을 싣는다(설계 3.2)
  - `fill_template`은 대체면 `deps.loadBuiltin(findBuiltinTemplate('builtin:report')!)`를 `opts.fallbackTemplate`으로, `title`을 `opts.title`로 넘긴다(표시·자동 경로에는 넘기지 않아도 된다)
  - 성공 문구에 대체면 `' (기관 양식에 직접 채우지 못해 표준 서식으로 만들었습니다 — 이유를 사용자에게 알려 주세요.)'`
  - `logGenerated` details에 `mode`(설계 5.5)
  - `DOCUMENT_ADDENDUM`에 줄 하나: `'read_template 결과의 mode가 fallback이면 reason을 사용자에게 알리고, HWPX로 다시 저장해 올리거나 {{항목 이름}} 표시를 넣으면 양식 그대로 채울 수 있다고 안내합니다.'`
- MessageBubble: 파일 카드 표지를 `file_name` 확장자로 — `.docx` → `DOC`, 그 밖 → `HWP`
- TemplatesPanel 안내(기존 첫 `<p>` 아래 한 문단):
  `'채울 자리에 {{항목 이름}}을 넣어 두면 그 자리에 정확히 채웁니다. 표시가 없으면 번호 제목(1. 가. □ ○ 등) 아래의 빈 줄과 표의 빈칸을 자동으로 찾습니다. 옛 HWP 파일은 직접 채울 수 없어 표준 서식으로 대신 만들어지니 HWPX로 저장해 올려 주세요. "일시: ○○○"처럼 문장 속 자리는 찾지 못하니 {{일시}}로 바꿔 주세요.'`

- [ ] **Step 1: 실패하는 테스트**
  - `tests/doc-fill-index.test.ts`: `'옛 HWP는 대체 목차'`(S2-a의 CFB 시험 바이트는 본문을 못 읽으므로 `ok:false` + `'목차'` 이유가 정상 — 진짜 HWP 시험 파일이 없으니 이 동작을 고정한다), `'자리 없는 HWPX는 대체 — mode fallback·reason·목차 자리'`, `'대체 채우기는 표준 보고서가 없으면 이유'`, `'대체 채우기는 표준 보고서로 hwpx를 만든다'`(시험용 보고서 양식을 `fallbackTemplate`으로)
  - 기존 `'옛 HWP·DOCX·표시 없는 양식은 이유를 돌려준다'` 시험은 새 동작(대체)에 맞게 고친다 — 그 시험이 고정하던 문구가 바뀌는 것이므로 이 Task의 범위다
  - `tests/document-capability.test.ts`: `'대체 양식은 mode·reason을 싣고 표준 보고서로 만든다'`(가짜 `loadBuiltin`이 minutes와 report를 돌려줌, 자리 없는 시험 HWPX를 기관 양식으로), `'기록에 mode가 남는다'`, 안내 문구에 `'fallback'` 포함
- [ ] **Step 2: 실패 확인** — Run: `npx vitest run tests/doc-fill-index.test.ts tests/document-capability.test.ts` / Expected: 새 테스트 FAIL
- [ ] **Step 3: 구현** — 위 규칙·문구 그대로
- [ ] **Step 4: 통과 확인** — Run: `npx vitest run && npx tsc --noEmit` / Expected: PASS
- [ ] **Step 5: Commit** — `feat: 대체 경로를 입구·능력에 연결하고 양식 탭 안내`

---

### Task 8: 문서 · 검증

**Files:**
- Modify: `CLAUDE.md`, `assets/templates/README.md`, `docs/superpowers/specs/2026-10-14-workon-service-definition-design.md`

- [ ] **Step 1: 전체 검증** — Run: `npx vitest run && npx tsc --noEmit && NODE_OPTIONS=--max-old-space-size=4096 npm run build` / Expected: 전부 PASS, 빌드 성공
- [ ] **Step 2: `CLAUDE.md` '문서 만들기' 절** — S2-a 문장 "S2-a는 `{{이름}}` 표시만 채운다…"를 S2-b 동작으로 바꾼다: 고르기 순서(표시 → 자동 자리 → 대체), 자동 자리 규칙 요지(번호 제목 아래 빈 문단 · 표 빈칸과 항목명 · 컨트롤 품은 문단 제외 · 문장 속 자리 표시는 안 찾음), DOCX는 표시만, 대체는 표준 보고서와 이유. 시험 수는 `npx vitest run`이 출력한 수로. 사실은 코드로 확인하고 쓴다
- [ ] **Step 3: `assets/templates/README.md`** — `report.hwpx`는 대체 경로에도 쓰인다는 한 줄
- [ ] **Step 4: 서비스 정의서 6절** — S2-a 때 더한 줄을 "양식의 항목 이름·번호 제목·자리 표시 글자(목차)만 Claude로 보낸다. 양식 파일 전체와 만든 파일은 나가지 않는다"로 바꾼다(자동 자리의 `hint`가 생겼다)
- [ ] **Step 5: Commit** — `docs: S2-b 자동 자리·DOCX·대체 경로 반영`
- [ ] **Step 6: 확인 요청** — 사용자에게: 표시 없는 기관 양식(예: 이번에 쓴 공문 양식에서 표시를 지운 것, 기관 보고서 양식)을 비서 양식 탭에 올려 "이 양식으로 써 줘" → 목차가 그럴듯한지 → 만든 파일을 한글에서 열기. 진짜 HWP 파일 하나로 대체 경로도 확인
