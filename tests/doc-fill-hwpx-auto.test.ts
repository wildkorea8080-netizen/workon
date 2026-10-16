import { describe, it, expect } from 'vitest';
import { readHwpxAutoSlots, fillHwpxAutoSlots } from '@/lib/doc-fill/hwpx-auto';
import { extractTextFromHwp } from '@/lib/hwp';
import { buildHwpx, para, emptyPara, secPrPara, SEC_PR_PARA, tableAt, sectionXml } from './fixtures/hwpx';

const values = (o: Record<string, string>) => new Map(Object.entries(o));
const count = (s: string, sub: string) => s.split(sub).length - 1;

describe('번호 제목 영역', () => {
  it('번호 제목 아래 빈 문단을 자리로, 급으로 경로를 단다', async () => {
    const bytes = await buildHwpx(
      secPrPara() + para('1. 추진 배경') + emptyPara() + para('가. 현황') + para('(내용)') + para('2. 일정') + emptyPara()
    );
    expect(await readHwpxAutoSlots(bytes)).toEqual([
      { id: 's1', label: '1. 추진 배경', kind: 'section', path: [], hint: null },
      { id: 's2', label: '가. 현황', kind: 'section', path: ['1. 추진 배경'], hint: '(내용)' },
      { id: 's3', label: '2. 일정', kind: 'section', path: [], hint: null },
    ]);
  });

  it('경로는 위 급 제목의 사슬이다 — 다른 갈래의 제목은 끼지 않는다', async () => {
    const bytes = await buildHwpx(
      para('Ⅰ. 개요') + para('1. 배경') + para('가. 현황') + emptyPara() + para('2. 목표') + para('1) 세부') + emptyPara()
    );
    const slots = await readHwpxAutoSlots(bytes);
    expect(slots.map((s) => [s.label, s.path])).toEqual([
      ['가. 현황', ['Ⅰ. 개요', '1. 배경']],
      ['1) 세부', ['Ⅰ. 개요', '2. 목표']],
    ]);
  });

  it('채울 빈 문단이 없는 제목은 자리가 아니다', async () => {
    const bytes = await buildHwpx(para('1. 개요') + para('2. 현황') + emptyPara());
    expect((await readHwpxAutoSlots(bytes)).map((s) => s.label)).toEqual(['2. 현황']);
  });

  it('글이 든 문단만 있는 제목도 자리가 아니다', async () => {
    const bytes = await buildHwpx(para('1. 개요') + para('본 계획은 기존 사업을 이어 간다.'));
    expect(await readHwpxAutoSlots(bytes)).toEqual([]);
  });

  it('자리 표시 문단은 제목이 아니라 채울 곳이다', async () => {
    const bytes = await buildHwpx(para('1. 개요') + para('○ (내용)') + para('○○○'));
    expect(await readHwpxAutoSlots(bytes)).toEqual([
      { id: 's1', label: '1. 개요', kind: 'section', path: [], hint: '○ (내용)' },
    ]);
  });

  it('구역 설정을 품은 빈 문단은 자리도, 채울 곳도 아니다', async () => {
    expect(await readHwpxAutoSlots(await buildHwpx(para('1. 개요') + secPrPara()))).toEqual([]);

    const bytes = await buildHwpx(para('1. 개요') + secPrPara() + emptyPara());
    expect((await readHwpxAutoSlots(bytes)).map((s) => s.label)).toEqual(['1. 개요']);
    const xml = await sectionXml((await fillHwpxAutoSlots(bytes, values({ s1: '첫째\n둘째' }))).bytes);
    expect(count(xml, '<hp:secPr')).toBe(1);
    expect(count(xml, '<hp:colPr')).toBe(1);
    expect(xml).toContain(SEC_PR_PARA);
    expect(xml).toContain('첫째');
    expect(xml).toContain('둘째');
  });

  it('컨트롤(필드 등)을 품은 문단은 채울 곳이 아니다', async () => {
    const ctrlPara =
      '<hp:p id="1" paraPrIDRef="3" styleIDRef="0"><hp:run charPrIDRef="0"><hp:ctrl><hp:fieldBegin id="1" type="CLICK_HERE"/></hp:ctrl><hp:t></hp:t></hp:run></hp:p>';
    expect(await readHwpxAutoSlots(await buildHwpx(para('1. 개요') + ctrlPara))).toEqual([]);
  });
});

describe('표 빈칸', () => {
  it('표 빈칸은 왼쪽 항목명, 없으면 위쪽 항목명', async () => {
    const bytes = await buildHwpx(
      tableAt(
        [
          ['회의명', '', ''],
          ['일시', '(작성)', '장소'],
          ['', '', ''],
        ],
        { addr: true }
      )
    );
    expect(await readHwpxAutoSlots(bytes)).toEqual([
      { id: 's1', label: '회의명', kind: 'cell', path: [], hint: null }, // (0,1)
      { id: 's2', label: '회의명', kind: 'cell', path: [], hint: null }, // (0,2)
      { id: 's3', label: '일시', kind: 'cell', path: [], hint: '(작성)' }, // (1,1)
      { id: 's4', label: '일시', kind: 'cell', path: [], hint: null }, // (2,0) 위쪽
      { id: 's5', label: '장소', kind: 'cell', path: [], hint: null }, // (2,2) 위쪽
    ]);
  });

  it('칸 위치는 칸 주소를 따른다', async () => {
    // 칸 주소가 행 안 순서와 다르면 주소가 이긴다: 빈칸의 주소가 (0,0)이면 왼쪽 칸이 없다
    const xml = tableAt([['항목', '']], { addr: true })
      .replace('colAddr="0" rowAddr="0"', 'colAddr="X"')
      .replace('colAddr="1" rowAddr="0"', 'colAddr="0" rowAddr="0"')
      .replace('colAddr="X"', 'colAddr="1" rowAddr="0"');
    expect(await readHwpxAutoSlots(await buildHwpx(xml))).toEqual([]);

    // 행도 마찬가지: 먼저 적힌 빈칸의 행 주소가 1이면 위쪽 칸(행 0)의 항목명을 받는다
    const rows = tableAt([[''], ['구분']], { addr: true })
      .replace('colAddr="0" rowAddr="0"', 'colAddr="0" rowAddr="X"')
      .replace('colAddr="0" rowAddr="1"', 'colAddr="0" rowAddr="0"')
      .replace('rowAddr="X"', 'rowAddr="1"');
    expect((await readHwpxAutoSlots(await buildHwpx(rows))).map((s) => s.label)).toEqual(['구분']);
    expect((await readHwpxAutoSlots(await buildHwpx(tableAt([[''], ['구분']]))))).toEqual([]);
  });

  it('결재란처럼 항목명도 위쪽 칸도 없는 빈칸은 자리가 아니다', async () => {
    expect(await readHwpxAutoSlots(await buildHwpx(tableAt([['', '']])))).toEqual([]);
  });

  it('항목명이 다듬어지고, 다듬으면 빈 칸은 항목명으로 쓰지 않는다', async () => {
    const bytes = await buildHwpx(tableAt([['취  급 :', ':', '']]));
    expect((await readHwpxAutoSlots(bytes)).map((s) => s.label)).toEqual(['취급']);
  });

  it('표 칸의 경로는 표 앞의 가장 가까운 제목들', async () => {
    const bytes = await buildHwpx(para('1. 개요') + para('가. 담당') + tableAt([['담당자', '']]) + para('2. 기타'));
    expect(await readHwpxAutoSlots(bytes)).toEqual([
      { id: 's1', label: '담당자', kind: 'cell', path: ['1. 개요', '가. 담당'], hint: null },
    ]);
  });

  it('같은 이름 두 칸은 따로 채운다', async () => {
    const bytes = await buildHwpx(tableAt([['비고', ''], ['비고', '']]));
    const slots = await readHwpxAutoSlots(bytes);
    expect(slots.map((s) => [s.id, s.label])).toEqual([
      ['s1', '비고'],
      ['s2', '비고'],
    ]);
    const result = await fillHwpxAutoSlots(bytes, values({ s1: '첫째 비고', s2: '둘째 비고' }));
    const xml = await sectionXml(result.bytes);
    expect(count(xml, '첫째 비고')).toBe(1);
    expect(count(xml, '둘째 비고')).toBe(1);
    expect(xml.indexOf('첫째 비고')).toBeLessThan(xml.indexOf('둘째 비고'));
    expect(result.filled).toEqual(['s1', 's2']);
  });
});

describe('채우기', () => {
  it('section·cell 채우기 — 다시 읽으면 글이 있고 자리 표시가 없으며, 여러 줄은 새 문단', async () => {
    const bytes = await buildHwpx(
      para('1. 추진 배경') +
        para('(내용)', '5') +
        para('○○○', '5') +
        emptyPara('5') +
        tableAt([['담당', ['(작성)', 'OOO']]])
    );
    expect((await readHwpxAutoSlots(bytes)).map((s) => [s.id, s.kind, s.label])).toEqual([
      ['s1', 'section', '1. 추진 배경'],
      ['s2', 'cell', '담당'],
    ]);
    const result = await fillHwpxAutoSlots(bytes, values({ s1: '첫째 줄\n둘째 줄', s2: '홍길동\n010-0000' }));
    expect(result.filled).toEqual(['s1', 's2']);
    expect(result.unfilled).toEqual([]);

    const text = await extractTextFromHwp(result.bytes, 'out.hwpx');
    for (const s of ['첫째 줄', '둘째 줄', '홍길동', '010-0000']) expect(text).toContain(s);
    for (const s of ['(내용)', '○○○', '(작성)', 'OOO']) expect(text).not.toContain(s);

    const xml = await sectionXml(result.bytes);
    // 영역 문단은 서식 참조를 유지한다: 새 문단 2개 + 글을 지운 문단 + 손대지 않은 빈 문단
    const area = xml.match(/<hp:p [^>]*paraPrIDRef="5"[\s\S]*?<\/hp:p>/g) ?? [];
    expect(area).toHaveLength(4);
    expect(area[0]).toContain('<hp:t>첫째 줄</hp:t>');
    expect(area[1]).toContain('<hp:t>둘째 줄</hp:t>');
    expect(area[0]).toContain('charPrIDRef="0"');
    expect(area.slice(0, 3).join('')).not.toContain('linesegarray');
    expect(area[3]).toContain('linesegarray');
    // 칸 안: 첫 문단 자리에 두 줄, 남은 자리 표시 문단은 글만 지움
    const cell = xml.match(/<hp:tc [\s\S]*?<\/hp:tc>/g)![1];
    const cellParas = cell.match(/<hp:p [^>]*paraPrIDRef="7"[\s\S]*?<\/hp:p>/g) ?? [];
    expect(cellParas).toHaveLength(3);
    expect(cellParas[0]).toContain('홍길동');
    expect(cellParas[1]).toContain('010-0000');
    expect(cellParas[2]).not.toContain('OOO');
  });

  it('빈 문단의 빈 조각 글자 서식을 이어받는다', async () => {
    const bytes = await buildHwpx(para('1. 개요') + emptyPara('5'));
    const xml = await sectionXml((await fillHwpxAutoSlots(bytes, values({ s1: '본문' }))).bytes);
    expect(xml).toContain('<hp:run charPrIDRef="4"><hp:t>본문</hp:t></hp:run>');
  });

  it('첫 문단은 쪽 나눔을 지키고, 이어 붙인 문단은 끈다', async () => {
    const broken = emptyPara('5').replace('pageBreak="0"', 'pageBreak="1"');
    const bytes = await buildHwpx(para('1. 개요') + broken);
    const xml = await sectionXml((await fillHwpxAutoSlots(bytes, values({ s1: '가\n나' }))).bytes);
    const area = xml.match(/<hp:p [^>]*paraPrIDRef="5"[\s\S]*?<\/hp:p>/g) ?? [];
    expect(area).toHaveLength(2);
    expect(area[0]).toContain('pageBreak="1"');
    expect(area[1]).toContain('pageBreak="0"');
  });

  it('표 칸이 늘면 바깥 문단의 줄 배치 캐시가 지워진다', async () => {
    const bytes = await buildHwpx(tableAt([['담당', '']]) + para('그대로'));
    const before = await sectionXml(bytes);
    expect(count(before, '<hp:linesegarray>')).toBe(4);
    const xml = await sectionXml((await fillHwpxAutoSlots(bytes, values({ s1: '홍길동\n김철수' }))).bytes);
    const afterTable = xml.split('</hp:tbl>')[1];
    expect(afterTable.slice(0, afterTable.indexOf('</hp:p>'))).not.toContain('linesegarray');
    // '담당' 칸과 '그대로' 문단의 캐시는 남는다
    expect(count(xml, '<hp:linesegarray>')).toBe(2);
    expect(xml.match(/<hp:p [^>]*>(?:(?!<\/hp:p>)[\s\S])*그대로[\s\S]*?<\/hp:p>/)![0]).toContain('linesegarray');
  });

  it('채우지 않은 자리는 원래대로, unfilled에 id로 남는다', async () => {
    const body = para('1. 개요') + para('(내용)', '5') + para('2. 일정') + para('○○○', '6') + tableAt([['비고', '']]);
    const bytes = await buildHwpx(body);
    const result = await fillHwpxAutoSlots(bytes, values({ s2: '3월', s9: '없는 자리' }));
    expect(result.filled).toEqual(['s2']);
    expect(result.unfilled).toEqual(['s1', 's3']);
    const xml = await sectionXml(result.bytes);
    expect(xml).toContain(para('(내용)', '5'));
    expect(xml).toContain('3월');
    expect(xml).not.toContain('○○○');
    expect(xml).toContain(emptyPara('7'));
  });

  it('읽기와 채우기의 자리 번호가 같다 — 같은 바이트면 같은 목록', async () => {
    const bytes = await buildHwpx(
      secPrPara() +
        para('1. 개요') +
        emptyPara() +
        tableAt([['성명', '', '소속', '']], { addr: true }) +
        para('가. 세부') +
        para('(내용)') +
        para('2. 일정') +
        emptyPara() +
        tableAt([['구분', '기간'], ['', '']])
    );
    const slots = await readHwpxAutoSlots(bytes);
    expect(await readHwpxAutoSlots(bytes)).toEqual(slots);
    expect(slots.map((s) => `${s.id}:${s.kind}:${s.label}`)).toEqual([
      's1:section:1. 개요',
      's2:cell:성명',
      's3:cell:소속',
      's4:section:가. 세부',
      's5:section:2. 일정',
      's6:cell:구분',
      's7:cell:기간',
    ]);

    const result = await fillHwpxAutoSlots(bytes, new Map(slots.map((s) => [s.id, `값-${s.id}`])));
    expect(result.filled).toEqual(slots.map((s) => s.id));
    const xml = await sectionXml(result.bytes);
    const positions = slots.map((s) => xml.indexOf(`값-${s.id}<`));
    expect(positions.every((p) => p > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // 각 값은 제 이름 뒤에 온다
    for (const s of slots) expect(xml.lastIndexOf(s.label, xml.indexOf(`값-${s.id}<`))).toBeGreaterThan(-1);
  });
});
