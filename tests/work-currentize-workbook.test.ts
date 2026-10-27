import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { buildChangeLogWorkbook } from '@/lib/work/workflows/currentize/workbook';
import type { CurrentizeContent, Change } from '@/lib/work/workflows/currentize/plan';

const CREATED = new Date('2026-10-28T01:30:00Z'); // KST 10:30

function change(over: Partial<Change> = {}): Change {
  return { id: 'c1', segmentId: 's0:10', kind: 'year', before: '2025년', after: '2026년', status: 'changed', basis: [], note: null, ...over };
}
function content(over: Partial<CurrentizeContent> = {}): CurrentizeContent {
  return {
    schema: 'currentize/1',
    priorSourceId: 'src-1',
    priorSha256: 'abcdef0123456789ffffffff',
    fromYear: 2025,
    toYear: 2026,
    changes: [change()],
    citations: [],
    truncated: false,
    costStopped: false,
    mode: 'llm',
    ...over,
  };
}
async function load(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
}
const OPTS = { title: '현행화', createdAt: CREATED };

/** 안내 시트: 이름 → 값 (이름이 겹치는 줄은 마지막 것) */
function notes(ws: ExcelJS.Worksheet) {
  const m = new Map<string, string>();
  const all: [string, string][] = [];
  ws.eachRow((r) => {
    const k = String(r.getCell(1).value ?? '');
    const v = String(r.getCell(2).value ?? '');
    m.set(k, v);
    all.push([k, v]);
  });
  return { m, all };
}

describe('buildChangeLogWorkbook', () => {
  it('시트 이름 셋과 행 수(변경 수 + 머리글)', async () => {
    const wb = await load(
      await buildChangeLogWorkbook(content({ changes: [change(), change({ id: 'c2', kind: 'table', status: 'needs_check', after: null })] }), OPTS),
    );
    expect(wb.worksheets.map((w) => w.name)).toEqual(['변경 내역', '근거 대조', '안내']);
    const ws = wb.getWorksheet('변경 내역')!;
    expect(ws.rowCount).toBe(3);
    expect(ws.getRow(1).values).toEqual([undefined, '번호', '위치', '종류', '작년 글', '올해 글', '상태', '근거', '비고']);
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
  });

  it('종류·상태는 한국어, 근거는 쉼표로, 위치는 라벨 맵 또는 조각 id', async () => {
    const changes = [
      change({ id: 'c1', kind: 'citation', status: 'needs_check', basis: ['s1:5', 'memo'], note: '확인' }),
      change({ id: 'c2', kind: 'prose', status: 'proposed', segmentId: 's9:1' }),
      change({ id: 'c3', kind: 'structure', status: 'changed' }),
    ];
    const ws = (await load(await buildChangeLogWorkbook(content({ changes }), { ...OPTS, segmentLabels: new Map([['s0:10', '제1장 › 개요']]) })))
      .getWorksheet('변경 내역')!;
    expect(ws.getCell('A2').value).toBe('c1');
    expect(ws.getCell('B2').value).toBe('제1장 › 개요');
    expect(ws.getCell('C2').value).toBe('근거 인용');
    expect(ws.getCell('F2').value).toBe('확인 필요');
    expect(ws.getCell('G2').value).toBe('s1:5, memo');
    expect(ws.getCell('H2').value).toBe('확인');
    expect(ws.getCell('B3').value).toBe('s9:1');
    expect(ws.getCell('C3').value).toBe('문장');
    expect(ws.getCell('F3').value).toBe('제안');
    expect(ws.getCell('C4').value).toBe('구조');
    expect(ws.getCell('F4').value).toBe('바꿈');
  });

  it('종류 라벨 전부', async () => {
    const kinds = ['year', 'period', 'number', 'citation', 'person', 'date', 'prose', 'table', 'structure'] as const;
    const ws = (await load(await buildChangeLogWorkbook(content({ changes: kinds.map((k, i) => change({ id: `c${i}`, kind: k })) }), OPTS)))
      .getWorksheet('변경 내역')!;
    expect(kinds.map((_, i) => ws.getCell(i + 2, 3).value)).toEqual(['연도', '기간', '수치', '근거 인용', '담당자', '날짜', '문장', '표 칸', '구조']);
  });

  it('수식으로 읽힐 글은 글자로(작년·올해 모두), 길면 자름, after null은 빈 칸', async () => {
    const long = 'x'.repeat(40000);
    const ws = (
      await load(
        await buildChangeLogWorkbook(
          content({ changes: [change({ before: '=SUM(A1)', after: '@cmd' }), change({ id: 'c2', before: long, after: null })] }),
          OPTS,
        ),
      )
    ).getWorksheet('변경 내역')!;
    expect(ws.getCell('D2').value).toBe("'=SUM(A1)");
    expect(ws.getCell('E2').value).toBe("'@cmd");
    const cut = String(ws.getCell('D3').value);
    expect(cut.length).toBeLessThanOrEqual(32001);
    expect(cut.endsWith('…')).toBe(true);
    const e3 = ws.getCell('E3').value;
    expect(e3 === null || e3 === '').toBe(true);
  });

  it('근거 대조 시트 — 인용마다 한 줄', async () => {
    const citations: CurrentizeContent['citations'] = [
      { segmentId: 's0:10', cited: { name: '국가재정법', article: '제3조', text: '옛 글' }, current: { kind: 'law', title: '국가재정법', article: '제3조', text: '새 글', enforced: '2026-01-01' }, status: 'changed' },
      { segmentId: 's2:4', cited: { name: '없는법', article: null, text: '글' }, current: null, status: 'not_found' },
      { segmentId: 's3:4', cited: { name: '같은법', article: '제1조', text: 'a' }, current: { kind: 'law', title: '같은법', article: '제1조', text: 'a', enforced: null }, status: 'same' },
    ];
    const ws = (await load(await buildChangeLogWorkbook(content({ citations }), OPTS))).getWorksheet('근거 대조')!;
    expect(ws.rowCount).toBe(4);
    expect(ws.getRow(1).values).toEqual([undefined, '조각', '인용 규정', '조문', '작년 글', '현재 조문 제목', '현재 조문 글', '시행일', '상태']);
    expect(ws.getCell('B2').value).toBe('국가재정법');
    expect(ws.getCell('E2').value).toBe('국가재정법');
    expect(ws.getCell('F2').value).toBe('새 글');
    expect(ws.getCell('G2').value).toBe('2026-01-01');
    expect(ws.getCell('H2').value).toBe('바뀜');
    expect(ws.getCell('H3').value).toBe('찾지 못함');
    expect(ws.getCell('H4').value).toBe('같음');
    expect(ws.getCell('E3').value ?? '').toBe('');
  });

  it('안내 시트 — 기준 연도·해시·변경 수·상한·시험 모드·경고', async () => {
    const c = content({
      changes: [change(), change({ id: 'c2', status: 'needs_check' }), change({ id: 'c3', status: 'proposed' }), change({ id: 'c4' })],
      costStopped: true,
      truncated: true,
      mode: 'mock',
    });
    const ws = (await load(await buildChangeLogWorkbook(c, { ...OPTS, warnings: ['단위를 몰라 그대로 둠', '=위험'] }))).getWorksheet('안내')!;
    const { m, all } = notes(ws);
    expect(m.get('만든 때(KST)')).toBe('2026-10-28 10:30');
    expect(m.get('기준 연도')).toBe('2025년 → 2026년');
    expect(m.get('작년 파일 해시')).toBe('abcdef0123456789');
    expect(m.get('변경 수')).toBe('바꿈 2 · 확인 필요 1 · 제안 1');
    expect(m.get('상한으로 멈춤')).toBe('예(원가 상한, 조각 상한)');
    expect(m.get('시험 모드')).toBe('예 — 실제 기능이 아닙니다');
    expect(all.some(([, v]) => v === '단위를 몰라 그대로 둠')).toBe(true);
    expect(all.some(([, v]) => v === "'=위험")).toBe(true);
    expect(all[all.length - 1][0]).toBe('이 표의 값은 계산 결과이며 수식이 없습니다');
  });

  it('안내 — 상한 한 가지씩, 없으면 아니오, 시험 모드 아님', async () => {
    const get = async (o: Partial<CurrentizeContent>) => notes((await load(await buildChangeLogWorkbook(content(o), OPTS))).getWorksheet('안내')!).m;
    expect((await get({ costStopped: true })).get('상한으로 멈춤')).toBe('예(원가 상한)');
    expect((await get({ truncated: true })).get('상한으로 멈춤')).toBe('예(조각 상한)');
    const none = await get({});
    expect(none.get('상한으로 멈춤')).toBe('아니오');
    expect(none.get('시험 모드')).toBe('아니오');
  });

  it('수식 칸이 하나도 없다', async () => {
    const wb = await load(await buildChangeLogWorkbook(content({ changes: [change({ before: '=1+1' })] }), OPTS));
    wb.eachSheet((ws) =>
      ws.eachRow((r) =>
        r.eachCell((c) => expect(typeof c.value === 'object' && c.value !== null && 'formula' in (c.value as object)).toBe(false)),
      ),
    );
  });
});
