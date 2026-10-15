# S2-a 한글 파일 만들기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** '문서 만들기' 능력을 켠 비서가 표준 서식(공문 기안문·일반 보고서·회의록)이나 `{{…}}` 표시를 넣은 기관 HWPX 양식에 내용을 채워, 대화에 한글 파일 내려받기 링크를 붙인다.

**Architecture:** 채우기 엔진(`src/lib/doc-fill/`)은 바이트를 받아 바이트를 돌려주는 순수 모듈이다 — HWPX zip 안의 본문 XML만 문자열 단위로 고치고 나머지는 그대로 둔다. 능력(`capabilities/document.ts`)이 양식을 고르고 엔진을 부르고 결과를 `generated_files`(0029)와 저장소에 남긴다. 파일 링크는 `ToolOutcome.files` → SSE `tool_end.files` → `messages.source_references.files`로 화면까지 간다.

**Tech Stack:** Next.js 14 App Router · TypeScript · Supabase(PostgREST·Storage) · `jszip` · vitest — 새 의존성 없음

**Spec:** `docs/superpowers/specs/2026-10-15-s2-document-fill-design.md` (10절 S2-a 범위)

## Global Constraints

- 응답 규약 `{ ok, data }` / `{ ok: false, error: { message } }`, 사용자에게 보이는 문구는 한국어
- SSE 이벤트 이름과 기존 페이로드는 그대로다. `tool_end`에 `files` 칸만 더한다
- 메시지 두 행은 **같은 키 집합**으로 넣는다(PostgREST 배치 삽입 규칙)
- 도구 입력 스키마에 기관·부서·사용자·대화·비서 id를 넣지 않는다. 그 값은 서버의 `TurnContext`에서만 꺼낸다
- 환경변수는 `src/lib/config.ts` 경유(`SUPABASE_DOCUMENTS_BUCKET`). 새 의존성을 들이지 않는다(`jszip`은 이미 있다)
- HWPX는 **본문 XML(`Contents/section*.xml`)만 고친다.** 서식 정의·그림·설정 파일은 내용 그대로, `mimetype`은 zip 맨 앞 무압축
- 상한: 자리 100곳, 자리 하나 6,000자
- 생성 파일은 **주인만** 내려받는다. 관리자도 못 받는다
- 배포 순서: **0029 적용 → 코드 배포**
- 커밋 메시지 끝: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## Review Focus

- **한글에서 글자 서식을 바꾸면 `{{제목}}`이 여러 조각(run)으로 쪼개진다** → 그래도 찾고 채운다. Task 1의 '조각난 표시' 테스트가 고정한다.
- **같은 이름의 표시가 머리글과 본문에 두 번 있다** → 둘 다 채운다. Task 1의 '같은 이름 두 번' 테스트가 고정한다.
- **사용자 글에 `&`·`<`·`>`가 들어 있다** → 이스케이프해 파일이 깨지지 않고, 다시 읽으면 원래 글이 나온다. Task 1의 '특수문자' 테스트가 고정한다.
- **다른 사람의 파일 id로 내려받기, 다른 비서의 양식 ref로 채우기** → 404 / 거절. Task 4와 Task 6의 테스트가 고정한다.
- **파일 저장이 실패한다** → 도구가 이유를 돌려주고 대화의 초안은 남는다고 알린다. Task 6의 '저장 실패' 테스트가 고정한다.

## 설계와 달라지는 점

- **파일은 초안을 확인한 뒤 다음 응답에서 만든다.** 응답 하나의 출력 상한이 4,096토큰(`MAX_OUTPUT_TOKENS`)이라, 초안을 대화에 쓰고 같은 글을 도구 입력으로 한 응답에 다시 쓰면 넘을 수 있다. 흐름 안내(3.3)를 "초안 → '이대로 만들까요?' → 만들어 달라면 `fill_template`"으로 쓴다. 처음부터 파일만 달라고 하면 대화에는 짧은 요약만 쓴다
- **저장소 경로는 `generated/{기관}/{대화}/{파일id}.hwpx`.** 한글 파일 이름은 DB에만 둔다(`templateStoragePath`와 같은 관례 — 저장소 키는 ASCII가 안전하다). 내려받을 때 서명 주소의 `download` 옵션으로 원래 이름을 붙인다
- **표를 품은 바깥 문단의 표시는 채우지 않는다.** 그 문단을 복제하면 표까지 겹친다. 표 안 칸의 문단은 채운다. 기본 양식 안내(README)에 적는다
- **S2-a의 `read_template`은 `{{…}}` 표시만 읽는다.** DOCX·옛 HWP·표시 없는 양식은 이유와 함께 실패한다(대체 경로는 S2-b)

## 사용자 확인 지점

- **확인 지점 A (Task 1 뒤)**: 한글로 저장한 HWPX(표시를 넣은 시험 양식)에 `npm run hwpx:probe -- 입력.hwpx 출력.hwpx`를 돌려 **출력 파일을 한글에서 열어 본다.** 열리지 않거나 서식이 깨지면 Task 1의 엔진을 고친 뒤에야 Task 2로 간다
- **확인 지점 B (Task 7 뒤)**: 기본 양식 3종을 `assets/templates/`에 둔다(README 기준) → `npm run db:migrate -- 0029` → 푸시·배포 → 비서 하나에 '문서 만들기'를 켜고 회의록을 만들어 한글에서 열어 본다

---

## File Structure

| 파일 | 책임 |
|---|---|
| `src/lib/doc-fill/errors.ts` (새) | `DocFillError` — 사용자에게 그대로 보일 이유 |
| `src/lib/doc-fill/xml-scan.ts` (새) | 원본을 바꾸지 않는 XML 태그 위치 찾기 · 이스케이프 |
| `src/lib/doc-fill/slots.ts` (새) | `{{…}}` 표시 찾기 |
| `src/lib/doc-fill/hwpx.ts` (새) | HWPX 열기 · 표시 읽기 · 채우기 · 미리보기 글 |
| `src/lib/doc-fill/index.ts` (새) | 형식 판별 · 자리 번호 · 상한 · 결과 정리 |
| `src/lib/builtin-templates.ts` (새) | 기본 양식 목록 · 파일 읽기 |
| `assets/templates/README.md` (새) | 기본 양식 만드는 법(사용자용) |
| `scripts/hwpx-probe.mjs` (새) | 한글 호환 확인용 |
| `supabase/migrations/0029_generated_files.sql` (새) | 표 · 트리거 |
| `src/lib/generated-files.ts` (새) | 생성 파일 저장·조회·서명 주소·대화 삭제 시 정리 |
| `src/lib/file-size.ts` (새) | 크기 표시(화면용 순수 함수) |
| `src/app/api/files/[id]/route.ts` (새) | 내려받기 |
| `src/lib/capabilities/document.ts` (새) | 능력 · 도구 셋 · 흐름 안내 |
| `src/lib/capabilities/{types,settings,index}.ts` (고침) | `GeneratedFileRef` · `TurnContext.conversationId` · `ToolOutcome.files` · `document` id |
| `src/lib/assistant/{types,stream,persist,prepare}.ts` (고침) | 파일 링크 전달·저장 |
| `src/components/chat/{ChatInterface,MessageBubble}.tsx` (고침) | 파일 카드 |
| `src/lib/agent-form.ts`, `src/components/agents/AgentEditorModal.tsx` (고침) | '문서 만들기' 체크 |
| `src/app/api/conversations/[id]/route.ts` (고침) | 대화 삭제 시 생성 파일 정리 |
| `src/app/api/admin/{audit-logs,usage-summary}/route.ts`, `src/components/admin/StatsDashboard.tsx` (고침) | 활동 이름 '문서 파일 생성' |
| `scripts/db-check.mjs`, `scripts/isolation-check.mjs` (고침) | 0029 점검 |
| `next.config.mjs` (고침) | 기본 양식을 배포 묶음에 |

---

### Task 1: HWPX 채우기 엔진 (표시 자리) + 한글 확인 스크립트

**Files:**
- Create: `src/lib/doc-fill/errors.ts`, `src/lib/doc-fill/xml-scan.ts`, `src/lib/doc-fill/slots.ts`, `src/lib/doc-fill/hwpx.ts`, `scripts/hwpx-probe.mjs`
- Create: `tests/fixtures/hwpx.ts`, `tests/doc-fill-hwpx.test.ts`
- Modify: `package.json` (scripts에 `"hwpx:probe": "tsx scripts/hwpx-probe.mjs"`)

**Interfaces:**
- Produces:
  ```typescript
  export class DocFillError extends Error {}
  export function findMarkers(text: string): { label: string; start: number; end: number }[];
  export async function readHwpxMarkers(bytes: Buffer): Promise<string[]>; // 문서 순서, 중복 없음
  export async function fillHwpx(bytes: Buffer, values: Map<string, string>): Promise<{ bytes: Buffer; filled: string[]; unfilled: string[] }>;
  ```
  `values`의 키는 표시 이름(label). `filled`·`unfilled`도 이름이며 문서 순서다.

- [ ] **Step 1: 시험용 HWPX 만들기 도우미**

```typescript
// tests/fixtures/hwpx.ts
import JSZip from 'jszip';

/**
 * 시험용 HWPX. 한글이 저장하는 파일의 뼈대(mimetype · version · header ·
 * section · 미리보기)를 흉내 낸다. 한글 호환은 확인 지점 A에서 진짜 파일로 본다.
 */
export const NS =
  'xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section"';

export const HEADER =
  '<?xml version="1.0" encoding="UTF-8"?><hh:head xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" version="1.4"><hh:refList><hh:fontfaces itemCnt="0"/></hh:refList></hh:head>';

const LINESEG =
  '<hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="42520" flags="393216"/></hp:linesegarray>';

/** 문단 하나. 배열이면 조각(run)마다 하나씩 — 한글이 서식을 바꿀 때 쪼개는 모양 */
export function para(text: string | string[], paraPr = '3'): string {
  const runs = (Array.isArray(text) ? text : [text])
    .map((t, i) => `<hp:run charPrIDRef="${i}"><hp:t>${t}</hp:t></hp:run>`)
    .join('');
  return `<hp:p id="1" paraPrIDRef="${paraPr}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">${runs}${LINESEG}</hp:p>`;
}

/** 표 하나를 품은 바깥 문단. 칸마다 문단 하나 */
export function table(rows: string[][]): string {
  const trs = rows
    .map((r) => `<hp:tr>${r.map((c) => `<hp:tc><hp:subList>${para(c, '7')}</hp:subList></hp:tc>`).join('')}</hp:tr>`)
    .join('');
  return `<hp:p id="2" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:tbl id="9" rowCnt="${rows.length}" colCnt="${rows[0].length}">${trs}</hp:tbl></hp:run></hp:p>`;
}

export async function buildHwpx(body: string, opts: { prvText?: string } = {}): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/hwp+zip', { compression: 'STORE' });
  zip.file('version.xml', '<?xml version="1.0" encoding="UTF-8"?><hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" major="5" minor="1"/>');
  zip.file('Contents/header.xml', HEADER);
  zip.file('Contents/section0.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><hs:sec ${NS}>${body}</hs:sec>`);
  zip.file('Preview/PrvText.txt', opts.prvText ?? '미리보기 {{제목}}');
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

export async function sectionXml(bytes: Buffer): Promise<string> {
  return (await JSZip.loadAsync(bytes)).file('Contents/section0.xml')!.async('string');
}
```

- [ ] **Step 2: 실패하는 테스트 작성**

```typescript
// tests/doc-fill-hwpx.test.ts
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { readHwpxMarkers, fillHwpx } from '@/lib/doc-fill/hwpx';
import { findMarkers } from '@/lib/doc-fill/slots';
import { DocFillError } from '@/lib/doc-fill/errors';
import { extractTextFromHwp } from '@/lib/hwp';
import { buildHwpx, para, table, sectionXml, HEADER } from './fixtures/hwpx';

const values = (o: Record<string, string>) => new Map(Object.entries(o));

describe('표시 찾기', () => {
  it('이름을 다듬고 빈 표시·짝 없는 괄호는 무시한다', () => {
    expect(findMarkers('제목: {{ 제목 }} / {{}} / {{ }} / {{열림').map((m) => m.label)).toEqual(['제목']);
  });

  it('문서 순서대로, 중복 없이, 표 칸과 조각난 표시까지 읽는다', async () => {
    const bytes = await buildHwpx(
      para('{{제목}}') + table([['일시', '{{일시}}'], ['작성', '{{제목}}']]) + para(['{{작', '성자}}'])
    );
    expect(await readHwpxMarkers(bytes)).toEqual(['제목', '일시', '작성자']);
  });

  it('zip이 아니면 이유를 알려 준다', async () => {
    await expect(readHwpxMarkers(Buffer.from('not a zip'))).rejects.toBeInstanceOf(DocFillError);
  });

  it('본문이 없으면 이유를 알려 준다', async () => {
    const zip = new JSZip();
    zip.file('mimetype', 'application/hwp+zip');
    const bytes = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(readHwpxMarkers(bytes)).rejects.toThrow('본문');
  });
});

describe('채우기', () => {
  it('표시를 지우고 글을 넣는다 — 다시 읽으면 글이 있고 표시가 없다', async () => {
    const bytes = await buildHwpx(para('{{제목}}') + table([['장소', '{{장소}}']]));
    const result = await fillHwpx(bytes, values({ 제목: '2026년 업무보고', 장소: '본관 3층' }));
    const text = await extractTextFromHwp(result.bytes, 'out.hwpx');
    expect(text).toContain('2026년 업무보고');
    expect(text).toContain('본관 3층');
    expect(text).not.toContain('{{');
    expect(result.filled).toEqual(['제목', '장소']);
    expect(result.unfilled).toEqual([]);
  });

  it('줄바꿈마다 문단을 복제한다 — 서식 참조가 같고 줄 배치 캐시는 지운다', async () => {
    const bytes = await buildHwpx(para('{{본문}}', '5') + para('그대로', '8'));
    const xml = await sectionXml((await fillHwpx(bytes, values({ 본문: '첫째\n둘째\r\n셋째' }))).bytes);
    const filled = xml.match(/<hp:p [^>]*paraPrIDRef="5"[\s\S]*?<\/hp:p>/g) ?? [];
    expect(filled).toHaveLength(3);
    expect(filled.map((p) => p.match(/<hp:t>([^<]*)<\/hp:t>/)![1])).toEqual(['첫째', '둘째', '셋째']);
    expect(filled.join('')).not.toContain('linesegarray');
    // 손대지 않은 문단의 줄 배치 캐시는 남는다
    expect(xml.match(/<hp:p [^>]*paraPrIDRef="8"[\s\S]*?<\/hp:p>/)![0]).toContain('linesegarray');
  });

  it('조각난 표시도 채운다', async () => {
    const bytes = await buildHwpx(para(['{{작', '성', '자}}']));
    const result = await fillHwpx(bytes, values({ 작성자: '홍길동' }));
    expect(await extractTextFromHwp(result.bytes, 'o.hwpx')).toContain('홍길동');
    expect(await sectionXml(result.bytes)).not.toContain('작');
  });

  it('같은 이름 두 번이면 둘 다 채운다', async () => {
    const bytes = await buildHwpx(para('{{제목}}') + table([['제목', '{{제목}}']]));
    const xml = await sectionXml((await fillHwpx(bytes, values({ 제목: '여비 규정 개정' }))).bytes);
    expect(xml.match(/여비 규정 개정/g)).toHaveLength(2);
  });

  it('특수문자를 이스케이프한다 — 파일이 깨지지 않고 원래 글로 읽힌다', async () => {
    const bytes = await buildHwpx(para('{{비고}}'));
    const result = await fillHwpx(bytes, values({ 비고: 'A & B <C> "인용"' }));
    expect(await sectionXml(result.bytes)).toContain('A &amp; B &lt;C&gt; "인용"');
    expect(await extractTextFromHwp(result.bytes, 'o.hwpx')).toContain('A & B <C> "인용"');
  });

  it('문장 속 표시는 그 자리에 넣고, 나머지 줄은 다음 문단으로', async () => {
    const bytes = await buildHwpx(para('제목: {{제목}} (안)'));
    const xml = await sectionXml((await fillHwpx(bytes, values({ 제목: '첫 줄\n둘째 줄' }))).bytes);
    const texts = [...xml.matchAll(/<hp:t>([^<]*)<\/hp:t>/g)].map((m) => m[1]);
    expect(texts).toEqual(['제목: 첫 줄 (안)', '둘째 줄']);
  });

  it('값이 없는 표시는 남기고 알려 준다', async () => {
    const bytes = await buildHwpx(para('{{제목}}') + para('{{참석자}}'));
    const result = await fillHwpx(bytes, values({ 제목: '회의' }));
    expect(result.unfilled).toEqual(['참석자']);
    expect(await sectionXml(result.bytes)).toContain('{{참석자}}');
  });

  it('서식 정의는 그대로, mimetype은 맨 앞 무압축, 미리보기 글은 채운 본문', async () => {
    const bytes = await buildHwpx(para('{{제목}}'));
    const result = await fillHwpx(bytes, values({ 제목: '새 제목' }));
    const zip = await JSZip.loadAsync(result.bytes);
    expect(await zip.file('Contents/header.xml')!.async('string')).toBe(HEADER);
    // zip 첫 항목의 로컬 헤더: 시그니처 · 압축 방식(0=저장) · 이름
    expect(result.bytes.readUInt32LE(0)).toBe(0x04034b50);
    expect(result.bytes.readUInt16LE(8)).toBe(0);
    const nameLength = result.bytes.readUInt16LE(26);
    expect(result.bytes.subarray(30, 30 + nameLength).toString('utf8')).toBe('mimetype');
    const preview = await zip.file('Preview/PrvText.txt')!.async('string');
    expect(preview).toContain('새 제목');
    expect(preview).not.toContain('{{');
  });

  it('표를 품은 바깥 문단의 표시는 건드리지 않는다 — 복제하면 표가 겹친다', async () => {
    const outer = table([['칸', '{{칸값}}']]).replace('<hp:run charPrIDRef="0"><hp:tbl', '<hp:run charPrIDRef="0"><hp:t>{{바깥}}</hp:t><hp:tbl');
    const bytes = await buildHwpx(outer);
    const result = await fillHwpx(bytes, values({ 바깥: 'X', 칸값: '채움' }));
    const xml = await sectionXml(result.bytes);
    expect(xml.match(/<hp:tbl /g)).toHaveLength(1);
    expect(xml).toContain('채움');
    expect(xml).toContain('{{바깥}}');
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `npx vitest run tests/doc-fill-hwpx.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/doc-fill/hwpx"`

- [ ] **Step 4: 구현**

```typescript
// src/lib/doc-fill/errors.ts
/** 양식을 읽거나 채우지 못한 이유. 문구는 사용자에게 그대로 간다. */
export class DocFillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocFillError';
  }
}
```

```typescript
// src/lib/doc-fill/xml-scan.ts
/**
 * 원본 XML을 다시 쓰지 않고 위치만 찾는 작은 훑개.
 *
 * 파서로 읽어 다시 쓰면 속성 순서·공백·네임스페이스 표기가 바뀔 수 있다.
 * 한글은 그런 차이에 까다로우므로 바꿀 곳만 문자열로 손댄다(설계 4.3).
 * 속성 값 안의 '>'도 따옴표로 묶여 있으면 태그 끝으로 보지 않는다.
 */
export interface XmlTag {
  /** '<' 위치 */
  start: number;
  /** '>' 다음 위치 */
  end: number;
  /** 접두어 포함 (예: hp:p) */
  name: string;
  kind: 'open' | 'close' | 'self';
}

const TAG = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;

export function scanTags(xml: string): XmlTag[] {
  const tags: XmlTag[] = [];
  TAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG.exec(xml))) {
    tags.push({
      start: m.index,
      end: m.index + m[0].length,
      name: m[2],
      kind: m[1] ? 'close' : m[4] ? 'self' : 'open',
    });
  }
  return tags;
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function unescapeXml(s: string): string {
  return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, e: string) => {
    if (e in ENTITIES) return ENTITIES[e];
    return String.fromCodePoint(e.startsWith('#x') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  });
}

/** 글자 내용(요소 사이)용. 따옴표는 속성 값이 아니므로 그대로 둔다 */
export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 문단 네임스페이스의 접두어. 한글은 보통 hp를 쓰지만 선언을 따른다 */
export function paragraphPrefix(xml: string): string {
  const m = xml.match(/xmlns:([\w.-]+)="http:\/\/www\.hancom\.co\.kr\/hwpml\/2011\/paragraph"/);
  return m ? m[1] : 'hp';
}
```

```typescript
// src/lib/doc-fill/slots.ts
/**
 * 채울 자리 규칙. S2-a는 기관이 넣은 표시({{이름}})만 읽는다.
 * 번호 제목·표 빈칸·자리 표시 글자 찾기는 S2-b에서 여기에 더한다(설계 4.1).
 */
export interface MarkerMatch {
  label: string;
  start: number;
  end: number;
}

const MARKER = /\{\{\s*([^{}\n]{1,60}?)\s*\}\}/g;

export function findMarkers(text: string): MarkerMatch[] {
  const out: MarkerMatch[] = [];
  MARKER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKER.exec(text))) {
    const label = m[1].trim();
    if (label) out.push({ label, start: m.index, end: m.index + m[0].length });
  }
  return out;
}
```

```typescript
// src/lib/doc-fill/hwpx.ts
import JSZip from 'jszip';
import { scanTags, unescapeXml, escapeXml, paragraphPrefix } from './xml-scan';
import { findMarkers } from './slots';
import { DocFillError } from './errors';

/**
 * HWPX 채우기. HWPX는 zip 안의 XML 묶음이고 본문은 Contents/section*.xml이다.
 *
 * - 본문 XML만 고친다. 서식 정의(header.xml)·그림·설정은 그대로 다시 넣는다
 * - 글은 <hp:t> 안에 있다. 한 문단(<hp:p>)이 여러 조각(<hp:run>)으로 나뉠 수
 *   있어 문단 단위로 글을 이어 붙여 표시를 찾는다
 * - 표 칸 안의 문단은 바깥 문단 안에 중첩된다. 중첩 문단이 없는 '맨 안쪽
 *   문단'만 고친다 — 표를 품은 문단을 복제하면 표가 겹친다
 */

interface TextPiece {
  /** 원본 XML에서 글자 내용의 위치(이스케이프된 상태) */
  start: number;
  end: number;
  /** 이스케이프를 푼 글 */
  text: string;
}

interface Para {
  start: number;
  end: number;
  pieces: TextPiece[];
  text: string;
}

const SECTION = /^Contents\/section(\d+)\.xml$/i;

function sectionNames(zip: JSZip): string[] {
  return Object.keys(zip.files)
    .filter((n) => SECTION.test(n))
    .sort((a, b) => Number(a.match(SECTION)![1]) - Number(b.match(SECTION)![1]));
}

async function openHwpx(bytes: Buffer): Promise<{ zip: JSZip; sections: string[] }> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new DocFillError('한글(HWPX) 파일을 열 수 없습니다. 파일이 손상됐을 수 있습니다.');
  }
  const sections = sectionNames(zip);
  if (sections.length === 0) throw new DocFillError('HWPX 본문(Contents/section*.xml)을 찾을 수 없습니다.');
  return { zip, sections };
}

/** 중첩 문단이 없는 문단과 그 안의 글 조각. 문서 순서 */
function leafParagraphs(xml: string, prefix: string): Para[] {
  const P = `${prefix}:p`;
  const T = `${prefix}:t`;
  const stack: { start: number; hasChild: boolean; pieces: TextPiece[] }[] = [];
  const out: Para[] = [];
  let inText = false;
  let cursor = 0;

  const addPiece = (from: number, to: number) => {
    if (from < to && stack.length > 0) {
      stack[stack.length - 1].pieces.push({ start: from, end: to, text: unescapeXml(xml.slice(from, to)) });
    }
  };

  for (const tag of scanTags(xml)) {
    if (inText) {
      // <hp:t> 안의 태그(탭·줄바꿈 등)는 글 조각을 끊는다
      addPiece(cursor, tag.start);
      if (tag.name === T && tag.kind === 'close') inText = false;
      else cursor = tag.end;
      continue;
    }
    if (tag.name === T && tag.kind === 'open') {
      inText = true;
      cursor = tag.end;
      continue;
    }
    if (tag.name !== P) continue;
    if (tag.kind === 'open') {
      if (stack.length > 0) stack[stack.length - 1].hasChild = true;
      stack.push({ start: tag.start, hasChild: false, pieces: [] });
    } else if (tag.kind === 'close') {
      const top = stack.pop();
      if (top && !top.hasChild) {
        out.push({ start: top.start, end: tag.end, pieces: top.pieces, text: top.pieces.map((p) => p.text).join('') });
      }
    } else if (stack.length > 0) {
      stack[stack.length - 1].hasChild = true;
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

function applyTexts(xml: string, para: Para, texts: string[]): string {
  let out = xml.slice(para.start, para.end);
  for (let i = para.pieces.length - 1; i >= 0; i--) {
    const p = para.pieces[i];
    out = out.slice(0, p.start - para.start) + escapeXml(texts[i]) + out.slice(p.end - para.start);
  }
  return out;
}

/** 글이 바뀐 문단의 줄 배치 캐시를 지운다. 남으면 한글이 옛 배치로 겹쳐 그릴 수 있다 */
function stripLineSegs(paraXml: string, prefix: string): string {
  const tag = `${prefix}:linesegarray`;
  return paraXml.replace(new RegExp(`<${tag}\\b[^>]*/>|<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'g'), '');
}

function rewriteParagraph(
  xml: string,
  para: Para,
  values: Map<string, string>,
  prefix: string,
  filled: Set<string>
): string | null {
  const markers = findMarkers(para.text).filter((m) => values.has(m.label));
  if (markers.length === 0) return null;

  const offsets: number[] = [];
  let acc = 0;
  for (const p of para.pieces) {
    offsets.push(acc);
    acc += p.text.length;
  }

  const texts = para.pieces.map((p) => p.text);
  const extraByMarker: string[][] = [];

  // 뒤에서부터 바꾼다 — 앞쪽 위치가 그대로 남는다
  for (const m of [...markers].reverse()) {
    filled.add(m.label);
    const lines = values.get(m.label)!.replace(/\r\n?/g, '\n').split('\n');
    extraByMarker.unshift(lines.slice(1));
    let first = true;
    for (let i = 0; i < para.pieces.length; i++) {
      const pieceStart = offsets[i];
      const pieceEnd = pieceStart + para.pieces[i].text.length;
      if (pieceEnd <= m.start || pieceStart >= m.end) continue;
      const localStart = Math.max(m.start, pieceStart) - pieceStart;
      const localEnd = Math.min(m.end, pieceEnd) - pieceStart;
      texts[i] = texts[i].slice(0, localStart) + (first ? lines[0] : '') + texts[i].slice(localEnd);
      first = false;
    }
  }

  const head = stripLineSegs(applyTexts(xml, para, texts), prefix);
  // 남은 줄은 같은 문단을 복제해 잇는다 — 글꼴·들여쓰기 같은 서식 참조가 그대로 남는다
  const clones = extraByMarker
    .flat()
    .map((line) => stripLineSegs(applyTexts(xml, para, para.pieces.map((_, i) => (i === 0 ? line : ''))), prefix));
  return head + clones.join('');
}

async function rewritePreview(zip: JSZip, text: string): Promise<void> {
  const file = zip.file('Preview/PrvText.txt');
  if (!file) return;
  const original = await file.async('uint8array');
  const preview = text.slice(0, 2000);
  // 파일 탐색기 미리보기에 자리 표시가 보이면 안 된다. 원래 인코딩을 따른다
  if (original[0] === 0xff && original[1] === 0xfe) {
    zip.file('Preview/PrvText.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(preview, 'utf16le')]));
  } else {
    zip.file('Preview/PrvText.txt', preview);
  }
}

export async function readHwpxMarkers(bytes: Buffer): Promise<string[]> {
  const { zip, sections } = await openHwpx(bytes);
  const labels: string[] = [];
  for (const name of sections) {
    const xml = await zip.files[name].async('string');
    for (const para of leafParagraphs(xml, paragraphPrefix(xml))) {
      for (const m of findMarkers(para.text)) {
        if (!labels.includes(m.label)) labels.push(m.label);
      }
    }
  }
  return labels;
}

export async function fillHwpx(
  bytes: Buffer,
  values: Map<string, string>
): Promise<{ bytes: Buffer; filled: string[]; unfilled: string[] }> {
  const { zip, sections } = await openHwpx(bytes);
  const order: string[] = [];
  const filled = new Set<string>();
  const previewLines: string[] = [];

  for (const name of sections) {
    const xml = await zip.files[name].async('string');
    const prefix = paragraphPrefix(xml);
    const paras = leafParagraphs(xml, prefix);
    for (const para of paras) {
      for (const m of findMarkers(para.text)) if (!order.includes(m.label)) order.push(m.label);
    }

    let out = xml;
    for (const para of [...paras].reverse()) {
      const replaced = rewriteParagraph(xml, para, values, prefix, filled);
      if (replaced !== null) out = out.slice(0, para.start) + replaced + out.slice(para.end);
    }
    if (out !== xml) zip.file(name, out);
    previewLines.push(...leafParagraphs(out, prefix).map((p) => p.text));
  }

  await rewritePreview(zip, previewLines.join('\r\n'));

  // 형식 규칙: mimetype은 zip 맨 앞에 압축 없이. 같은 이름으로 다시 넣으면 자리는 그대로다
  const mimetype = zip.file('mimetype');
  if (mimetype) zip.file('mimetype', await mimetype.async('uint8array'), { compression: 'STORE' });

  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return {
    bytes: out,
    filled: order.filter((l) => filled.has(l)),
    unfilled: order.filter((l) => !filled.has(l)),
  };
}
```

```javascript
// scripts/hwpx-probe.mjs
/**
 * 한글 호환 확인용(설계 10절 '확인 작업').
 *
 *   npm run hwpx:probe -- 입력.hwpx 출력.hwpx
 *
 * 한글이 저장한 HWPX에 엔진으로 글을 넣어 새 파일을 만든다. 출력 파일을
 * 한글에서 열어 (1) 열리는지 (2) 넣은 글이 양식 서식대로 보이는지
 * (3) 둘째 줄이 새 문단으로 나뉘었는지 (4) 저장 뒤 다시 열리는지 본다.
 * 양식에는 {{제목}}처럼 표시를 넣어 둔다.
 */
import { readFileSync, writeFileSync } from 'fs';
import { readHwpxMarkers, fillHwpx } from '../src/lib/doc-fill/hwpx.ts';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('사용법: npm run hwpx:probe -- 입력.hwpx 출력.hwpx');
  process.exit(1);
}

const bytes = readFileSync(input);
const labels = await readHwpxMarkers(bytes);
if (labels.length === 0) {
  console.error('표시({{항목}})를 찾지 못했습니다. 양식에 {{제목}} 같은 표시를 넣어 저장해 주세요.');
  process.exit(1);
}

const values = new Map(
  labels.map((label) => [label, `[${label}] 시험으로 넣은 첫 줄 & 특수문자 <확인>\n둘째 줄 — 새 문단이어야 합니다`])
);
const result = await fillHwpx(bytes, values);
writeFileSync(output, result.bytes);

console.log(`표시 ${labels.length}개: ${labels.join(', ')}`);
console.log(`채움 ${result.filled.length}개 · 못 채움 ${result.unfilled.length}개`);
console.log(`→ ${output} 를 한글에서 열어 확인하세요.`);
```

`package.json`의 `scripts`에 `"hwpx:probe": "tsx scripts/hwpx-probe.mjs",`를 더한다(다른 `tsx` 스크립트 옆).

- [ ] **Step 5: 통과 확인**

Run: `npx vitest run tests/doc-fill-hwpx.test.ts`
Expected: PASS (14 tests)

Run: `node --check scripts/hwpx-probe.mjs && npx tsc --noEmit`
Expected: 오류 없음

시험용 파일로 스크립트가 도는지도 본다:
```bash
npx tsx -e "import('./tests/fixtures/hwpx.ts').then(async (f) => require('fs').writeFileSync('probe-in.hwpx', await f.buildHwpx(f.para('{{제목}}'))))"
npm run hwpx:probe -- probe-in.hwpx probe-out.hwpx
```
Expected: `표시 1개: 제목` · `채움 1개`. 확인 뒤 `probe-in.hwpx`·`probe-out.hwpx`는 지운다(커밋하지 않는다).

- [ ] **Step 6: Commit**

```bash
git add src/lib/doc-fill tests/fixtures/hwpx.ts tests/doc-fill-hwpx.test.ts scripts/hwpx-probe.mjs package.json
git commit -m "feat: HWPX 채우기 엔진(표시 자리)과 한글 호환 확인 스크립트

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### 확인 지점 A — 사용자가 한글에서 열어 본다

컨트롤러는 여기서 멈추고 사용자에게 요청한다:

1. 한글에서 새 문서를 만들어 `{{제목}}`, 표 하나(칸에 `{{일시}}`), 본문 문단에 `{{본문}}`을 넣고 **HWPX로 저장**한다
2. `npm run hwpx:probe -- 그파일.hwpx 결과.hwpx`
3. `결과.hwpx`를 한글에서 연다 — 열리는가 · 글이 양식 서식대로인가 · 둘째 줄이 새 문단인가 · 저장 뒤 다시 열리는가

문제가 있으면 증상(오류 문구·화면)을 받아 Task 1을 고친다(줄 배치 캐시·문단 id·미리보기 등이 후보). 통과해야 Task 2로 간다.

---

### Task 2: 엔진 입구와 기본 양식 목록

**Files:**
- Create: `src/lib/doc-fill/index.ts`, `src/lib/builtin-templates.ts`, `assets/templates/README.md`
- Create: `tests/doc-fill-index.test.ts`, `tests/builtin-templates.test.ts`
- Modify: `next.config.mjs`

**Interfaces:**
- Consumes: Task 1 `readHwpxMarkers`·`fillHwpx`·`DocFillError`
- Produces:
  ```typescript
  // src/lib/doc-fill/index.ts
  export const MAX_SLOTS = 100;
  export const MAX_SLOT_TEXT = 6000;
  export const HWPX_MIME = 'application/hwp+zip';
  export type TemplateFormat = 'hwpx' | 'docx' | 'hwp' | 'unknown';
  export interface Slot { id: string; label: string; kind: 'marker' | 'section' | 'cell'; path: string[]; hint: string | null }
  export type ReadResult = { ok: true; format: 'hwpx'; slots: Slot[] } | { ok: false; reason: string };
  export type FillOutcome =
    | { ok: true; bytes: Buffer; mimeType: string; extension: 'hwpx'; filled: string[]; unfilled: string[] }
    | { ok: false; reason: string };
  export function detectFormat(fileName: string, bytes: Buffer): TemplateFormat;
  export async function readTemplate(bytes: Buffer, fileName: string): Promise<ReadResult>;
  export async function fillTemplate(bytes: Buffer, fileName: string, values: { slot_id: string; text: string }[]): Promise<FillOutcome>;

  // src/lib/builtin-templates.ts
  export interface BuiltinTemplate { ref: string; name: string; file: string; markers: string[] }
  export const BUILTIN_TEMPLATES: readonly BuiltinTemplate[];
  export function findBuiltinTemplate(ref: string): BuiltinTemplate | null;
  export const BUILTIN_TEMPLATE_DIR: string;
  export async function loadBuiltinTemplate(t: BuiltinTemplate, dir?: string): Promise<Buffer | null>; // 파일 없으면 null
  ```

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
// tests/doc-fill-index.test.ts
import { describe, it, expect } from 'vitest';
import { detectFormat, readTemplate, fillTemplate, MAX_SLOT_TEXT } from '@/lib/doc-fill';
import { extractTextFromHwp } from '@/lib/hwp';
import { buildHwpx, para } from './fixtures/hwpx';

const CFB = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);

describe('형식 판별', () => {
  it('확장자와 파일 머리를 함께 본다', async () => {
    const zip = await buildHwpx(para('x'));
    expect(detectFormat('a.hwpx', zip)).toBe('hwpx');
    expect(detectFormat('a.docx', zip)).toBe('docx');
    expect(detectFormat('a.hwp', CFB)).toBe('hwp');
    expect(detectFormat('a.hwpx', CFB)).toBe('unknown');
  });
});

describe('양식 읽기', () => {
  it('표시를 자리 번호와 함께 돌려준다', async () => {
    const r = await readTemplate(await buildHwpx(para('{{제목}}') + para('{{본문}}')), '보고.hwpx');
    expect(r).toEqual({
      ok: true,
      format: 'hwpx',
      slots: [
        { id: 's1', label: '제목', kind: 'marker', path: [], hint: null },
        { id: 's2', label: '본문', kind: 'marker', path: [], hint: null },
      ],
    });
  });

  it('옛 HWP·DOCX·표시 없는 양식은 이유를 돌려준다', async () => {
    expect(await readTemplate(CFB, '옛.hwp')).toEqual({ ok: false, reason: expect.stringContaining('HWPX로') });
    expect(await readTemplate(await buildHwpx(para('x')), 'w.docx')).toEqual({ ok: false, reason: expect.stringContaining('DOCX') });
    expect(await readTemplate(await buildHwpx(para('표시 없음')), 'n.hwpx')).toEqual({ ok: false, reason: expect.stringContaining('{{항목 이름}}') });
  });

  it('깨진 파일도 던지지 않고 이유를 돌려준다', async () => {
    const broken = Buffer.from('PK\u0003\u0004 broken');
    expect((await readTemplate(broken, 'b.hwpx')).ok).toBe(false);
  });
});

describe('양식 채우기', () => {
  it('자리 번호로 받은 글을 채운다', async () => {
    const bytes = await buildHwpx(para('{{제목}}') + para('{{본문}}'));
    const r = await fillTemplate(bytes, '보고.hwpx', [{ slot_id: 's1', text: '제목글' }, { slot_id: 's2', text: '본문글' }]);
    if (!r.ok) throw new Error(r.reason);
    expect(r.extension).toBe('hwpx');
    expect(r.mimeType).toBe('application/hwp+zip');
    const text = await extractTextFromHwp(r.bytes, 'o.hwpx');
    expect(text).toContain('제목글');
    expect(text).toContain('본문글');
  });

  it('없는 자리 번호는 거절한다', async () => {
    const r = await fillTemplate(await buildHwpx(para('{{제목}}')), 'a.hwpx', [{ slot_id: 's9', text: 'x' }]);
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('s9') });
  });

  it('한 자리 글자 수 상한을 넘으면 거절한다', async () => {
    const r = await fillTemplate(await buildHwpx(para('{{제목}}')), 'a.hwpx', [{ slot_id: 's1', text: '가'.repeat(MAX_SLOT_TEXT + 1) }]);
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('제목') });
  });
});
```

```typescript
// tests/builtin-templates.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { BUILTIN_TEMPLATES, findBuiltinTemplate, loadBuiltinTemplate, BUILTIN_TEMPLATE_DIR } from '@/lib/builtin-templates';
import { readHwpxMarkers } from '@/lib/doc-fill/hwpx';

describe('기본 양식', () => {
  it('세 가지이고 ref로 찾는다', () => {
    expect(BUILTIN_TEMPLATES.map((t) => t.ref)).toEqual(['builtin:official_letter', 'builtin:report', 'builtin:minutes']);
    expect(findBuiltinTemplate('builtin:minutes')?.file).toBe('minutes.hwpx');
    expect(findBuiltinTemplate('builtin:없음')).toBeNull();
    expect(findBuiltinTemplate('3f1c…')).toBeNull();
  });

  it('파일이 없으면 null — 아직 준비 안 된 기본 양식', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tpl-'));
    expect(await loadBuiltinTemplate(BUILTIN_TEMPLATES[0], dir)).toBeNull();
    writeFileSync(path.join(dir, BUILTIN_TEMPLATES[0].file), 'x');
    expect((await loadBuiltinTemplate(BUILTIN_TEMPLATES[0], dir))?.toString()).toBe('x');
  });

  // 사용자가 한글로 만든 파일이 들어오면 설계 7.1의 표시를 다 갖췄는지 본다
  for (const t of BUILTIN_TEMPLATES) {
    const file = path.join(BUILTIN_TEMPLATE_DIR, t.file);
    it.skipIf(!existsSync(file))(`${t.file}에 표시가 다 있다`, async () => {
      const found = await readHwpxMarkers((await loadBuiltinTemplate(t))!);
      expect(t.markers.filter((m) => !found.includes(m))).toEqual([]);
    });
  }
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/doc-fill-index.test.ts tests/builtin-templates.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/doc-fill"`

- [ ] **Step 3: 구현**

```typescript
// src/lib/doc-fill/index.ts
import { readHwpxMarkers, fillHwpx } from './hwpx';
import { DocFillError } from './errors';

/**
 * 채우기 엔진 입구. 형식을 고르고, 자리에 번호를 붙이고, 상한을 건다.
 * DB·저장소를 모른다 — 바이트를 받아 바이트를 돌려준다(설계 2절).
 * 실패는 던지지 않고 { ok: false, reason }으로 돌려준다. 이유는 사용자에게 간다.
 */
export const MAX_SLOTS = 100;
export const MAX_SLOT_TEXT = 6000;
export const HWPX_MIME = 'application/hwp+zip';

export type TemplateFormat = 'hwpx' | 'docx' | 'hwp' | 'unknown';

export interface Slot {
  id: string;
  label: string;
  kind: 'marker' | 'section' | 'cell';
  path: string[];
  hint: string | null;
}

export type ReadResult = { ok: true; format: 'hwpx'; slots: Slot[] } | { ok: false; reason: string };

export type FillOutcome =
  | { ok: true; bytes: Buffer; mimeType: string; extension: 'hwpx'; filled: string[]; unfilled: string[] }
  | { ok: false; reason: string };

export function detectFormat(fileName: string, bytes: Buffer): TemplateFormat {
  const ext = fileName.toLowerCase().split('.').pop();
  const isZip = bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  const isCfb = bytes.length > 7 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
  if (ext === 'hwpx' && isZip) return 'hwpx';
  if (ext === 'docx' && isZip) return 'docx';
  if (ext === 'hwp' && isCfb) return 'hwp';
  return 'unknown';
}

const UNSUPPORTED: Record<Exclude<TemplateFormat, 'hwpx'>, string> = {
  docx: 'Word(DOCX) 양식은 아직 채울 수 없습니다. 한글에서 HWPX로 저장해 올려 주세요.',
  hwp: '옛 한글(HWP) 형식은 직접 채울 수 없습니다. 한글에서 HWPX로 다시 저장해 올려 주세요.',
  unknown: '양식 파일 형식을 알 수 없습니다. 한글(HWPX) 파일을 올려 주세요.',
};

const NO_MARKERS =
  '이 양식에서 채울 자리를 찾지 못했습니다. 채울 자리에 {{항목 이름}}처럼 표시를 넣어 다시 올려 주세요.';

export async function readTemplate(bytes: Buffer, fileName: string): Promise<ReadResult> {
  const format = detectFormat(fileName, bytes);
  if (format !== 'hwpx') return { ok: false, reason: UNSUPPORTED[format] };
  try {
    const labels = await readHwpxMarkers(bytes);
    if (labels.length === 0) return { ok: false, reason: NO_MARKERS };
    if (labels.length > MAX_SLOTS) {
      return { ok: false, reason: `채울 자리가 ${labels.length}곳이라 상한(${MAX_SLOTS}곳)을 넘습니다.` };
    }
    return {
      ok: true,
      format,
      slots: labels.map((label, i) => ({ id: `s${i + 1}`, label, kind: 'marker' as const, path: [], hint: null })),
    };
  } catch (error) {
    if (error instanceof DocFillError) return { ok: false, reason: error.message };
    throw error;
  }
}

export async function fillTemplate(
  bytes: Buffer,
  fileName: string,
  values: { slot_id: string; text: string }[]
): Promise<FillOutcome> {
  const read = await readTemplate(bytes, fileName);
  if (!read.ok) return read;

  const labelById = new Map(read.slots.map((s) => [s.id, s.label]));
  const unknown = values.filter((v) => !labelById.has(v.slot_id)).map((v) => v.slot_id);
  if (unknown.length > 0) {
    return { ok: false, reason: `양식에 없는 자리 번호입니다: ${unknown.join(', ')}. read_template으로 자리를 다시 읽어 주세요.` };
  }
  const tooLong = values.filter((v) => v.text.length > MAX_SLOT_TEXT).map((v) => labelById.get(v.slot_id)!);
  if (tooLong.length > 0) {
    return { ok: false, reason: `한 자리에 ${MAX_SLOT_TEXT}자까지 넣을 수 있습니다. 넘은 자리: ${tooLong.join(', ')}` };
  }

  try {
    const result = await fillHwpx(bytes, new Map(values.map((v) => [labelById.get(v.slot_id)!, v.text])));
    return { ok: true, bytes: result.bytes, mimeType: HWPX_MIME, extension: 'hwpx', filled: result.filled, unfilled: result.unfilled };
  } catch (error) {
    if (error instanceof DocFillError) return { ok: false, reason: error.message };
    throw error;
  }
}
```

```typescript
// src/lib/builtin-templates.ts
import { readFile } from 'fs/promises';
import path from 'path';

/**
 * WORKON에 들어 있는 표준 서식(설계 7.1). 표준 서식으로 만들기 = 이 양식에 채우기.
 *
 * 파일은 사용자가 한글로 만들어 assets/templates/에 둔다 — 한글이 저장한
 * HWPX라야 호환성이 확실하다. 파일이 없으면 null을 돌려주고, 능력은
 * "아직 준비되지 않았다"고 알린다. markers는 파일이 갖춰야 할 표시 목록이고
 * tests/builtin-templates.test.ts가 실제 파일과 맞춰 본다.
 */
export interface BuiltinTemplate {
  ref: string;
  name: string;
  file: string;
  markers: string[];
}

export const BUILTIN_TEMPLATES: readonly BuiltinTemplate[] = [
  {
    ref: 'builtin:official_letter',
    name: '공문 기안문 (표준 서식)',
    file: 'official_letter.hwpx',
    markers: ['행정기관명', '수신', '경유', '제목', '본문', '붙임', '발신명의', '공개구분'],
  },
  {
    ref: 'builtin:report',
    name: '일반 보고서 (표준 서식)',
    file: 'report.hwpx',
    markers: ['제목', '작성일', '작성부서', '개요', '추진 경과', '주요 내용', '향후 계획', '건의 사항'],
  },
  {
    ref: 'builtin:minutes',
    name: '회의록 (표준 서식)',
    file: 'minutes.hwpx',
    markers: ['회의명', '일시', '장소', '주관', '참석자', '안건', '논의 내용', '결정 사항', '향후 계획', '작성자'],
  },
];

export function findBuiltinTemplate(ref: string): BuiltinTemplate | null {
  return BUILTIN_TEMPLATES.find((t) => t.ref === ref) ?? null;
}

export const BUILTIN_TEMPLATE_DIR = path.join(process.cwd(), 'assets', 'templates');

export async function loadBuiltinTemplate(t: BuiltinTemplate, dir: string = BUILTIN_TEMPLATE_DIR): Promise<Buffer | null> {
  try {
    return await readFile(path.join(dir, t.file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
```

`next.config.mjs` — `nextConfig`에 더한다(대화 라우트가 기본 양식을 읽는다. 없으면 Vercel 배포 묶음에서 빠진다):
```javascript
  experimental: {
    outputFileTracingIncludes: {
      '/api/chat': ['./assets/templates/**/*'],
    },
  },
```

`assets/templates/README.md`:
```markdown
# 기본 양식 (표준 서식)

'문서 만들기' 능력이 켜진 모든 비서가 쓰는 표준 서식이다. **한글에서 만들어 HWPX로 저장**해 이 폴더에 둔다.
코드로 만든 HWPX는 한글에서 깨질 위험이 있어 진짜 한글 파일을 쓴다(설계 1절 결정 5).

| 파일 | 이름 | 넣을 표시 |
|---|---|---|
| `official_letter.hwpx` | 공문 기안문 | `{{행정기관명}}` `{{수신}}` `{{경유}}` `{{제목}}` `{{본문}}` `{{붙임}}` `{{발신명의}}` `{{공개구분}}` |
| `report.hwpx` | 일반 보고서 | `{{제목}}` `{{작성일}}` `{{작성부서}}` `{{개요}}` `{{추진 경과}}` `{{주요 내용}}` `{{향후 계획}}` `{{건의 사항}}` |
| `minutes.hwpx` | 회의록 | `{{회의명}}` `{{일시}}` `{{장소}}` `{{주관}}` `{{참석자}}` `{{안건}}` `{{논의 내용}}` `{{결정 사항}}` `{{향후 계획}}` `{{작성자}}` |

## 만드는 법

- 표시는 채울 자리에 그대로 입력한다. 글꼴·크기·들여쓰기는 표시에 준 서식이 채운 글에 그대로 간다
- 여러 문단이 들어갈 자리(`{{본문}}` 등)는 **표시만 있는 문단**으로 둔다. 줄마다 그 문단이 복제된다
- 표 칸 안의 표시는 채워진다. 다만 **표를 품은 문단 자체(표 앞뒤 같은 줄)**에 둔 표시는 채우지 않는다
- 공문 기안문의 결재란·시행 번호·주소 같은 칸은 표시 없이 비워 둔다 — 실제 기안은 전자문서시스템에서 한다
- 일반 보고서는 `□ 개요` 같은 제목 아래 문단에 표시를 둔다

## 확인

`npm run hwpx:probe -- report.hwpx 확인.hwpx` → `확인.hwpx`를 한글에서 열어 본다.
`npx vitest run tests/builtin-templates.test.ts`가 표시가 다 있는지 본다.
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run tests/doc-fill-index.test.ts tests/builtin-templates.test.ts && npx tsc --noEmit`
Expected: PASS (기본 양식 파일이 아직 없으면 표시 검사 3개는 skip)

- [ ] **Step 5: Commit**

```bash
git add src/lib/doc-fill/index.ts src/lib/builtin-templates.ts assets/templates/README.md next.config.mjs tests/doc-fill-index.test.ts tests/builtin-templates.test.ts
git commit -m "feat: 채우기 엔진 입구(형식·자리 번호·상한)와 기본 양식 목록

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 생성 파일 보관 (0029 · generated-files)

**Files:**
- Create: `supabase/migrations/0029_generated_files.sql`, `src/lib/generated-files.ts`, `tests/generated-files.test.ts`
- Modify: `src/lib/capabilities/types.ts` (`GeneratedFileRef`만 — 나머지는 Task 5), `scripts/db-check.mjs`, `scripts/isolation-check.mjs`

**Interfaces:**
- Produces:
  ```typescript
  // src/lib/capabilities/types.ts
  export interface GeneratedFileRef { id: string; file_name: string; size_bytes: number }

  // src/lib/generated-files.ts
  export function safeFileName(title: string, extension: string): string;
  export function generatedStoragePath(orgId: string, conversationId: string, fileId: string, extension: string): string;
  export interface SaveGeneratedFileInput {
    organizationId: string; departmentId: string; userId: string; agentId: string; conversationId: string;
    templateRef: string; templateName: string; fileName: string; extension: string; mimeType: string; bytes: Buffer;
  }
  export async function saveGeneratedFile(input: SaveGeneratedFileInput): Promise<GeneratedFileRef>; // 실패면 던진다
  export async function findOwnedFile(fileId: string, userId: string): Promise<{ storage_path: string; file_name: string } | null>;
  export async function signedDownloadUrl(storagePath: string, fileName: string): Promise<string | null>;
  export async function deleteConversationFiles(conversationId: string): Promise<void>; // 던지지 않는다
  ```

- [ ] **Step 1: 마이그레이션 작성**

```sql
-- =============================================================
-- 0029_generated_files.sql
-- 비서가 만든 파일 (S2-a)
--
-- 설계: docs/superpowers/specs/2026-10-15-s2-document-fill-design.md 5절
--
-- 배포 순서: 이 파일 → S2-a 코드. 코드가 이 표에 쓴다.
-- 파일 바이트는 저장소(documents 버킷 generated/…)에 있고 여기는 기록이다.
-- 대화를 지우면 행이 함께 지워진다. 저장소 파일은 대화 삭제 라우트가 먼저 지운다.
-- =============================================================

CREATE TABLE IF NOT EXISTS generated_files (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  department_id   uuid NOT NULL REFERENCES departments(id),
  organization_id uuid REFERENCES organizations(id),
  agent_id        uuid REFERENCES agents(id) ON DELETE SET NULL,
  template_ref    text NOT NULL,
  template_name   text NOT NULL,
  file_name       text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 120),
  mime_type       text NOT NULL,
  size_bytes      integer NOT NULL CHECK (size_bytes >= 0),
  storage_path    text NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_generated_files_conversation ON generated_files(conversation_id);
CREATE INDEX IF NOT EXISTS idx_generated_files_user ON generated_files(user_id, created_at DESC);

COMMENT ON TABLE generated_files IS
  '비서가 만든 파일(양식 채우기·표준 서식). 주인(user_id)만 내려받는다. 대화와 수명을 같이 한다.';

-- 기관은 부서에서 채운다 (0016과 같은 함수)
DROP TRIGGER IF EXISTS trg_generated_files_fill_org ON generated_files;
CREATE TRIGGER trg_generated_files_fill_org
  BEFORE INSERT OR UPDATE OF department_id ON generated_files
  FOR EACH ROW EXECUTE FUNCTION fill_organization_id_from_department();

-- ── 확인 ─────────────────────────────────────────────────────
SELECT tgname FROM pg_trigger WHERE tgrelid = 'generated_files'::regclass AND NOT tgisinternal;
-- trg_generated_files_fill_org 1행이어야 한다
```

- [ ] **Step 2: 실패하는 테스트 작성**

```typescript
// tests/generated-files.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';

type Call = { table?: string; op: string; args: unknown[] };
const calls: Call[] = [];
const state = {
  uploadError: null as null | { message: string },
  insertError: null as null | { message: string },
  removeError: null as null | { message: string },
  selectRows: [] as { storage_path: string }[],
  owned: null as null | { storage_path: string; file_name: string },
};

vi.mock('@/lib/supabaseAdmin', () => {
  const chain = (table: string, result: () => unknown) => {
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'is', 'order']) {
      q[m] = (...args: unknown[]) => {
        calls.push({ table, op: m, args });
        return q;
      };
    }
    q.maybeSingle = () => Promise.resolve(result());
    q.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve);
    return q;
  };
  return {
    supabaseAdmin: {
      from(table: string) {
        return {
          insert(row: unknown) {
            calls.push({ table, op: 'insert', args: [row] });
            return Promise.resolve({ error: state.insertError });
          },
          select(...args: unknown[]) {
            calls.push({ table, op: 'select', args });
            return chain(table, () =>
              state.owned !== null || table !== 'generated_files'
                ? { data: state.owned, error: null }
                : { data: state.selectRows, error: null }
            );
          },
        };
      },
      storage: {
        from(bucket: string) {
          return {
            upload(path: string, _bytes: unknown, opts: unknown) {
              calls.push({ op: 'upload', args: [bucket, path, opts] });
              return Promise.resolve({ error: state.uploadError });
            },
            remove(paths: string[]) {
              calls.push({ op: 'remove', args: [bucket, paths] });
              return Promise.resolve({ error: state.removeError });
            },
            createSignedUrl(path: string, ttl: number, opts: unknown) {
              calls.push({ op: 'sign', args: [path, ttl, opts] });
              return Promise.resolve({ data: { signedUrl: `https://signed/${path}` }, error: null });
            },
          };
        },
      },
    },
  };
});

const logged: unknown[] = [];
vi.mock('@/lib/logger', () => ({ logSystem: (p: unknown) => { logged.push(p); return Promise.resolve(); } }));

import {
  safeFileName,
  generatedStoragePath,
  saveGeneratedFile,
  findOwnedFile,
  signedDownloadUrl,
  deleteConversationFiles,
} from '@/lib/generated-files';

const input = {
  organizationId: 'org', departmentId: 'dept', userId: 'u1', agentId: 'a1', conversationId: 'c1',
  templateRef: 'builtin:minutes', templateName: '회의록', fileName: '주간 회의록.hwpx', extension: 'hwpx',
  mimeType: 'application/hwp+zip', bytes: Buffer.from('PKdata'),
};

beforeEach(() => {
  calls.length = 0;
  logged.length = 0;
  Object.assign(state, { uploadError: null, insertError: null, removeError: null, selectRows: [], owned: null });
});

describe('파일 이름', () => {
  it('쓸 수 없는 글자를 바꾸고 비면 기본 이름', () => {
    expect(safeFileName('  2026/10 주간:회의록?  ', 'hwpx')).toBe('2026 10 주간 회의록.hwpx');
    expect(safeFileName('<>|', 'hwpx')).toBe('문서.hwpx');
    expect(safeFileName('가'.repeat(200), 'hwpx')).toBe(`${'가'.repeat(80)}.hwpx`);
  });

  it('저장소 경로에는 한글 이름을 넣지 않는다', () => {
    expect(generatedStoragePath('org', 'c1', 'f1', 'hwpx')).toBe('generated/org/c1/f1.hwpx');
  });
});

describe('저장', () => {
  it('저장소에 올리고 같은 id·경로로 기록한다', async () => {
    const ref = await saveGeneratedFile(input);
    const upload = calls.find((c) => c.op === 'upload')!;
    const insert = calls.find((c) => c.op === 'insert')!;
    const row = insert.args[0] as Record<string, unknown>;
    expect(upload.args[1]).toBe(`generated/org/c1/${ref.id}.hwpx`);
    expect(row).toMatchObject({
      id: ref.id, conversation_id: 'c1', user_id: 'u1', department_id: 'dept', agent_id: 'a1',
      template_ref: 'builtin:minutes', file_name: '주간 회의록.hwpx', size_bytes: 6, storage_path: upload.args[1],
    });
    expect(row).not.toHaveProperty('organization_id'); // 트리거가 채운다
    expect(ref).toEqual({ id: ref.id, file_name: '주간 회의록.hwpx', size_bytes: 6 });
  });

  it('기록이 실패하면 올린 파일을 지우고 던진다', async () => {
    state.insertError = { message: 'boom' };
    await expect(saveGeneratedFile(input)).rejects.toThrow('기록');
    expect(calls.some((c) => c.op === 'remove')).toBe(true);
  });

  it('올리기가 실패하면 기록하지 않고 던진다', async () => {
    state.uploadError = { message: 'full' };
    await expect(saveGeneratedFile(input)).rejects.toThrow('저장');
    expect(calls.some((c) => c.op === 'insert')).toBe(false);
  });
});

describe('조회·내려받기', () => {
  it('주인 조건으로만 찾는다', async () => {
    state.owned = { storage_path: 'p', file_name: 'n.hwpx' };
    expect(await findOwnedFile('f1', 'u1')).toEqual({ storage_path: 'p', file_name: 'n.hwpx' });
    const eqs = calls.filter((c) => c.op === 'eq').map((c) => c.args);
    expect(eqs).toContainEqual(['id', 'f1']);
    expect(eqs).toContainEqual(['user_id', 'u1']);
  });

  it('서명 주소는 60초, 원래 이름으로 받게 한다', async () => {
    expect(await signedDownloadUrl('generated/x.hwpx', '회의록.hwpx')).toBe('https://signed/generated/x.hwpx');
    expect(calls.find((c) => c.op === 'sign')!.args).toEqual(['generated/x.hwpx', 60, { download: '회의록.hwpx' }]);
  });
});

describe('대화 삭제 때', () => {
  it('그 대화의 파일을 저장소에서 지운다', async () => {
    state.selectRows = [{ storage_path: 'generated/a.hwpx' }, { storage_path: 'generated/b.hwpx' }];
    await deleteConversationFiles('c1');
    expect(calls.find((c) => c.op === 'remove')!.args[1]).toEqual(['generated/a.hwpx', 'generated/b.hwpx']);
    expect(logged).toEqual([]);
  });

  it('저장소 삭제가 실패하면 남은 경로를 시스템 로그에 남기고 던지지 않는다', async () => {
    state.selectRows = [{ storage_path: 'generated/a.hwpx' }];
    state.removeError = { message: 'denied' };
    await expect(deleteConversationFiles('c1')).resolves.toBeUndefined();
    expect(JSON.stringify(logged)).toContain('generated/a.hwpx');
  });

  it('대화 삭제 라우트가 대화를 지우기 전에 부른다', () => {
    const src = readFileSync('src/app/api/conversations/[id]/route.ts', 'utf8');
    const del = src.slice(src.indexOf('export async function DELETE'));
    // 작업 사본은 CRLF일 수 있다(core.autocrlf) — 줄바꿈에 기대지 않는다
    const callAt = del.indexOf('deleteConversationFiles(');
    const deleteAt = del.search(/\.from\('conversations'\)\s*\.delete\(\)/);
    expect(callAt).toBeGreaterThan(-1);
    expect(deleteAt).toBeGreaterThan(-1);
    expect(callAt).toBeLessThan(deleteAt);
  });
});
```

(마지막 테스트는 Task 4에서 라우트를 고칠 때까지 실패한다 — Task 3의 Step 4에서는 그 하나만 실패하는 것이 정상이다. Task 4 Step 4에서 통과한다.)

- [ ] **Step 3: 실패 확인**

Run: `npx vitest run tests/generated-files.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/generated-files"`

- [ ] **Step 4: 구현**

`src/lib/capabilities/types.ts`의 `ToolOutcome` 위에 더한다:
```typescript
/** 도구가 만든 파일. 화면(tool_end)과 메시지 저장(source_references.files)으로 간다 */
export interface GeneratedFileRef {
  id: string;
  file_name: string;
  size_bytes: number;
}
```

```typescript
// src/lib/generated-files.ts
import { randomUUID } from 'crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { SUPABASE_DOCUMENTS_BUCKET } from '@/lib/config';
import { logSystem } from '@/lib/logger';
import type { GeneratedFileRef } from '@/lib/capabilities/types';

/**
 * 비서가 만든 파일 — 기록(generated_files)과 저장소 파일을 함께 다룬다.
 * 저장소 접근은 이 파일에서만 한다(서비스 정의서 7.4 '저장소 연결부').
 *
 * 경로에는 한글 이름을 넣지 않는다. 이름은 DB에만 두고, 내려받을 때 서명
 * 주소의 download 옵션으로 붙인다(templateStoragePath와 같은 관례).
 */

const MAX_TITLE = 80;

export function safeFileName(title: string, extension: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE)
    .trim();
  return `${cleaned || '문서'}.${extension}`;
}

export function generatedStoragePath(orgId: string, conversationId: string, fileId: string, extension: string): string {
  return `generated/${orgId}/${conversationId}/${fileId}.${extension}`;
}

export interface SaveGeneratedFileInput {
  organizationId: string;
  departmentId: string;
  userId: string;
  agentId: string;
  conversationId: string;
  templateRef: string;
  templateName: string;
  fileName: string;
  extension: string;
  mimeType: string;
  bytes: Buffer;
}

export async function saveGeneratedFile(input: SaveGeneratedFileInput): Promise<GeneratedFileRef> {
  const id = randomUUID();
  const storagePath = generatedStoragePath(input.organizationId, input.conversationId, id, input.extension);
  const bucket = supabaseAdmin.storage.from(SUPABASE_DOCUMENTS_BUCKET);

  const { error: uploadError } = await bucket.upload(storagePath, input.bytes, {
    contentType: input.mimeType,
    upsert: false,
  });
  if (uploadError) throw new Error(`파일을 저장하지 못했습니다: ${uploadError.message}`);

  // organization_id는 트리거가 department_id로부터 채운다(0029)
  const { error: insertError } = await supabaseAdmin.from('generated_files').insert({
    id,
    conversation_id: input.conversationId,
    user_id: input.userId,
    department_id: input.departmentId,
    agent_id: input.agentId,
    template_ref: input.templateRef,
    template_name: input.templateName,
    file_name: input.fileName,
    mime_type: input.mimeType,
    size_bytes: input.bytes.length,
    storage_path: storagePath,
  });
  if (insertError) {
    // 기록 없는 파일은 아무도 내려받거나 지울 수 없다. 올린 것을 되돌린다
    await bucket.remove([storagePath]);
    throw new Error(`파일 기록을 남기지 못했습니다: ${insertError.message}`);
  }

  return { id, file_name: input.fileName, size_bytes: input.bytes.length };
}

export async function findOwnedFile(
  fileId: string,
  userId: string
): Promise<{ storage_path: string; file_name: string } | null> {
  const { data, error } = await supabaseAdmin
    .from('generated_files')
    .select('storage_path, file_name')
    .eq('id', fileId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    console.error('[generated-files] 조회 오류:', error);
    return null;
  }
  return (data as { storage_path: string; file_name: string } | null) ?? null;
}

/**
 * 60초짜리 서명 주소. 함수가 파일을 직접 보내지 않는 이유: Vercel 서버리스
 * 함수는 응답 본문도 4.5MB로 제한된다(설계 5.3).
 */
export async function signedDownloadUrl(storagePath: string, fileName: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin.storage
    .from(SUPABASE_DOCUMENTS_BUCKET)
    .createSignedUrl(storagePath, 60, { download: fileName });
  if (error || !data?.signedUrl) {
    console.error('[generated-files] 서명 주소 오류:', error);
    return null;
  }
  return data.signedUrl;
}

/**
 * 대화를 지우기 전에 부른다. DB 연쇄 삭제는 저장소 파일을 지우지 않는다.
 * 실패해도 던지지 않는다 — 대화 삭제를 막지 않되, 남은 경로를 남겨 손으로 지울 수 있게 한다.
 */
export async function deleteConversationFiles(conversationId: string): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from('generated_files')
    .select('storage_path')
    .eq('conversation_id', conversationId);
  if (error) {
    await logSystem({
      level: 'error',
      category: 'database',
      message: '생성 파일 목록 조회 실패 — 대화 삭제 뒤 저장소에 파일이 남을 수 있음',
      details: { conversationId, error: error.message },
    });
    return;
  }

  const paths = ((data ?? []) as { storage_path: string }[]).map((r) => r.storage_path);
  if (paths.length === 0) return;

  const { error: removeError } = await supabaseAdmin.storage.from(SUPABASE_DOCUMENTS_BUCKET).remove(paths);
  if (removeError) {
    await logSystem({
      level: 'error',
      category: 'database',
      message: '생성 파일 저장소 삭제 실패 — 아래 경로를 손으로 지워야 함',
      details: { conversationId, paths, error: removeError.message },
    });
  }
}
```

`scripts/db-check.mjs`:
- `checks` 배열 끝(0026 줄들 뒤)에 더한다:
  ```javascript
  ['0029', 'generated_files 테이블',     () => db.from('generated_files').select('id, conversation_id, organization_id, storage_path').limit(1)],
  ```
- `=== 기관 미연결 행 ===`의 표 목록을 `['departments', 'agents', 'documents', 'usage_logs', 'generated_files']`로 바꾼다

`scripts/isolation-check.mjs`:
- `=== 3. 기관 미연결 행 ===`의 표 목록에 `'generated_files'`를 더한다
- `=== 4-1. 부서 비서 기관 일치 ===` 블록 뒤에 같은 꼴로 더한다:
  ```javascript
  console.log('\n=== 4-2. 생성 파일 기관 일치 ===');
  {
    const { data: files, error } = await db.from('generated_files').select('id, department_id, organization_id');
    if (error) {
      // 0029 전이면 표가 없다. 확인 못 한 것은 위반으로 센다
      fail('생성 파일 조회 실패', error.message);
    } else {
      const deptOrg = new Map(depts.map((d) => [d.id, d.organization_id]));
      const crossed = (files ?? []).filter((f) => deptOrg.get(f.department_id) !== f.organization_id);
      if (crossed.length > 0) fail(`생성 파일 ${files.length}개 중 기관 어긋남 ${crossed.length}개`);
      else pass(`생성 파일 ${files?.length ?? 0}개 — 부서와 기관이 일치`);
    }
  }
  ```

- [ ] **Step 5: 통과 확인**

Run: `npx vitest run tests/generated-files.test.ts`
Expected: '대화 삭제 라우트가 … 부른다' 하나만 FAIL(Task 4에서 고친다), 나머지 PASS

Run: `node --check scripts/db-check.mjs scripts/isolation-check.mjs && npx tsc --noEmit`
Expected: 오류 없음. **DB 명령(`db:migrate`)은 돌리지 않는다** — 0029는 사용자가 적용한다

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0029_generated_files.sql src/lib/generated-files.ts src/lib/capabilities/types.ts tests/generated-files.test.ts scripts/db-check.mjs scripts/isolation-check.mjs
git commit -m "feat: 생성 파일 보관(0029)과 저장·조회·정리

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 내려받기 라우트 · 대화 삭제 때 파일 정리

**Files:**
- Create: `src/app/api/files/[id]/route.ts`, `tests/files-route.test.ts`
- Modify: `src/app/api/conversations/[id]/route.ts` (DELETE), `tests/route-auth.test.ts` (`EMPLOYEE_ROUTES`에 `'/files/[id]'`)

**Interfaces:**
- Consumes: Task 3 `findOwnedFile`·`signedDownloadUrl`·`deleteConversationFiles`
- Produces: `GET /api/files/[id]` → 302(서명 주소) · 401 · 404 · 500

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
// tests/files-route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const session = { current: null as null | { user: { id: string } } };
vi.mock('@/lib/auth', () => ({ getServerAuthSession: () => Promise.resolve(session.current) }));

const files = {
  owned: null as null | { storage_path: string; file_name: string },
  url: 'https://signed/x' as string | null,
  lookups: [] as [string, string][],
};
vi.mock('@/lib/generated-files', () => ({
  findOwnedFile: (id: string, user: string) => {
    files.lookups.push([id, user]);
    return Promise.resolve(files.owned);
  },
  signedDownloadUrl: () => Promise.resolve(files.url),
}));

import { GET } from '@/app/api/files/[id]/route';

const ID = '3f1c2b9e-1d2c-4e5f-8a9b-0c1d2e3f4a5b';
const call = (id: string) => GET(new NextRequest(`http://localhost/api/files/${id}`), { params: { id } });

beforeEach(() => {
  session.current = { user: { id: 'u1' } };
  Object.assign(files, { owned: { storage_path: 'generated/o/c/f.hwpx', file_name: '회의록.hwpx' }, url: 'https://signed/x', lookups: [] });
});

describe('내려받기', () => {
  it('로그인하지 않으면 401', async () => {
    session.current = null;
    expect((await call(ID)).status).toBe(401);
  });

  it('id 꼴이 아니면 찾아보지도 않고 404', async () => {
    expect((await call('../etc')).status).toBe(404);
    expect(files.lookups).toEqual([]);
  });

  it('내 파일이 아니면 404 — 있다는 사실도 알리지 않는다', async () => {
    files.owned = null;
    const res = await call(ID);
    expect(res.status).toBe(404);
    expect(files.lookups).toEqual([[ID, 'u1']]);
  });

  it('내 파일이면 서명 주소로 넘긴다', async () => {
    const res = await call(ID);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://signed/x');
  });

  it('서명 주소를 못 만들면 500', async () => {
    files.url = null;
    const res = await call(ID);
    expect(res.status).toBe(500);
    expect((await res.json()).ok).toBe(false);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/files-route.test.ts`
Expected: FAIL — `Failed to resolve import "@/app/api/files/[id]/route"`

- [ ] **Step 3: 구현**

```typescript
// src/app/api/files/[id]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { findOwnedFile, signedDownloadUrl } from '@/lib/generated-files';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/**
 * 비서가 만든 파일 내려받기. 주인만 받는다 — 관리자도 못 받는다(설계 5.3).
 * 감사 화면에는 생성 사실과 파일 이름만 남는다.
 */
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);

  if (!UUID.test(params.id)) return jsonError('파일을 찾을 수 없습니다.', 404);

  const file = await findOwnedFile(params.id, session.user.id);
  if (!file) return jsonError('파일을 찾을 수 없습니다.', 404);

  const url = await signedDownloadUrl(file.storage_path, file.file_name);
  if (!url) return jsonError('내려받을 주소를 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 500);

  return NextResponse.redirect(url, 302);
}
```

`src/app/api/conversations/[id]/route.ts`:
- import에 `import { deleteConversationFiles } from '@/lib/generated-files';`
- DELETE에서 소유자 확인(`if (!existing) { … 404 }`) 바로 뒤, `// 메시지 먼저 삭제` 앞에:
  ```typescript
      // 대화가 만든 파일을 저장소에서 먼저 지운다. DB 연쇄 삭제는 저장소를 지우지 않는다(설계 5.4)
      await deleteConversationFiles(conversationId);
  ```

`tests/route-auth.test.ts`의 `EMPLOYEE_ROUTES`에 `'/files/[id]',`를 `'/enhance-prompt',` 앞에 더한다.

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run tests/files-route.test.ts tests/generated-files.test.ts tests/route-auth.test.ts && npx tsc --noEmit`
Expected: 전부 PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/api/files tests/files-route.test.ts src/app/api/conversations/[id]/route.ts tests/route-auth.test.ts
git commit -m "feat: 생성 파일 내려받기(주인만)와 대화 삭제 때 파일 정리

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 파일 링크 전달 — 실행기에서 화면까지

**Files:**
- Modify: `src/lib/capabilities/types.ts`, `src/lib/assistant/types.ts`, `src/lib/assistant/stream.ts`, `src/lib/assistant/persist.ts`, `src/lib/assistant/prepare.ts`
- Modify: `src/components/chat/ChatInterface.tsx`, `src/components/chat/MessageBubble.tsx`
- Create: `src/lib/file-size.ts`
- Modify (테스트): `tests/tool-loop.test.ts`, `tests/stream-turn.test.ts`, `tests/assistant-parts.test.ts`, `tests/capabilities.test.ts`, 그 밖에 `TurnContext`를 직접 만드는 테스트 — `grep -rln "agentVersion:" tests`로 찾는다
- Create: `tests/file-size.test.ts`

**Interfaces:**
- Consumes: Task 3 `GeneratedFileRef`
- Produces:
  ```typescript
  // capabilities/types.ts
  interface TurnContext { /* 기존 칸 */ conversationId: string }
  interface ToolOutcome { /* 기존 칸 */ files?: GeneratedFileRef[] }
  // assistant/types.ts — tool_end
  { event: 'tool_end'; data: { name: string; ok: boolean; sources: ToolSource[]; files: GeneratedFileRef[] } }
  // stream.ts
  interface LoopResult { /* 기존 칸 */ files: GeneratedFileRef[] }
  // persist.ts
  interface MessageRowInput { /* 기존 칸 */ files: GeneratedFileRef[] }  // assistant 행 source_references.files
  // file-size.ts
  export function formatFileSize(bytes: number): string;
  ```

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/tool-loop.test.ts` — `ctx`에 `conversationId: 'c'`를 더하고, `describe('도구 루프')` 안에 더한다:
```typescript
  it('도구가 만든 파일을 tool_end와 결과에 싣는다', async () => {
    const file = { id: 'f1', file_name: '회의록.hwpx', size_bytes: 1234 };
    const adapter = scripted([[toolCall('t1'), done('tool_use')], [{ type: 'text', text: '만들었습니다' }, done('end_turn')]]);
    const owners = new Map([['law_search', lawCapability(async () => ({ ok: true, text: 'ok', files: [file] }))]]);
    const { result, events } = await run(adapter, owners);
    expect(events).toContainEqual({ event: 'tool_end', data: { name: 'law_search', ok: true, sources: [], files: [file] } });
    expect(result.files).toEqual([file]);
  });
```
기존 테스트가 `tool_end` 이벤트를 `toEqual`로 비교하면 `files: []`를 더한다.

`tests/stream-turn.test.ts` — `turn()`의 `ctx`에 `conversationId: 'c1'`을 더하고, 성공 경로를 보는 `describe` 안에 더한다(파일을 돌려주는 가짜 능력과 도구 호출 라운드를 쓴다 — 이 파일의 기존 도우미가 도구 호출 라운드를 만드는 방식을 따른다):
```typescript
  it('만든 파일을 답변 행의 source_references.files에 남긴다', async () => {
    const file = { id: 'f1', file_name: '회의록.hwpx', size_bytes: 10 };
    const cap = { id: 'document', label: '', description: '', isAvailable: () => true,
      tools: () => [{ name: 'fill_template', description: '', inputSchema: { type: 'object', properties: {} } }],
      execute: async () => ({ ok: true, text: 'ok', files: [file] }) } as never;
    setLlmAdapterForTests(scriptedAdapter([
      [{ type: 'tool_use', id: 't1', name: 'fill_template', input: {} }, doneEvent('tool_use')],
      [{ type: 'text', text: '만들었습니다' }, doneEvent('end_turn')],
    ]));
    await streamTurn(turn({ capabilities: [cap], tools: [{ name: 'fill_template', description: '', inputSchema: { type: 'object', properties: {} } }] }), () => {});
    const rows = writes.find((w) => w.table === 'messages')!.rows;
    expect((rows[1].source_references as { files: unknown[] }).files).toEqual([file]);
    expect(Object.keys(rows[0]).sort()).toEqual(Object.keys(rows[1]).sort());
  });
```
`scriptedAdapter`·`doneEvent`는 이 파일에 이미 있는 가짜 어댑터 도우미의 실제 이름으로 바꿔 쓴다(없으면 `tests/tool-loop.test.ts`의 `scripted`·`done`과 같은 꼴로 이 파일 위쪽에 만든다).

`tests/assistant-parts.test.ts` — `buildMessageRows({...})` 호출에 `files: [{ id: 'f', file_name: 'a.hwpx', size_bytes: 1 }],`를 더하고 테스트를 더한다:
```typescript
  it('파일 링크를 답변 행에 남긴다', () => {
    expect((rows[1].source_references as { files: unknown[] }).files).toEqual([{ id: 'f', file_name: 'a.hwpx', size_bytes: 1 }]);
    expect(rows[0].source_references).toEqual({});
  });
```

`tests/capabilities.test.ts` — `ctx()` 기본값에 `conversationId: 'c'`를 더한다.

```typescript
// tests/file-size.test.ts
import { describe, it, expect } from 'vitest';
import { formatFileSize } from '@/lib/file-size';

describe('파일 크기 표시', () => {
  it('KB는 반올림, 1KB 미만도 1KB, MB는 소수 한 자리', () => {
    expect(formatFileSize(10)).toBe('1KB');
    expect(formatFileSize(15_360)).toBe('15KB');
    expect(formatFileSize(2_621_440)).toBe('2.5MB');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/tool-loop.test.ts tests/stream-turn.test.ts tests/assistant-parts.test.ts tests/file-size.test.ts`
Expected: FAIL — 새 테스트들(`files`가 없음, `@/lib/file-size` 없음)

- [ ] **Step 3: 구현**

`src/lib/capabilities/types.ts`:
- `TurnContext`에 `message` 아래 더한다:
  ```typescript
  /** 이번 대화. 만든 파일을 대화에 묶는다(설계 3.4). prepareTurn이 도구 루프 전에 정한다 */
  conversationId: string;
  ```
- `ToolOutcome`에 `usage` 아래 더한다:
  ```typescript
  /** 도구가 만든 파일 — 화면 내려받기 카드와 메시지 저장으로 간다 */
  files?: GeneratedFileRef[];
  ```

`src/lib/assistant/prepare.ts` — `const ctx: TurnContext = { ... }`에 `conversationId,`를 `message,` 뒤에 더한다(같은 함수 위쪽에서 `conversationId`가 이미 정해져 있다).

`src/lib/assistant/types.ts`:
- import에 `GeneratedFileRef`를 더한다: `import type { Capability, TurnContext, GeneratedFileRef } from '@/lib/capabilities/types';`
- `tool_end` 줄을 바꾼다:
  ```typescript
  | { event: 'tool_end'; data: { name: string; ok: boolean; sources: ToolSource[]; files: GeneratedFileRef[] } }
  ```
- `TurnEvent` 위 주석을 "이름과 기존 페이로드는 S1 이전과 같다. S2-a에서 tool_end에 files만 더했다 — ChatInterface가 읽는다"로 고친다

`src/lib/assistant/persist.ts`:
- import에 `import type { GeneratedFileRef } from '@/lib/capabilities/types';`
- `MessageRowInput`에 `files: GeneratedFileRef[];`
- 답변 행 `source_references`에 `links` 아래 `files: input.files,`

`src/lib/assistant/stream.ts`:
- import에 `GeneratedFileRef`: `import type { Capability, TurnContext, ToolOutcome, GeneratedFileRef } from '@/lib/capabilities/types';`
- `LoopResult`에 `files: GeneratedFileRef[];`
- `runToolLoop`에서 `const links: ToolSource[] = [];` 아래에 `const files: GeneratedFileRef[] = [];`
- 도구 실행 블록을 바꾼다:
  ```typescript
      const callLinks = outcome.sources?.links ?? [];
      const callFiles = outcome.files ?? [];
      links.push(...callLinks);
      files.push(...callFiles);
      if (outcome.usage) capabilityUsage.push(...outcome.usage);
      send({ event: 'tool_end', data: { name: call.name, ok: outcome.ok, sources: callLinks, files: callFiles } });
  ```
- 마지막 `return`을 `return { text, usage, capabilityUsage, links: dedupeLinks(links), files };`로
- `streamTurn`의 `buildMessageRows({...})`에 `files: result.files,`를 `links: result.links,` 아래 더한다

```typescript
// src/lib/file-size.ts
/** 화면용 크기 표시. 클라이언트에서 쓰므로 서버 모듈을 import하지 않는다 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
```

`src/components/chat/MessageBubble.tsx`:
- import에 `import { formatFileSize } from '@/lib/file-size';`
- `ToolLink` 아래에:
  ```typescript
  interface GeneratedFile {
    id: string;
    file_name: string;
    size_bytes: number;
  }
  ```
- `MessageBubbleProps`에 `/** 비서가 만든 파일 — 내려받기 카드 */ files?: GeneratedFile[];`, 구조 분해에 `files`
- 외부 도구 출처 블록(`{links && links.length > 0 && (`) 바로 앞에:
  ```tsx
        {/* 비서가 만든 파일 — 주인만 내려받는다(/api/files가 확인) */}
        {files && files.length > 0 && (
          <div className="mt-2 w-full space-y-1.5">
            {files.map((file) => (
              <a
                key={file.id}
                href={`/api/files/${file.id}`}
                className="flex items-center gap-3 bg-white border border-slate-200 rounded-xl p-3 hover:bg-slate-50 transition-colors"
              >
                <span className="w-9 h-9 rounded-lg bg-[#003087]/10 text-[#003087] text-[11px] font-bold flex items-center justify-center flex-shrink-0">
                  HWP
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-medium text-slate-800 truncate">{file.file_name}</span>
                  <span className="block text-[11px] text-slate-400">{formatFileSize(file.size_bytes)} · 내려받기</span>
                </span>
              </a>
            ))}
          </div>
        )}
  ```

`src/components/chat/ChatInterface.tsx`:
- `Message`에 `/** 비서가 만든 파일 */ files?: { id: string; file_name: string; size_bytes: number }[];`
- `TOOL_LABELS`에 더한다:
  ```typescript
  list_templates: '쓸 수 있는 양식을 찾는 중',
  read_template: '양식의 항목을 읽는 중',
  fill_template: '한글 파일을 만드는 중',
  ```
- 대화 다시 열기의 `source_references?:` 형에 `files?: { id: string; file_name: string; size_bytes: number }[]`를 더하고 매핑에 `files: m.source_references?.files,`
- 스트림 처리: `collectedLinks`를 선언한 곳 옆에 `const collectedFiles: { id: string; file_name: string; size_bytes: number }[] = [];`
- `showBubble`의 새 메시지에 `files: collectedFiles.length ? [...collectedFiles] : undefined,`
- `tool_end` 처리에서 링크 처리 뒤에:
  ```typescript
            for (const file of payload.files ?? []) {
              if (!collectedFiles.some((f) => f.id === file.id)) collectedFiles.push(file);
            }
            if (bubbleShown && collectedFiles.length) {
              patchAssistant({ files: [...collectedFiles] });
            }
  ```
  (도구가 먼저 끝나고 글이 나중에 오면 `showBubble`이 `collectedFiles`를 싣는다)
- `<MessageBubble …>`에 `files={msg.files}`

테스트 고정값: `grep -rln "agentVersion:" tests`로 `TurnContext`를 직접 만드는 곳을 찾아 모두 `conversationId`를 더한다.

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 전부 PASS, tsc 오류 0건

- [ ] **Step 5: Commit**

```bash
git add src/lib/capabilities/types.ts src/lib/assistant src/lib/file-size.ts src/components/chat tests
git commit -m "feat: 도구가 만든 파일을 tool_end·메시지 저장·대화 화면까지 전달

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: '문서 만들기' 능력

**Files:**
- Create: `src/lib/capabilities/document.ts`, `tests/document-capability.test.ts`
- Modify: `src/lib/capabilities/settings.ts`, `src/lib/capabilities/index.ts`
- Modify: `src/lib/agent-form.ts`, `tests/agent-form.test.ts`, `src/components/agents/AgentEditorModal.tsx`
- Modify: `src/app/api/admin/audit-logs/route.ts`, `src/app/api/admin/usage-summary/route.ts`, `src/components/admin/StatsDashboard.tsx`, `scripts/db-check.mjs`

**Interfaces:**
- Consumes: Task 2 `readTemplate`·`fillTemplate`·`findBuiltinTemplate`·`BUILTIN_TEMPLATES`·`loadBuiltinTemplate`; Task 3 `saveGeneratedFile`·`safeFileName`·`SaveGeneratedFileInput`; Task 5 `TurnContext.conversationId`·`ToolOutcome.files`; `writeUsageLog`(`@/lib/assistant/persist`)
- Produces:
  ```typescript
  export interface AgentTemplateRow { id: string; name: string; file_name: string; storage_path: string }
  export interface DocumentDeps {
    listAgentTemplates(agentId: string): Promise<AgentTemplateRow[]>;
    downloadAgentTemplate(storagePath: string): Promise<Buffer>;
    loadBuiltin(t: BuiltinTemplate): Promise<Buffer | null>;
    saveFile(input: SaveGeneratedFileInput): Promise<GeneratedFileRef>;
    logGenerated(row: { departmentId: string; userId: string; conversationId: string; details: Record<string, unknown> }): Promise<void>;
  }
  export const DOCUMENT_ADDENDUM: string;
  export function createDocument(deps: DocumentDeps): Capability;
  export const documentCapability: Capability;
  ```
  능력 id `'document'`, 도구 `list_templates` · `read_template` · `fill_template`. 사용 기록 `action='document_generated'`.

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
// tests/document-capability.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createDocument, DOCUMENT_ADDENDUM, type DocumentDeps } from '@/lib/capabilities/document';
import type { TurnContext } from '@/lib/capabilities/types';
import { buildHwpx, para } from './fixtures/hwpx';

const ctx: TurnContext = {
  organizationId: 'org', departmentId: 'dept', userId: 'u1', agentId: 'agent-1', agentVersion: 3,
  capabilities: { document: {} }, message: '회의록 만들어줘', conversationId: 'conv-1',
};

async function deps(over: Partial<DocumentDeps> = {}) {
  const template = await buildHwpx(para('{{회의명}}') + para('{{논의 내용}}'));
  const d: DocumentDeps = {
    listAgentTemplates: vi.fn(async () => [{ id: 'tpl-1', name: '우리 회의록', file_name: '회의록.hwpx', storage_path: 'templates/x.hwpx' }]),
    downloadAgentTemplate: vi.fn(async () => template),
    loadBuiltin: vi.fn(async () => template),
    saveFile: vi.fn(async (input) => ({ id: 'file-1', file_name: input.fileName, size_bytes: input.bytes.length })),
    logGenerated: vi.fn(async () => {}),
    ...over,
  };
  return d;
}

const run = async (d: DocumentDeps, tool: string, input: Record<string, unknown>) =>
  createDocument(d).execute!(tool, input, ctx);

describe('문서 만들기 — 목록·읽기', () => {
  it('기본 양식과 이 비서의 양식을 함께 보여 준다', async () => {
    const d = await deps();
    const out = await run(d, 'list_templates', {});
    expect(out.ok).toBe(true);
    const list = JSON.parse(out.text) as { ref: string; kind: string; format: string }[];
    expect(list.map((t) => t.ref)).toEqual(['builtin:official_letter', 'builtin:report', 'builtin:minutes', 'tpl-1']);
    expect(list.find((t) => t.ref === 'tpl-1')).toMatchObject({ kind: 'agent', format: 'hwpx' });
    expect(d.listAgentTemplates).toHaveBeenCalledWith('agent-1');
  });

  it('양식의 자리를 읽어 준다', async () => {
    const out = await run(await deps(), 'read_template', { ref: 'tpl-1' });
    expect(JSON.parse(out.text)).toMatchObject({ ref: 'tpl-1', name: '우리 회의록', slots: [{ id: 's1', label: '회의명' }, { id: 's2', label: '논의 내용' }] });
  });

  it('이 비서의 양식이 아닌 ref는 거절한다 — 다른 비서·기관의 양식 id', async () => {
    const out = await run(await deps(), 'read_template', { ref: 'someone-elses-template' });
    expect(out).toEqual({ ok: false, text: expect.stringContaining('쓸 수 없는 양식') });
  });

  it('기본 양식 파일이 아직 없으면 그렇게 알린다', async () => {
    const out = await run(await deps({ loadBuiltin: vi.fn(async () => null) }), 'read_template', { ref: 'builtin:minutes' });
    expect(out).toEqual({ ok: false, text: expect.stringContaining('준비되지 않았습니다') });
  });

  it('읽을 수 없는 양식은 이유를 돌려준다', async () => {
    const d = await deps({ downloadAgentTemplate: vi.fn(async () => Buffer.from('not zip')) });
    const out = await run(d, 'read_template', { ref: 'tpl-1' });
    expect(out.ok).toBe(false);
  });
});

describe('문서 만들기 — 채우기', () => {
  it('파일을 만들어 기록하고 링크를 싣는다 — 기관·대화 값은 서버 문맥에서', async () => {
    const d = await deps();
    const out = await run(d, 'fill_template', {
      ref: 'builtin:minutes', title: '10월 주간 회의', values: [{ slot_id: 's1', text: '주간 회의' }],
      organization_id: 'attacker-org', conversation_id: 'other',
    });
    expect(out.ok).toBe(true);
    expect(out.files).toEqual([{ id: 'file-1', file_name: '10월 주간 회의.hwpx', size_bytes: expect.any(Number) }]);
    const saved = (d.saveFile as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(saved).toMatchObject({
      organizationId: 'org', departmentId: 'dept', userId: 'u1', agentId: 'agent-1', conversationId: 'conv-1',
      templateRef: 'builtin:minutes', extension: 'hwpx', mimeType: 'application/hwp+zip',
    });
    expect(d.logGenerated).toHaveBeenCalledWith(expect.objectContaining({
      departmentId: 'dept', userId: 'u1', conversationId: 'conv-1',
      details: expect.objectContaining({ agent_id: 'agent-1', template_ref: 'builtin:minutes', file_name: '10월 주간 회의.hwpx' }),
    }));
    // 안 채운 자리를 AI에게 알려 사용자에게 말하게 한다
    expect(out.text).toContain('논의 내용');
  });

  it('저장이 실패하면 이유와 함께 초안이 남아 있다고 알린다', async () => {
    const d = await deps({ saveFile: vi.fn(async () => { throw new Error('저장소 가득'); }) });
    const out = await run(d, 'fill_template', { ref: 'builtin:minutes', title: '회의', values: [{ slot_id: 's1', text: 'x' }] });
    expect(out.ok).toBe(false);
    expect(out.text).toContain('초안');
    expect(out.text).toContain('저장소 가득');
    expect(d.logGenerated).not.toHaveBeenCalled();
  });

  it('입력 꼴이 틀리면 거절한다', async () => {
    const d = await deps();
    expect((await run(d, 'fill_template', { ref: 'builtin:minutes', title: '회의', values: 'x' })).ok).toBe(false);
    expect((await run(d, 'fill_template', { ref: 'builtin:minutes', title: '회의', values: [{ slot_id: 1, text: 'x' }] })).ok).toBe(false);
    expect((await run(d, 'read_template', {})).ok).toBe(false);
  });

  it('없는 자리 번호는 엔진의 이유를 그대로 돌려준다', async () => {
    const out = await run(await deps(), 'fill_template', { ref: 'tpl-1', title: '회의', values: [{ slot_id: 's9', text: 'x' }] });
    expect(out).toEqual({ ok: false, text: expect.stringContaining('s9') });
  });
});

describe('문서 만들기 — 흐름 안내', () => {
  it('목차 확인과 지어내지 않기를 프롬프트에 붙인다', async () => {
    const result = await createDocument(await deps()).prepare!(ctx);
    expect(result.systemAddendum).toBe(DOCUMENT_ADDENDUM);
    expect(DOCUMENT_ADDENDUM).toContain('목차');
    expect(DOCUMENT_ADDENDUM).toContain('지어내지');
  });
});
```

`tests/agent-form.test.ts` — '비서에서 편집 값을 만든다'의 기대 객체에 `document: false`를 더하고, 테스트를 더한다:
```typescript
  it('문서 만들기를 능력으로 보낸다', () => {
    const body = settingsToBody({ ...settingsFromAgent(agent as never), document: true }, { isLink: false });
    expect(body.capabilities).toEqual({ image: {}, document: {}, public_data: { connectors: ['law'] } });
  });
```
기존 `settingsToBody`의 `capabilities` 기대값은 순서가 `doc_search → image → document → public_data`가 되게 맞춘다(`toEqual`은 키 순서를 보지 않으므로 값만 맞으면 된다).

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/document-capability.test.ts tests/agent-form.test.ts tests/capabilities.test.ts`
Expected: FAIL — `@/lib/capabilities/document` 없음, `document` 칸 없음

- [ ] **Step 3: 구현**

`src/lib/capabilities/settings.ts`:
- `export const CAPABILITY_IDS = ['doc_search', 'public_data', 'image', 'document'] as const;`
- `CapabilitySettings`에 `document?: Record<string, never>;`
- `normalizeCapabilities`의 else 분기: `value[id as 'doc_search' | 'image' | 'document'] = {};`
- `scripts/db-check.mjs`의 `KNOWN_CAPS`(약 225행)에 `'document'`를 더한다 — 빠지면 '모르는 능력 id'로 경고한다

```typescript
// src/lib/capabilities/document.ts
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { SUPABASE_DOCUMENTS_BUCKET } from '@/lib/config';
import { readTemplate, fillTemplate } from '@/lib/doc-fill';
import { BUILTIN_TEMPLATES, findBuiltinTemplate, loadBuiltinTemplate, type BuiltinTemplate } from '@/lib/builtin-templates';
import { saveGeneratedFile, safeFileName, type SaveGeneratedFileInput } from '@/lib/generated-files';
import { writeUsageLog } from '@/lib/assistant/persist';
import type { Capability, GeneratedFileRef, ToolOutcome, TurnContext } from './types';

/**
 * 문서 만들기 — 양식을 채우거나 표준 서식(기본 양식)으로 한글 파일을 만든다(설계 3절).
 *
 * 도구 입력에는 기관·대화·비서 id가 없다. 양식은 이 비서의 것과 기본 양식만,
 * 파일은 서버 문맥(ctx)의 대화·사용자에 묶는다. 입력에 다른 값이 와도 쓰지 않는다.
 */

export interface AgentTemplateRow {
  id: string;
  name: string;
  file_name: string;
  storage_path: string;
}

export interface DocumentDeps {
  listAgentTemplates(agentId: string): Promise<AgentTemplateRow[]>;
  downloadAgentTemplate(storagePath: string): Promise<Buffer>;
  loadBuiltin(t: BuiltinTemplate): Promise<Buffer | null>;
  saveFile(input: SaveGeneratedFileInput): Promise<GeneratedFileRef>;
  logGenerated(row: { departmentId: string; userId: string; conversationId: string; details: Record<string, unknown> }): Promise<void>;
}

export const DOCUMENT_ADDENDUM = `[문서 만들기]
이 비서는 양식을 채우거나 표준 서식으로 한글(HWPX) 파일을 만들 수 있습니다.
1. 공문·보고서·회의록 같은 문서를 만들어 달라고 하면 list_templates로 쓸 양식을 고릅니다. 사용자가 양식을 말하지 않았고 후보가 여럿이면 어느 양식으로 할지 묻습니다.
2. read_template으로 채울 항목을 읽어 목차로 보여 주고 이대로 쓸지 확인을 받습니다. 확인 전에는 파일을 만들지 않습니다.
3. 확인되면 항목별 초안을 대화에 쓰고 끝에 "이대로 한글 파일로 만들까요?"라고 묻습니다.
4. 만들어 달라고 하면 대화에 쓴 초안 그대로 fill_template을 부릅니다. 고쳐 달라는 말이 있었으면 고친 내용으로 부릅니다. 사용자가 처음부터 바로 파일로 달라고 했으면 3의 질문 없이 만들고, 대화에는 짧은 요약만 씁니다.
5. 일시·장소·참석자·문서번호·수신처처럼 받은 자료에 없는 사실은 지어내지 않습니다. 묻거나 빈칸으로 두고, 빈칸으로 둔 항목을 알려 줍니다.
6. 도구가 실패하면 그 이유를 그대로 알리고, 대화에 쓴 초안은 복사해 쓸 수 있다고 덧붙입니다.`;

const NOT_ALLOWED = '이 비서에서 쓸 수 없는 양식입니다. list_templates로 쓸 수 있는 양식을 다시 확인해 주세요.';

interface Resolved {
  ref: string;
  name: string;
  fileName: string;
  load(): Promise<Buffer | null>;
}

function formatOf(fileName: string): string {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  return ['hwpx', 'docx', 'hwp'].includes(ext) ? ext : 'unknown';
}

function readRef(input: Record<string, unknown>): string | null {
  return typeof input.ref === 'string' && input.ref.trim() ? input.ref.trim() : null;
}

function readValues(input: Record<string, unknown>): { slot_id: string; text: string }[] | null {
  if (!Array.isArray(input.values)) return null;
  const out: { slot_id: string; text: string }[] = [];
  for (const v of input.values) {
    if (!v || typeof v !== 'object') return null;
    const { slot_id, text } = v as Record<string, unknown>;
    if (typeof slot_id !== 'string' || typeof text !== 'string') return null;
    out.push({ slot_id, text });
  }
  return out;
}

export function createDocument(deps: DocumentDeps): Capability {
  async function resolve(ref: string, ctx: TurnContext): Promise<Resolved | null> {
    const builtin = findBuiltinTemplate(ref);
    if (builtin) return { ref, name: builtin.name, fileName: builtin.file, load: () => deps.loadBuiltin(builtin) };
    const row = (await deps.listAgentTemplates(ctx.agentId)).find((r) => r.id === ref);
    if (!row) return null;
    return { ref, name: row.name, fileName: row.file_name, load: () => deps.downloadAgentTemplate(row.storage_path) };
  }

  async function loadOrFail(ref: string | null, ctx: TurnContext): Promise<{ t: Resolved; bytes: Buffer } | ToolOutcome> {
    if (!ref) return { ok: false, text: 'ref가 필요합니다. list_templates가 돌려준 ref를 넣어 주세요.' };
    const t = await resolve(ref, ctx);
    if (!t) return { ok: false, text: NOT_ALLOWED };
    const bytes = await t.load();
    if (!bytes) return { ok: false, text: `기본 양식(${t.name}) 파일이 아직 준비되지 않았습니다. 관리자에게 알려 주세요.` };
    return { t, bytes };
  }

  return {
    id: 'document',
    label: '문서 만들기',
    description: '양식을 채우거나 표준 서식으로 한글 파일을 만듭니다.',
    isAvailable: () => true,

    async prepare() {
      return { systemAddendum: DOCUMENT_ADDENDUM };
    },

    tools() {
      return [
        {
          name: 'list_templates',
          description: '이 비서가 쓸 수 있는 양식 목록(기관이 올린 양식 + 표준 서식). 문서를 만들기 전에 먼저 부른다.',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'read_template',
          description: '양식 하나의 채울 항목(목차)을 읽는다. 사용자에게 목차를 보여 주고 확인받을 때 쓴다.',
          inputSchema: {
            type: 'object',
            properties: { ref: { type: 'string', description: 'list_templates가 돌려준 ref' } },
            required: ['ref'],
          },
        },
        {
          name: 'fill_template',
          description: '확인받은 초안을 양식에 채워 한글 파일을 만든다. 대화에 내려받기 링크가 붙는다.',
          inputSchema: {
            type: 'object',
            properties: {
              ref: { type: 'string', description: 'list_templates가 돌려준 ref' },
              title: { type: 'string', description: '파일 이름으로 쓸 문서 제목' },
              values: {
                type: 'array',
                description: 'read_template이 돌려준 자리 번호별 글',
                items: {
                  type: 'object',
                  properties: {
                    slot_id: { type: 'string' },
                    text: { type: 'string', description: '넣을 글. 줄바꿈 하나가 문단 하나' },
                  },
                  required: ['slot_id', 'text'],
                },
              },
            },
            required: ['ref', 'title', 'values'],
          },
        },
      ];
    },

    async execute(tool, input, ctx): Promise<ToolOutcome> {
      if (tool === 'list_templates') {
        const agentTemplates = await deps.listAgentTemplates(ctx.agentId);
        const list = [
          ...BUILTIN_TEMPLATES.map((t) => ({ ref: t.ref, name: t.name, kind: 'builtin', format: 'hwpx' })),
          ...agentTemplates.map((t) => ({ ref: t.id, name: t.name, kind: 'agent', format: formatOf(t.file_name) })),
        ];
        return { ok: true, text: JSON.stringify(list) };
      }

      if (tool === 'read_template') {
        const loaded = await loadOrFail(readRef(input), ctx);
        if ('ok' in loaded) return loaded;
        const read = await readTemplate(loaded.bytes, loaded.t.fileName);
        if (!read.ok) return { ok: false, text: read.reason };
        return { ok: true, text: JSON.stringify({ ref: loaded.t.ref, name: loaded.t.name, slots: read.slots }) };
      }

      if (tool === 'fill_template') {
        const values = readValues(input);
        if (!values) return { ok: false, text: 'values는 [{ slot_id, text }] 목록이어야 합니다.' };
        const loaded = await loadOrFail(readRef(input), ctx);
        if ('ok' in loaded) return loaded;

        const filled = await fillTemplate(loaded.bytes, loaded.t.fileName, values);
        if (!filled.ok) return { ok: false, text: filled.reason };

        const title = typeof input.title === 'string' && input.title.trim() ? input.title : loaded.t.name;
        const fileName = safeFileName(title, filled.extension);

        let saved: GeneratedFileRef;
        try {
          saved = await deps.saveFile({
            organizationId: ctx.organizationId,
            departmentId: ctx.departmentId,
            userId: ctx.userId,
            agentId: ctx.agentId,
            conversationId: ctx.conversationId,
            templateRef: loaded.t.ref,
            templateName: loaded.t.name,
            fileName,
            extension: filled.extension,
            mimeType: filled.mimeType,
            bytes: filled.bytes,
          });
        } catch (error) {
          // 파일이 실패해도 초안 글은 대화에 남는다(서비스 정의서 7.5)
          return {
            ok: false,
            text: `파일을 저장하지 못했습니다. 대화에 쓴 초안은 그대로 있으니 복사해 쓸 수 있다고 알려 주세요. (이유: ${error instanceof Error ? error.message : '알 수 없는 오류'})`,
          };
        }

        await deps.logGenerated({
          departmentId: ctx.departmentId,
          userId: ctx.userId,
          conversationId: ctx.conversationId,
          details: {
            agent_id: ctx.agentId,
            template_ref: loaded.t.ref,
            template_name: loaded.t.name,
            file_name: saved.file_name,
            size_bytes: saved.size_bytes,
            filled: filled.filled.length,
            unfilled: filled.unfilled.length,
          },
        });

        const unfilledNote = filled.unfilled.length
          ? ` 채우지 않은 항목 ${filled.unfilled.length}개: ${filled.unfilled.join(', ')} — 사용자에게 알려 주세요.`
          : '';
        return {
          ok: true,
          text: `한글 파일을 만들었습니다: ${saved.file_name} (채운 항목 ${filled.filled.length}개).${unfilledNote} 대화 아래에 내려받기 링크가 붙습니다.`,
          files: [saved],
        };
      }

      return { ok: false, text: `알 수 없는 도구입니다: ${tool}` };
    },
  };
}

const defaultDeps: DocumentDeps = {
  async listAgentTemplates(agentId) {
    const { data, error } = await supabaseAdmin
      .from('agent_templates')
      .select('id, name, file_name, storage_path')
      .eq('agent_id', agentId)
      .is('retired_at', null)
      .order('created_at', { ascending: true });
    if (error) throw new Error(`양식 목록을 읽지 못했습니다: ${error.message}`);
    return (data ?? []) as AgentTemplateRow[];
  },
  async downloadAgentTemplate(storagePath) {
    const { data, error } = await supabaseAdmin.storage.from(SUPABASE_DOCUMENTS_BUCKET).download(storagePath);
    if (error || !data) throw new Error(`양식 파일을 받지 못했습니다: ${error?.message ?? '빈 응답'}`);
    return Buffer.from(await data.arrayBuffer());
  },
  loadBuiltin: (t) => loadBuiltinTemplate(t),
  saveFile: saveGeneratedFile,
  async logGenerated(row) {
    // 토큰을 쓰지 않는 기록이다 — 과금 규약(TOKEN_ACTIONS) 대상이 아니다(설계 5.5)
    await writeUsageLog({
      departmentId: row.departmentId,
      userId: row.userId,
      action: 'document_generated',
      resourceType: 'conversation',
      resourceId: row.conversationId,
      details: row.details,
    });
  },
};

// 전역 document(DOM)와 헷갈리지 않게 이름을 길게 둔다
export const documentCapability = createDocument(defaultDeps);
```

`src/lib/capabilities/index.ts`:
- `import { documentCapability } from './document';`
- `export const CAPABILITIES: Capability[] = [docSearch, publicData, image, documentCapability];`

`src/lib/agent-form.ts`:
- `AgentSettingsValue`에 `image: boolean;` 아래 `document: boolean;`
- `settingsFromAgent`의 반환에 `image: 'image' in caps,` 아래 `document: 'document' in caps,`
- `settingsToBody`의 `capabilities`에 `image` 줄 아래 `...(value.document ? { document: {} } : {}),`

`src/components/agents/AgentEditorModal.tsx` — 능력 체크박스 목록(`['doc_search', '참고 문서 찾기', …]`, `['image', '사진 읽기', …]`) 끝에 더한다:
```typescript
                        ['document', '문서 만들기', '양식을 채우거나 표준 서식으로 한글 파일을 만듭니다'],
```

활동 이름표 — `src/app/api/admin/audit-logs/route.ts`, `src/app/api/admin/usage-summary/route.ts`, `src/components/admin/StatsDashboard.tsx`의 `conversation_title: '대화 제목 생성',` 줄 아래에 각각:
```typescript
  document_generated: '문서 파일 생성',
```
(파일마다 들여쓰기를 그 줄에 맞춘다)

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 전부 PASS(`capabilities.test.ts`의 'id가 설정 목록과 같다'·'격리에 걸리는 값' 포함), tsc 오류 0건

- [ ] **Step 5: Commit**

```bash
git add src/lib/capabilities src/lib/agent-form.ts src/components/agents/AgentEditorModal.tsx src/app/api/admin/audit-logs/route.ts src/app/api/admin/usage-summary/route.ts src/components/admin/StatsDashboard.tsx scripts/db-check.mjs tests
git commit -m "feat: '문서 만들기' 능력 — 양식 목록·읽기·채우기와 흐름 안내

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 문서 · 검증

**Files:**
- Modify: `CLAUDE.md`, `docs/superpowers/specs/2026-10-14-workon-service-definition-design.md`

- [ ] **Step 1: 전체 검증**

Run: `npx vitest run && npx tsc --noEmit && npm run build`
Expected: 전부 PASS, 빌드 성공(빌드 전 `.next`가 낡았으면 지운다)

- [ ] **Step 2: `CLAUDE.md` 갱신** — 각 사실을 코드로 확인하고 쓴다

- 마이그레이션 표에 `| 0029 | 생성 파일(\`generated_files\`) — 비서가 만든 파일 기록 · 기관 채움 트리거. **코드 배포 전에 적용** |`
- 검증 장치 표에 `| \`npm run hwpx:probe -- 입력.hwpx 출력.hwpx\` | 한글 호환 확인 — 출력 파일을 한글에서 연다 | 아니오 |`, `npm test` 줄의 시험 수를 `npx vitest run`이 출력한 수로
- API 구조 표의 직원 그룹에 `/api/files/[id]` (내 파일 내려받기)
- 디렉토리 구조의 `lib/` 아래에 `doc-fill/  # 양식 채우기 엔진(HWPX)`, `generated-files.ts  # 생성 파일 보관`, `builtin-templates.ts  # 기본 양식`; 루트에 `assets/templates/  # 기본 양식 HWPX(사용자가 한글로 만든다)`
- 새 절 `### 문서 만들기 (S2-a)`를 '채팅 시' 절 뒤에:
  ```markdown
  ### 문서 만들기 (S2-a)

  능력 `document`를 켜면 비서가 `list_templates` · `read_template` · `fill_template`을 쓴다.
  흐름(양식 → 목차 확인 → 초안 → 파일)과 "모르는 사실은 지어내지 않는다"는 능력이 시스템 프롬프트에 붙인다.

  - **엔진(`src/lib/doc-fill/`)은 DB·저장소를 모른다.** 바이트를 받아 바이트를 돌려준다. HWPX의 본문 XML만
    문자열 단위로 고치고 나머지(서식 정의·그림)는 그대로 둔다. 파서로 읽어 다시 쓰면 한글이 까다롭게 군다
  - **S2-a는 `{{이름}}` 표시만 채운다.** DOCX·옛 HWP·표시 없는 양식은 이유와 함께 실패한다(S2-b에서 대체 경로)
  - 표준 서식 = `assets/templates/`의 기본 양식 3종. **한글로 만든 진짜 HWPX**라야 한다(README)
  - 만든 파일은 `generated_files` + 저장소 `generated/{기관}/{대화}/{id}.hwpx`. **주인만** `/api/files/[id]`로 받는다
    (60초 서명 주소 — Vercel 함수 응답 4.5MB 상한 때문에 직접 보내지 않는다). 관리자도 못 받는다
  - 대화를 지우면 파일도 지운다(`deleteConversationFiles` — DB 연쇄 삭제는 저장소를 안 지운다)
  - 파일 링크는 `ToolOutcome.files` → SSE `tool_end.files` → `source_references.files`
  - 생성 기록은 `usage_logs.action='document_generated'`(토큰 없음 — 과금 규약 대상 아님)
  ```
- SSE 표의 `tool_end` 페이로드를 `{ name, ok, sources, files }`로

- [ ] **Step 3: 서비스 정의서 6절** — 데이터 흐름 표 아래 문단에 한 줄 더한다:
  ```markdown
  양식 채우기는 양식의 **항목 이름·자리 표시 글자(목차)**만 Claude로 보낸다. 양식 파일 전체와 만든 파일은 나가지 않는다.
  ```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-10-14-workon-service-definition-design.md
git commit -m "docs: S2-a 문서 만들기 반영

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: 확인 지점 B 요청** — 사용자에게:
  1. 기본 양식 3종을 `assets/templates/`에 두고(README) `npx vitest run tests/builtin-templates.test.ts`로 표시 확인 → 커밋
  2. `npm run db:migrate -- 0029` (코드 배포 **전**)
  3. 푸시·배포 → `npm run db:check` · `npm run isolation:check`
  4. 비서 하나의 [설정]에서 '문서 만들기'를 켜고 "회의록 만들어줘" → 목차 확인 → 초안 → 파일 → 한글에서 열기
