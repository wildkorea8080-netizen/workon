import { describe, it, expect } from 'vitest';
import { readSegments, type Segment } from '@/lib/work/workflows/currentize/segments';
import { buildPlan, type Change } from '@/lib/work/workflows/currentize/plan';
import { applyChanges } from '@/lib/work/workflows/currentize/apply';
import type { CitationPair } from '@/lib/work/workflows/currentize/citations';
import type { ShiftedCell } from '@/lib/work/workflows/currentize/tables';
import { checkPackage } from '@/lib/work/documents/package-check';
import { buildHwpx, para, tableAt, secPrPara, sectionXml } from './fixtures/hwpx';
import { priorFixture } from './helpers/prior-fixture';

const MAIN = '2025년 예산은 1,200백만원이다.';

async function prior(): Promise<Buffer> {
  return priorFixture({ 제목: '2025년 ○○ 사업계획', 개요: '개요 글이다.', '주요 내용': MAIN, '향후 계획': '하반기에 점검한다.' });
}

function change(over: Partial<Change> & { segmentId: string; before: string }): Change {
  return { id: 'c1', kind: 'prose', after: null, status: 'changed', basis: [], note: null, ...over };
}

const texts = (s: Segment[]) => s.map((x) => x.text);

/** 시험용 뼈대 HWPX(buildHwpx)에는 매니페스트가 없다 — 그 둘을 뺀 문제(XML 형식·값 누락)만 본다 */
async function bareProblems(bytes: Buffer, values: string[] = []): Promise<string[]> {
  const check = await checkPackage(bytes, { format: 'hwpx', values });
  return check.problems.filter((p) => p !== 'Contents/content.hpf 없음' && p !== 'META-INF/container.xml 없음');
}

const P_OPEN = '<hp:p id="1" paraPrIDRef="3" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">';
const LS = '<hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="42520" flags="393216"/></hp:linesegarray>';
/** 글 안에 탭 같은 태그가 든 문단(t는 <hp:t> 안의 XML 그대로) */
const rawPara = (t: string) => `${P_OPEN}<hp:run charPrIDRef="0"><hp:t>${t}</hp:t></hp:run>${LS}</hp:p>`;

/** 문단 하나짜리 파일에 변경 하나를 적용하고 섹션 XML을 돌려준다 */
async function applyOne(body: string, after: string): Promise<string> {
  const bytes = await buildHwpx(secPrPara() + body);
  const [a] = (await readSegments(bytes)).segments;
  const out = await applyChanges(bytes, [change({ segmentId: a.id, before: a.text, after })]);
  // 값 확인은 조각 다시 읽기로 — checkPackage의 글 찾기는 <hp:t> 안에 탭 태그가 든 글을 잇지 못한다
  expect(await bareProblems(out)).toEqual([]);
  expect((await readSegments(out)).segments.map((x) => x.text)).toEqual([after]);
  return sectionXml(out);
}

describe('applyChanges — 작년 HWPX에 변경 적용', () => {
  it('changed 하나를 적용하면 그 조각만 바뀌고 나머지 조각 글·앞쪽 id는 그대로다', async () => {
    const bytes = await prior();
    const before = (await readSegments(bytes)).segments;
    const idx = before.findIndex((s) => s.text === MAIN);
    expect(idx).toBeGreaterThan(0);
    const target = before[idx];
    const after = '2026년 예산은 1,500백만원이다.';

    const out = await applyChanges(bytes, [change({ segmentId: target.id, before: MAIN, after })]);
    const again = (await readSegments(out)).segments;

    expect(texts(again)).toEqual(texts(before).map((t, i) => (i === idx ? after : t)));
    // 바뀐 문단과 그 앞 문단은 시작 위치가 그대로라 id가 같다(뒤 문단은 글 길이만큼 밀린다)
    expect(again.slice(0, idx + 1).map((s) => s.id)).toEqual(before.slice(0, idx + 1).map((s) => s.id));
    expect(again[idx]).toMatchObject({ path: target.path, nested: target.nested, cell: target.cell });
    expect(again.map((s) => [s.path, s.nested, s.cell])).toEqual(before.map((s) => [s.path, s.nested, s.cell]));

    const check = await checkPackage(out, { format: 'hwpx', values: [after] });
    expect(check.problems).toEqual([]);
    expect(check.missingValues).toEqual([]);
    expect(check.valid).toBe(true);
  });

  it('needs_check·proposed·after 없는 changed는 바이트에 영향이 없다', async () => {
    const bytes = await prior();
    const before = (await readSegments(bytes)).segments;
    const target = before.find((s) => s.text === MAIN)!;
    const out = await applyChanges(bytes, [
      change({ id: 'c1', segmentId: target.id, before: MAIN, status: 'needs_check', kind: 'number' }),
      change({ id: 'c2', segmentId: target.id, before: MAIN, status: 'proposed', after: '고친 제안' }),
      change({ id: 'c3', segmentId: target.id, before: MAIN, status: 'changed', after: null }),
      // 적용하지 않는 변경은 id가 틀려도 상관없다
      change({ id: 'c4', segmentId: '0:999999', before: '없음', status: 'needs_check' }),
    ]);
    expect((await readSegments(out)).segments).toEqual(before);
  });

  it('여러 줄이면 둘째 줄부터 바로 뒤에 새 문단으로 잇는다', async () => {
    const bytes = await prior();
    const before = (await readSegments(bytes)).segments;
    const idx = before.findIndex((s) => s.text === MAIN);
    const out = await applyChanges(bytes, [change({ segmentId: before[idx].id, before: MAIN, after: '첫 줄\n둘째 줄\r\n셋째 줄' })]);
    const again = (await readSegments(out)).segments;
    expect(texts(again)).toEqual([...texts(before).slice(0, idx), '첫 줄', '둘째 줄', '셋째 줄', ...texts(before).slice(idx + 1)]);
    expect(again[idx + 1].path).toEqual(before[idx].path);
    const check = await checkPackage(out, { format: 'hwpx', values: ['첫 줄', '둘째 줄', '셋째 줄'] });
    expect(check.valid).toBe(true);
  });

  it('여러 조각(run)으로 나뉜 문단도 첫 조각에 넣고 나머지는 비운다', async () => {
    const bytes = await buildHwpx(secPrPara() + para(['2025년 ', '예산은 ', '100이다.']) + para('뒤'));
    const before = (await readSegments(bytes)).segments;
    const out = await applyChanges(bytes, [change({ segmentId: before[0].id, before: '2025년 예산은 100이다.', after: '2026년 예산은 200이다.' })]);
    expect(texts((await readSegments(out)).segments)).toEqual(['2026년 예산은 200이다.', '뒤']);
    const xml = await sectionXml(out);
    // 바뀐 문단의 줄 배치 캐시는 지워지고(구역 문단·'뒤'만 남음), 서식(run) 셋은 그대로 남는다
    expect(xml.match(/<hp:linesegarray>/g)).toHaveLength(2);
    expect(xml).toContain('<hp:run charPrIDRef="1"><hp:t></hp:t></hp:run>');
  });

  it('두 문단을 한 번에 고쳐도 원래 위치로 각각 찾는다', async () => {
    const bytes = await buildHwpx(secPrPara() + para('가 2025') + para('나') + para('다 2025'));
    const [a, , c] = (await readSegments(bytes)).segments;
    const out = await applyChanges(bytes, [
      change({ id: 'c1', segmentId: a.id, before: '가 2025', after: '가 2026 아주 길게 늘어난 글' }),
      change({ id: 'c2', segmentId: c.id, before: '다 2025', after: '다 2026' }),
    ]);
    expect(texts((await readSegments(out)).segments)).toEqual(['가 2026 아주 길게 늘어난 글', '나', '다 2026']);
  });

  it('XML 특수 글자는 이스케이프해 넣는다', async () => {
    const bytes = await buildHwpx(secPrPara() + para('옛 글'));
    const [a] = (await readSegments(bytes)).segments;
    const out = await applyChanges(bytes, [change({ segmentId: a.id, before: '옛 글', after: 'A&B <제3조> "인용"' })]);
    expect(texts((await readSegments(out)).segments)).toEqual(['A&B <제3조> "인용"']);
    expect(await bareProblems(out, ['A&B <제3조> "인용"'])).toEqual([]);
  });

  it('표 칸 변경은 그 칸만 고치고 표를 품은 문단의 줄 배치도 지운다', async () => {
    const body = secPrPara() + para('앞') + tableAt([['구분', '2025년'], ['예산', '1,200']], { addr: true }) + para('뒤');
    const bytes = await buildHwpx(body);
    const before = (await readSegments(bytes)).segments;
    const cell = before.find((s) => s.text === '1,200')!;
    const out = await applyChanges(bytes, [change({ kind: 'table', segmentId: cell.id, before: '1,200', after: '1,500' })]);
    const again = (await readSegments(out)).segments;
    expect(texts(again)).toEqual(texts(before).map((t) => (t === '1,200' ? '1,500' : t)));
    expect(again.map((s) => s.cell)).toEqual(before.map((s) => s.cell));
    const xmlBefore = await sectionXml(bytes);
    const xmlAfter = await sectionXml(out);
    // 칸 문단 하나 + 표를 품은 바깥 문단 하나의 캐시가 지워진다
    expect(xmlAfter.match(/<hp:linesegarray>/g)!.length).toBe(xmlBefore.match(/<hp:linesegarray>/g)!.length - 2);
    expect(xmlAfter).toContain('<hp:tbl id="9" rowCnt="2" colCnt="2">');
    expect(await bareProblems(out, ['1,500'])).toEqual([]);
  });

  it('바뀐 부분만 고친다 — 탭 앞뒤의 글자리는 그대로', async () => {
    const xml = await applyOne(rawPara('□<hp:tab/>2025년 추진 실적'), '□2026년 추진 실적');
    expect(xml).toContain('<hp:t>□<hp:tab/>2026년 추진 실적</hp:t>');
  });

  it('두 조각에 걸친 변경은 첫 조각이 바뀐 글을 받고 바뀌지 않은 조각은 손대지 않는다', async () => {
    const xml = await applyOne(para(['2025년 ', '예산은 ', '100이다.']), '2025년 예산을 200으로 한다.');
    expect(xml).toContain('<hp:run charPrIDRef="0"><hp:t>2025년 </hp:t></hp:run>');
    expect(xml).toContain('<hp:run charPrIDRef="1"><hp:t>예산을 200으로 한</hp:t></hp:run>');
    expect(xml).toContain('<hp:run charPrIDRef="2"><hp:t>다.</hp:t></hp:run>');
  });

  it('지우기만 하는 변경(가운데가 빔)도 탭 자리를 지킨다', async () => {
    const xml = await applyOne(rawPara('가나<hp:tab/>다라'), '가라');
    expect(xml).toContain('<hp:t>가<hp:tab/>라</hp:t>');
  });

  it('앞이 같지 않은 변경(공통 앞부분 없음)', async () => {
    const xml = await applyOne(rawPara('2025년 실적<hp:tab/>비고'), '올해 실적비고');
    expect(xml).toContain('<hp:t>올해 실적<hp:tab/>비고</hp:t>');
  });

  it('넣기만 하는 변경은 앞 조각 끝에 붙는다', async () => {
    const xml = await applyOne(rawPara('가<hp:tab/>나'), '가다나');
    expect(xml).toContain('<hp:t>가다<hp:tab/>나</hp:t>');
  });

  it('서로게이트 쌍을 가르지 않는다', async () => {
    const xml = await applyOne(para('\u{1D7D9} 항목'), '\u{1D7DA} 항목');
    expect(xml).toContain('<hp:t>\u{1D7DA} 항목</hp:t>');
  });

  it('첫 줄이 같고 줄만 늘면 문단 글은 그대로 두고 뒤에 잇는다', async () => {
    const bytes = await buildHwpx(secPrPara() + para('가') + para('끝'));
    const [a] = (await readSegments(bytes)).segments;
    const out = await applyChanges(bytes, [change({ segmentId: a.id, before: '가', after: '가\n나' })]);
    expect(texts((await readSegments(out)).segments)).toEqual(['가', '나', '끝']);
    expect(await sectionXml(out)).toContain('<hp:t>가</hp:t>');
  });

  it('같은 글이면 아무것도 고치지 않는다', async () => {
    const bytes = await buildHwpx(secPrPara() + para('가'));
    const [a] = (await readSegments(bytes)).segments;
    const out = await applyChanges(bytes, [change({ segmentId: a.id, before: '가', after: '가' })]);
    expect(await sectionXml(out)).toBe(await sectionXml(bytes));
  });

  it('표 칸 before는 쉼표·공백·숫자 값으로 맞대고, 다르면 PRIOR_MISMATCH', async () => {
    const body = secPrPara() + tableAt([['구분', '2025년'], ['예산', '1,200']], { addr: true });
    const bytes = await buildHwpx(body);
    const c = (await readSegments(bytes)).segments.find((s) => s.text === '1,200')!;
    for (const before of ['1200', ' 1,200 ', '1200.0']) {
      const out = await applyChanges(bytes, [change({ kind: 'table', segmentId: c.id, before, after: '1,500' })]);
      expect((await readSegments(out)).segments.some((s) => s.text === '1,500')).toBe(true);
    }
    for (const before of ['1,300', '1,200\n300', '']) {
      await expect(applyChanges(bytes, [change({ kind: 'table', segmentId: c.id, before, after: '1,500' })])).rejects.toMatchObject({
        code: 'PRIOR_MISMATCH',
      });
    }
  });

  it('같은 표의 두 칸을 한 번에 고치면 바깥 문단 캐시는 한 번만 지운다', async () => {
    const body = secPrPara() + tableAt([['구분', '2025년', '2024년'], ['예산', '1,200', '900']], { addr: true });
    const bytes = await buildHwpx(body);
    const segs = (await readSegments(bytes)).segments;
    const a = segs.find((s) => s.text === '1,200')!;
    const b = segs.find((s) => s.text === '900')!;
    const out = await applyChanges(bytes, [
      change({ id: 'c1', kind: 'table', segmentId: a.id, before: '1,200', after: '1,500' }),
      change({ id: 'c2', kind: 'table', segmentId: b.id, before: '900', after: '1,200' }),
    ]);
    expect(texts((await readSegments(out)).segments)).toEqual(['구분', '2025년', '2024년', '예산', '1,500', '1,200']);
    const before = (await sectionXml(bytes)).match(/<hp:linesegarray>/g)!.length;
    // 칸 둘 + 바깥 문단 하나
    expect((await sectionXml(out)).match(/<hp:linesegarray>/g)!.length).toBe(before - 3);
    expect(await bareProblems(out, ['1,500', '1,200'])).toEqual([]);
  });

  it('표를 품은 바깥 문단의 글과 그 안 칸을 함께 고친다', async () => {
    const table = tableAt([['구분', '금액'], ['예산', '1,200']], { addr: true }).replace(
      '<hp:run charPrIDRef="0"><hp:tbl',
      '<hp:run charPrIDRef="0"><hp:t>2025년 예산표</hp:t><hp:tbl'
    );
    const bytes = await buildHwpx(secPrPara() + table + para('뒤'));
    const segs = (await readSegments(bytes)).segments;
    const outer = segs.find((s) => s.text === '2025년 예산표')!;
    const inner = segs.find((s) => s.text === '1,200')!;
    expect(outer.nested).toBe(false);
    const out = await applyChanges(bytes, [
      change({ id: 'c1', kind: 'year', segmentId: outer.id, before: '2025년 예산표', after: '2026년 예산표' }),
      change({ id: 'c2', kind: 'table', segmentId: inner.id, before: '1,200', after: '1,500' }),
    ]);
    expect(texts((await readSegments(out)).segments)).toEqual(['2026년 예산표', '구분', '금액', '예산', '1,500', '뒤']);
    const before = (await sectionXml(bytes)).match(/<hp:linesegarray>/g)!.length;
    // 칸 하나 + 바깥 문단 하나(자기 캐시이자 조상 캐시 — 한 번만)
    expect((await sectionXml(out)).match(/<hp:linesegarray>/g)!.length).toBe(before - 2);
    expect(await bareProblems(out, ['2026년 예산표', '1,500'])).toEqual([]);
  });

  it('조각 id가 작년 파일에서 풀리지 않으면 PRIOR_MISMATCH(409)', async () => {
    const bytes = await prior();
    const target = (await readSegments(bytes)).segments.find((s) => s.text === MAIN)!;
    const [section, start] = target.id.split(':');
    const bad = [
      change({ segmentId: `${section}:999999`, before: MAIN, after: 'x' }),
      change({ segmentId: `9:${start}`, before: MAIN, after: 'x' }),
      change({ segmentId: '엉뚱한 id', before: MAIN, after: 'x' }),
      // 앞자리 0을 붙인 id는 같은 문단을 가리키는 다른 글이 된다 — 받지 않는다
      change({ segmentId: `${section}:0${start}`, before: MAIN, after: 'x' }),
      change({ segmentId: `0${section}:${start}`, before: MAIN, after: 'x' }),
      change({ segmentId: `${section}:${Number(start) + 1}`, before: MAIN, after: 'x' }),
      // 같은 자리지만 글이 다르다 — 다른 파일이다
      change({ segmentId: target.id, before: '다른 글', after: 'x' }),
    ];
    for (const c of bad) {
      await expect(applyChanges(bytes, [c])).rejects.toMatchObject({
        code: 'PRIOR_MISMATCH',
        status: 409,
        message: '작년 파일이 바뀌어 변경을 적용할 수 없습니다.',
      });
    }
  });

  it('한 조각에 적용할 변경이 둘이면 겹쳐 쓰지 않고 거절한다', async () => {
    const bytes = await buildHwpx(secPrPara() + para('가'));
    const [a] = (await readSegments(bytes)).segments;
    await expect(
      applyChanges(bytes, [
        change({ id: 'c1', segmentId: a.id, before: '가', after: '나' }),
        change({ id: 'c2', segmentId: a.id, before: '가', after: '다' }),
      ])
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('글이 없는 문단을 가리키는 id도 풀리지 않는다', async () => {
    const bytes = await buildHwpx(secPrPara() + para('가'));
    const xml = await sectionXml(bytes);
    // 구역 설정 문단(글 없음)의 시작 위치
    const blankStart = xml.indexOf('<hp:p ');
    await expect(applyChanges(bytes, [change({ kind: 'table', segmentId: `0:${blankStart}`, before: '', after: 'x' })])).rejects.toMatchObject({
      code: 'PRIOR_MISMATCH',
    });
  });
});

const seg = (id: string, text: string, cell: Segment['cell'] = null): Segment => ({
  id,
  section: 0,
  text,
  path: [],
  nested: cell !== null,
  cell,
});

const cite = (segmentId: string, status: CitationPair['status']): CitationPair => ({
  segmentId,
  cited: { name: '지방공기업법', article: '제64조', text: '옛 문장' },
  current: status === 'not_found' ? null : { kind: 'law', title: '지방공기업법', article: '제64조', text: '새 문장', enforced: null },
  status,
});

const cell = (row: number, col: number, before: string, after: string | null, status: ShiftedCell['status'], note?: string): ShiftedCell => ({
  row,
  col,
  before,
  after,
  status,
  ...(note ? { note } : {}),
});

function planInput() {
  const segments = [
    seg('0:10', '2025년 사업을 추진한다.'),
    seg('0:20', '2025년 하반기에 점검한다.'),
    seg('0:30', '옛 방식으로 운영한다.'),
    seg('0:40', '예산은 1,200백만원이다.'),
    seg('0:50', '제64조에 따라 옛 문장을 따른다.'),
    seg('0:60', '제12조에 따른다.'),
    seg('0:70', '제3조에 따른다.'),
    seg('0:80', '1,200', { table: 0, row: 1, col: 1 }),
    seg('0:90', '900', { table: 0, row: 1, col: 2 }),
    seg('0:95', '+300', { table: 0, row: 1, col: 3 }),
  ];
  return {
    segments,
    fromYear: 2025,
    toYear: 2026,
    findings: new Map(),
    shifted: new Map([
      ['0:10', '2026년 사업을 추진한다.'],
      ['0:20', '2026년 하반기에 점검한다.'],
      // 표 칸은 표 쪽 변경만 낸다
      ['0:80', '2026'],
    ]),
    tableCells: [
      { segmentId: '0:80', cell: cell(1, 1, '1,200', '1,500', 'changed'), uncertain: true },
      { segmentId: '0:90', cell: cell(1, 2, '900', '1,200', 'changed'), uncertain: false },
      { segmentId: '0:95', cell: cell(1, 3, '+300', null, 'needs_check', '괄호로 적힌 숫자라 음수인지 확인이 필요합니다'), uncertain: false },
    ],
    rewrites: {
      accepted: [{ segmentId: '0:10', text: '2026년 사업을 새 지침에 따라 추진한다.', basis: ['src1'] }],
      proposed: [{ segmentId: '0:30', text: '새 방식으로 운영한다.', basis: ['memo'] }],
    },
    citations: [cite('0:50', 'changed'), cite('0:60', 'not_found'), cite('0:70', 'same')],
    numberStatus: new Map<string, 'ok' | 'needs_check'>([
      ['0:10', 'needs_check'],
      ['0:40', 'needs_check'],
      ['0:20', 'ok'],
      ['0:80', 'needs_check'],
    ]),
  };
}

describe('buildPlan — 변경 계획', () => {
  it('규칙대로 변경을 만든다', () => {
    const plan = buildPlan(planInput());
    expect(plan).toEqual([
      // 받아들인 고치기가 연도 밀기·숫자 확인보다 이긴다
      { id: 'c1', segmentId: '0:10', kind: 'prose', before: '2025년 사업을 추진한다.', after: '2026년 사업을 새 지침에 따라 추진한다.', status: 'changed', basis: ['src1'], note: null },
      { id: 'c2', segmentId: '0:20', kind: 'year', before: '2025년 하반기에 점검한다.', after: '2026년 하반기에 점검한다.', status: 'changed', basis: [], note: null },
      // 제안은 적용하지 않는다
      { id: 'c3', segmentId: '0:30', kind: 'prose', before: '옛 방식으로 운영한다.', after: '새 방식으로 운영한다.', status: 'proposed', basis: ['memo'], note: null },
      { id: 'c4', segmentId: '0:40', kind: 'number', before: '예산은 1,200백만원이다.', after: null, status: 'needs_check', basis: [], note: '올해 자료에서 확인되지 않은 숫자가 있습니다 — 확인하세요' },
      { id: 'c5', segmentId: '0:50', kind: 'citation', before: '제64조에 따라 옛 문장을 따른다.', after: null, status: 'needs_check', basis: [], note: '근거 조문이 바뀜 — 문장을 확인하세요' },
      { id: 'c6', segmentId: '0:60', kind: 'citation', before: '제12조에 따른다.', after: null, status: 'needs_check', basis: [], note: '현재 조문을 찾지 못함' },
      // 단위를 모르는 행은 바뀐 칸이어도 확인으로
      { id: 'c7', segmentId: '0:80', kind: 'table', before: '1,200', after: '1,500', status: 'needs_check', basis: [], note: '단위를 알 수 없어 그대로 넣었습니다 — 확인하세요' },
      // 표 칸 조각은 연도 밀기 같은 다른 changed를 내지 않지만 확인 요청은 남긴다
      { id: 'c8', segmentId: '0:80', kind: 'number', before: '1,200', after: null, status: 'needs_check', basis: [], note: '올해 자료에서 확인되지 않은 숫자가 있습니다 — 확인하세요' },
      { id: 'c9', segmentId: '0:90', kind: 'table', before: '900', after: '1,200', status: 'changed', basis: [], note: null },
      { id: 'c10', segmentId: '0:95', kind: 'table', before: '+300', after: null, status: 'needs_check', basis: [], note: '괄호로 적힌 숫자라 음수인지 확인이 필요합니다' },
    ]);
  });

  it('바뀐 인용에 받아들인 고치기가 있으면 고치기가 변경이 된다', () => {
    const input = planInput();
    input.rewrites.accepted.push({ segmentId: '0:50', text: '제64조에 따라 새 문장을 따른다.', basis: ['0:50'] });
    const c = buildPlan(input).filter((x) => x.segmentId === '0:50');
    expect(c).toEqual([
      expect.objectContaining({ kind: 'prose', status: 'changed', after: '제64조에 따라 새 문장을 따른다.', basis: ['0:50'] }),
    ]);
  });

  it('연도 밀기와 제안이 함께면 연도는 적용하고 제안은 따로 둔다', () => {
    const input = planInput();
    input.rewrites.proposed.push({ segmentId: '0:20', text: '2025년 하반기에 다시 점검한다.', basis: [] });
    const c = buildPlan(input).filter((x) => x.segmentId === '0:20');
    expect(c.map((x) => [x.kind, x.status])).toEqual([
      ['year', 'changed'],
      ['prose', 'proposed'],
    ]);
  });

  it('같은 조각에 바뀐 인용이 여럿이어도 확인 요청은 하나다', () => {
    const input = planInput();
    input.citations.push(cite('0:50', 'changed'), cite('0:50', 'not_found'));
    const c = buildPlan(input).filter((x) => x.segmentId === '0:50');
    expect(c.map((x) => x.note)).toEqual(['근거 조문이 바뀜 — 문장을 확인하세요', '현재 조문을 찾지 못함']);
  });

  it('밀어도 글이 같으면 변경이 아니고, id는 같은 입력에 언제나 같다', () => {
    const input = planInput();
    input.shifted.set('0:30', '옛 방식으로 운영한다.');
    const a = buildPlan(input);
    expect(a.filter((x) => x.segmentId === '0:30').map((x) => x.status)).toEqual(['proposed']);
    expect(a.map((x) => x.id)).toEqual(a.map((_, i) => `c${i + 1}`));
    expect(buildPlan(planInput())).toEqual(buildPlan(planInput()));
  });

  it('받아들인 고치기에 지난해 연도가 남으면 적용하지 않고 제안으로 내린다', () => {
    const input = planInput();
    input.rewrites.accepted = [
      { segmentId: '0:10', text: '2025년 사업을 새 지침에 따라 추진한다.', basis: ['src1'] },
      { segmentId: '0:20', text: "'25 하반기에 다시 점검한다.", basis: ['src1'] },
    ];
    const plan = buildPlan(input);
    const note = '지난해 연도가 남아 있습니다 — 확인하세요';
    expect(plan.filter((x) => x.segmentId === '0:10')).toEqual([
      expect.objectContaining({ kind: 'prose', status: 'proposed', after: '2025년 사업을 새 지침에 따라 추진한다.', note }),
    ]);
    expect(plan.filter((x) => x.segmentId === '0:20')).toEqual([expect.objectContaining({ kind: 'prose', status: 'proposed', note })]);
  });

  it('밀어도 남는 지난해 연도(원래 글에 있던 것)는 고치기에 있어도 된다', () => {
    const input = planInput();
    input.segments[0] = seg('0:10', '2025년 대비 2025년 사업을 추진한다.');
    input.shifted.set('0:10', '2025년 대비 2026년 사업을 추진한다.');
    input.rewrites.accepted = [{ segmentId: '0:10', text: '2025년 대비 2026년 사업을 새로 추진한다.', basis: ['src1'] }];
    expect(buildPlan(input).filter((x) => x.segmentId === '0:10')).toEqual([expect.objectContaining({ status: 'changed', note: null })]);
    // 지난해 연도가 하나 더 생기면 제안으로
    input.rewrites.accepted = [{ segmentId: '0:10', text: '2025년 대비 2025년 사업을 새로 추진한다.', basis: ['src1'] }];
    expect(buildPlan(input).filter((x) => x.segmentId === '0:10')).toEqual([expect.objectContaining({ status: 'proposed' })]);
  });

  it('표 칸 조각의 받아들인 고치기·연도 밀기는 적용하지 않고 인용·제안은 남긴다', () => {
    const input = planInput();
    input.rewrites.accepted.push({ segmentId: '0:90', text: '1,000', basis: ['src1'] });
    input.citations.push(cite('0:90', 'not_found'));
    input.shifted.set('0:90', '2026');
    const c = buildPlan(input).filter((x) => x.segmentId === '0:90');
    expect(c.map((x) => [x.kind, x.status])).toEqual([
      ['table', 'changed'],
      ['prose', 'proposed'],
      ['citation', 'needs_check'],
    ]);
  });

  it('한 칸에 바뀐 값이 둘이면 첫째만 changed, 나머지는 확인 요청', () => {
    const input = planInput();
    input.tableCells.push({ segmentId: '0:90', cell: cell(1, 2, '900', '1,300', 'changed'), uncertain: false });
    const c = buildPlan(input).filter((x) => x.segmentId === '0:90');
    expect(c).toEqual([
      expect.objectContaining({ status: 'changed', after: '1,200' }),
      expect.objectContaining({ status: 'needs_check', after: '1,300', note: '같은 칸에 변경이 둘 이상입니다' }),
    ]);
  });

  it('계획대로 적용하면 changed만 들어간다', async () => {
    const body = secPrPara() + para('2025년 사업을 추진한다.') + para('옛 방식으로 운영한다.') + para('예산은 1,200백만원이다.');
    const bytes = await buildHwpx(body);
    const segments = (await readSegments(bytes)).segments;
    const plan = buildPlan({
      segments,
      fromYear: 2025,
      toYear: 2026,
      findings: new Map(),
      shifted: new Map([[segments[0].id, '2026년 사업을 추진한다.']]),
      tableCells: [],
      rewrites: { accepted: [], proposed: [{ segmentId: segments[1].id, text: '새 방식', basis: ['memo'] }] },
      citations: [],
      numberStatus: new Map([[segments[2].id, 'needs_check' as const]]),
    });
    expect(plan.map((c) => c.status)).toEqual(['changed', 'proposed', 'needs_check']);
    const out = await applyChanges(bytes, plan);
    expect(texts((await readSegments(out)).segments)).toEqual(['2026년 사업을 추진한다.', '옛 방식으로 운영한다.', '예산은 1,200백만원이다.']);
  });
});
