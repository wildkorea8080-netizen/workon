import { describe, it, expect } from 'vitest';
import { fallbackOutline, fillFallback } from '@/lib/doc-fill/fallback';
import { DocFillError } from '@/lib/doc-fill/errors';
import { extractTextFromHwp } from '@/lib/hwp';
import { buildHwpx, para } from './fixtures/hwpx';
import { buildDocx, wp } from './fixtures/docx';

const REPORT_LABELS = ['제목', '작성일', '작성부서', '개요', '추진 경과', '주요 내용', '향후 계획', '건의 사항'];
const reportTemplate = () => buildHwpx(REPORT_LABELS.map((l) => para(`{{${l}}}`)).join(''));

describe('대체 경로 목차', () => {
  it('HWPX 본문에서 번호 제목만 목차로', async () => {
    const bytes = await buildHwpx(para('1. 사업 개요') + para('본문 글') + para('2. 추진 일정'));
    expect(await fallbackOutline(bytes, 'hwpx')).toEqual([
      { label: '1. 사업 개요', level: 2 },
      { label: '2. 추진 일정', level: 2 },
    ]);
  });

  it('같은 제목은 한 번만 남긴다', async () => {
    const bytes = await buildHwpx(para('1. 개요') + para('글') + para('1. 개요'));
    expect(await fallbackOutline(bytes, 'hwpx')).toEqual([{ label: '1. 개요', level: 2 }]);
  });

  it('번호 제목이 없으면 본문 하나', async () => {
    const bytes = await buildHwpx(para('그냥 글입니다') + para('또 글'));
    expect(await fallbackOutline(bytes, 'hwpx')).toEqual([{ label: '본문', level: 2 }]);
  });

  it('DOCX 본문에서도 목차', async () => {
    const bytes = await buildDocx(wp('1. 사업 개요') + wp('본문 글') + wp('2. 추진 일정'));
    expect(await fallbackOutline(bytes, 'docx')).toEqual([
      { label: '1. 사업 개요', level: 2 },
      { label: '2. 추진 일정', level: 2 },
    ]);
  });

  it('깨진 파일은 이유를 돌려준다', async () => {
    const junk = Buffer.from('이건 양식이 아닙니다');
    await expect(fallbackOutline(junk, 'hwpx')).rejects.toBeInstanceOf(DocFillError);
    await expect(fallbackOutline(junk, 'hwp')).rejects.toBeInstanceOf(DocFillError);
    await expect(fallbackOutline(junk, 'docx')).rejects.toBeInstanceOf(DocFillError);
    await expect(fallbackOutline(junk, 'hwpx')).rejects.toThrow('양식의 본문을 읽지 못해 목차를 만들 수 없습니다.');
  });
});

describe('표준 보고서 채우기', () => {
  it('표준 보고서에 제목과 항목을 채우고 나머지 표시는 비운다', async () => {
    const outline = [{ label: '1. 사업 개요' }, { label: '2. 추진 일정' }];
    const values = new Map([[0, '사업은 올해 시작했다.\n예산은 확보됐다.']]);
    const r = await fillFallback(await reportTemplate(), '2026년 사업 보고', outline, values);
    const text = await extractTextFromHwp(r.bytes, 'out.hwpx');
    expect(text).toContain('2026년 사업 보고');
    expect(text).toContain('1. 사업 개요');
    expect(text).toContain('사업은 올해 시작했다.');
    expect(text).toContain('예산은 확보됐다.');
    expect(text).toContain('2. 추진 일정');
    expect(text).not.toContain('{{');
    expect(r.filled).toEqual(['1. 사업 개요']);
    expect(r.unfilled).toEqual(['2. 추진 일정']);
  });

  it('항목 이름 줄 다음에 그 항목 글이 목차 순서대로 온다', async () => {
    const outline = [{ label: 'A' }, { label: 'B' }];
    const values = new Map([[1, 'b 글'], [0, 'a 글']]);
    const r = await fillFallback(await reportTemplate(), '제목', outline, values);
    const text = await extractTextFromHwp(r.bytes, 'out.hwpx');
    const idx = ['A', 'a 글', 'B', 'b 글'].map((s) => text.indexOf(s));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((x, y) => x - y)).toEqual(idx);
    expect(r.filled).toEqual(['A', 'B']);
    expect(r.unfilled).toEqual([]);
  });

  it('양식에 {{주요 내용}} 표시가 없으면 조용히 버리지 않고 실패한다', async () => {
    const bad = await buildHwpx(REPORT_LABELS.filter((l) => l !== '주요 내용').map((l) => para(`{{${l}}}`)).join(''));
    await expect(fillFallback(bad, '제목', [{ label: 'A' }], new Map([[0, '글']]))).rejects.toThrow(
      '기본 보고서 양식에 {{제목}}·{{주요 내용}} 표시가 없어 채울 수 없습니다.'
    );
    await expect(fillFallback(bad, '제목', [{ label: 'A' }], new Map())).rejects.toBeInstanceOf(DocFillError);
  });

  it('공백뿐인 값은 채운 것으로 치지 않고 줄도 쓰지 않는다', async () => {
    const r = await fillFallback(await reportTemplate(), '제목', [{ label: 'A' }, { label: 'B' }], new Map([[0, '  \n '], [1, '글']]));
    expect(r.filled).toEqual(['B']);
    expect(r.unfilled).toEqual(['A']);
  });
});

describe('대체 목차 — 개조식 글머리(최종 보강)', () => {
  it('○·●·-·– 글머리는 목차가 아니다 — 번호 제목만', async () => {
    const bytes = await buildHwpx(
      para('1. 추진 배경') +
        para('○ 디지털 전환 가속화') +
        para('- 정부 혁신 과제 반영') +
        para('2. 추진 내용') +
        para('● 민원 서비스 개선') +
        para('– 세부 일정') +
        para('3. 향후 계획') +
        para('○ 단계별 확대')
    );
    expect((await fallbackOutline(bytes, 'hwpx')).map((o) => o.label)).toEqual(['1. 추진 배경', '2. 추진 내용', '3. 향후 계획']);
  });
});
