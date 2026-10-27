import { describe, it, expect } from 'vitest';
import { readSegments } from '@/lib/work/workflows/currentize/segments';
import { MAX_SEGMENTS } from '@/lib/work/workflows/currentize/limits';
import { buildHwpx, para, tableAt, secPrPara } from './fixtures/hwpx';
import { priorFixture } from './helpers/prior-fixture';

describe('현행화 — HWPX 조각 읽기', () => {
  it('채운 보고서의 문단이 조각으로 읽히고 id는 두 번 읽어도 같다', async () => {
    const bytes = await priorFixture({ 제목: '2025년 ○○ 사업계획', '주요 내용': '2025년 예산은 1,200백만원이다.' });
    const a = await readSegments(bytes);
    const b = await readSegments(bytes);
    expect(a.segments.map((s) => s.id)).toEqual(b.segments.map((s) => s.id));
    expect(a.segments.some((s) => s.text.includes('1,200백만원'))).toBe(true);
    expect(a.segments.some((s) => s.text.includes('2025년 ○○ 사업계획'))).toBe(true);
    expect(new Set(a.segments.map((s) => s.id)).size).toBe(a.segments.length);
    expect(a.truncated).toBe(false);
  });

  it('id는 `섹션:문단 시작 위치`이고 글이 없는 문단은 조각이 아니다', async () => {
    const bytes = await buildHwpx(secPrPara() + para('첫 문단') + para('') + para('셋째'));
    const { segments } = await readSegments(bytes);
    expect(segments.map((s) => s.text)).toEqual(['첫 문단', '셋째']);
    for (const s of segments) expect(s.id).toMatch(/^0:\d+$/);
    expect(segments.every((s) => !s.nested && s.cell === null)).toBe(true);
  });

  it('표 칸 문단은 cell 좌표를 갖고, 표 밖 문단은 null이다', async () => {
    const body =
      secPrPara() +
      para('앞 문단') +
      tableAt([['구분', '금액'], ['예산', '1,200']], { addr: true }) +
      tableAt([['이름', '값']]) + // 주소 없는 표 — 행·열 순서로
      para('뒤 문단');
    const { segments } = await readSegments(await buildHwpx(body));
    const by = (t: string) => segments.find((s) => s.text === t)!;
    expect(by('앞 문단').cell).toBeNull();
    expect(by('뒤 문단').cell).toBeNull();
    expect(by('구분')).toMatchObject({ nested: true, cell: { table: 0, row: 0, col: 0 } });
    expect(by('금액').cell).toEqual({ table: 0, row: 0, col: 1 });
    expect(by('예산').cell).toEqual({ table: 0, row: 1, col: 0 });
    expect(by('1,200').cell).toEqual({ table: 0, row: 1, col: 1 });
    expect(by('이름').cell).toEqual({ table: 1, row: 0, col: 0 });
    expect(by('값').cell).toEqual({ table: 1, row: 0, col: 1 });
  });

  it('번호 제목 사슬이 path가 되고 제목 자신은 제외한다', async () => {
    const body =
      secPrPara() +
      para('Ⅰ. 개요') +
      para('개요 본문') +
      para('1. 배경') +
      para('배경 본문') +
      para('2. 목적') +
      para('목적 본문') +
      para('Ⅱ. 추진') +
      para('추진 본문');
    const { segments } = await readSegments(await buildHwpx(body));
    const by = (t: string) => segments.find((s) => s.text === t)!;
    expect(by('Ⅰ. 개요').path).toEqual([]);
    expect(by('개요 본문').path).toEqual(['Ⅰ. 개요']);
    expect(by('1. 배경').path).toEqual(['Ⅰ. 개요']);
    expect(by('배경 본문').path).toEqual(['Ⅰ. 개요', '1. 배경']);
    expect(by('목적 본문').path).toEqual(['Ⅰ. 개요', '2. 목적']);
    expect(by('추진 본문').path).toEqual(['Ⅱ. 추진']);
  });

  it('여러 섹션은 섹션 번호를 id에 싣는다', async () => {
    const bytes = await buildHwpx(secPrPara() + para('가'), { moreSections: [para('나')] });
    const { segments } = await readSegments(bytes);
    expect(segments.map((s) => [s.section, s.text])).toEqual([[0, '가'], [1, '나']]);
    expect(segments[1].id.startsWith('1:')).toBe(true);
  });

  it('MAX_SEGMENTS에서 자르고 truncated를 알린다', async () => {
    const body = secPrPara() + Array.from({ length: MAX_SEGMENTS + 5 }, (_, i) => para(`문단 ${i}`)).join('');
    const r = await readSegments(await buildHwpx(body));
    expect(r.segments).toHaveLength(MAX_SEGMENTS);
    expect(r.truncated).toBe(true);
  });
  it('칸 주소(cellAddr)가 행·열 세기와 다르면 주소를 따른다(병합 칸)', async () => {
    const tc = (text: string, r: number, c: number, cs = 1) =>
      `<hp:tc><hp:subList>${para(text, '7')}</hp:subList><hp:cellAddr colAddr="${c}" rowAddr="${r}"/><hp:cellSpan colSpan="${cs}" rowSpan="1"/><hp:cellSz width="1000" height="282"/></hp:tc>`;
    // 첫 칸이 2칸 병합 → 다음 칸의 주소는 col 2 (세기만 하면 1)
    const body =
      secPrPara() +
      `<hp:p id="2" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:tbl id="9" rowCnt="2" colCnt="3">` +
      `<hp:tr>${tc('합친 칸', 0, 0, 2)}${tc('끝 칸', 0, 2)}</hp:tr>` +
      `<hp:tr>${tc('아래 가', 5, 7)}</hp:tr>` + // 일부러 어긋난 주소
      `</hp:tbl></hp:run></hp:p>`;
    const { segments } = await readSegments(await buildHwpx(body));
    const by = (t: string) => segments.find((s) => s.text === t)!;
    expect(by('합친 칸').cell).toEqual({ table: 0, row: 0, col: 0 });
    expect(by('끝 칸').cell).toEqual({ table: 0, row: 0, col: 2 });
    expect(by('아래 가').cell).toEqual({ table: 0, row: 5, col: 7 });
  });

  it('정확히 MAX_SEGMENTS개면 truncated가 아니다', async () => {
    const body = secPrPara() + Array.from({ length: MAX_SEGMENTS }, (_, i) => para(`문단 ${i}`)).join('');
    const r = await readSegments(await buildHwpx(body));
    expect(r.segments).toHaveLength(MAX_SEGMENTS);
    expect(r.truncated).toBe(false);
  });
});
