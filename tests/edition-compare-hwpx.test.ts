import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import JSZip from 'jszip';
import { compareEditions } from '@/lib/edition-compare';
import {
  buildEditionCompareHwpx,
  changeRowCellsHwpx,
  compareHwpxHeaders,
  editionCompareHwpxFile,
  MAX_HWPX_CHANGES,
  ROWS_PER_TABLE,
} from '@/lib/edition-compare-hwpx';
import { columnWidths, type HwpxTable } from '@/lib/doc-fill/hwpx-table';
import { checkPackage } from '@/lib/work/documents/package-check';
import type { EditionSide } from '@/lib/document-edition-compare';

/**
 * 신구대비표 한글(HWPX) 파일(2026-11-05). 엑셀과 같은 대조 결과를 표준 보고서 양식에 표로 넣는다 —
 * 개정 쪽 바뀐 글은 밑줄, 현행 쪽 지운 글은 취소선(공공기관 신구조문대비표 관례).
 * 한글 2018에서 열기·다시 저장·PDF는 scripts/hancom-verify.ps1로 따로 확인했다(단위 시험은 XML까지만 본다).
 */

const template = readFileSync('assets/templates/report.hwpx');
const OLD: EditionSide = { id: 'o', name: '여비 규정(2025)', effective_from: '2025-01-01', status: 'retired', created_at: null };
const NEW: EditionSide = { id: 'n', name: '여비 규정(2026).hwpx', effective_from: '2026-01-01', status: 'ready', created_at: null };
const comparison = compareEditions(
  ['여비 규정', '제2조(일비) 일비는 1일 20,000원으로 한다.', '제3조(숙박비) 숙박비는 실비로 지급한다.', '부칙'].join('\n'),
  ['여비 규정', '제2조(일비) 일비는 1일 25,000원으로 한다.', '제5조(교통비) 교통비는 철도 운임을 기준으로 한다.', '부칙'].join('\n')
);
const input = (c = comparison) => ({ old: OLD, new: NEW, comparison: c, warnings: ['옛 판: 글자 인식(OCR)으로 읽었습니다'], createdAt: new Date('2026-11-05T03:00:00Z') });

async function xmlOf(bytes: Buffer) {
  const zip = await JSZip.loadAsync(bytes);
  return { section: await zip.file('Contents/section0.xml')!.async('string'), header: await zip.file('Contents/header.xml')!.async('string') };
}

describe('신구대비표 한글 파일', () => {
  it('표준 양식에 표를 넣고, 넣은 글이 모두 들어간 올바른 HWPX다', async () => {
    const bytes = await buildEditionCompareHwpx(template, input());
    const checked = await checkPackage(bytes, {
      format: 'hwpx',
      values: ['신구대비표 — 여비 규정(2026).hwpx', '현행(옛 판)', '개정(새 판)', '제2조(일비)', '(삭제)', '(신설)', '경고 — 옛 판: 글자 인식(OCR)으로 읽었습니다'],
    });
    expect(checked.valid).toBe(true);
    const { section } = await xmlOf(bytes);
    expect((section.match(/<hp:tbl\b/g) ?? []).length).toBe(1);
    // 쓰지 않는 칸 제목은 지운다
    expect(section).not.toContain('추진 경과');
  });

  it('개정 쪽 바뀐 글은 밑줄, 현행 쪽 지운 글은 취소선 글자 서식을 쓴다', async () => {
    const { section, header } = await xmlOf(await buildEditionCompareHwpx(template, input()));
    const charPr = (id: string) => header.match(new RegExp(`<hh:charPr [^>]*id="${id}"[\\s\\S]*?</hh:charPr>`))?.[0] ?? '';
    const runOf = (text: string) => section.match(new RegExp(`<hp:run charPrIDRef="(\\d+)"><hp:t>${text}</hp:t>`))?.[1];
    const ins = runOf('25');
    const del = runOf('20');
    expect(ins && del && ins !== del).toBeTruthy();
    expect(charPr(ins!)).toContain('<hh:underline type="BOTTOM"');
    expect(charPr(ins!)).toContain('<hh:strikeout shape="NONE"');
    expect(charPr(del!)).toContain('<hh:strikeout shape="SOLID"');
    expect(charPr(del!)).toContain('<hh:underline type="NONE"');
    // 지운 조문 전체는 취소선, 새 조문 전체는 밑줄
    expect(runOf('제3조\\(숙박비\\) 숙박비는 실비로 지급한다.')).toBe(del);
    expect(runOf('제5조\\(교통비\\) 교통비는 철도 운임을 기준으로 한다.')).toBe(ins);
    // 목록 개수(itemCnt)가 실제 항목 수와 같다 — 어긋나면 한글이 서식을 잘못 읽는다
    const list = header.match(/<hh:charProperties itemCnt="(\d+)">([\s\S]*?)<\/hh:charProperties>/)!;
    expect(Number(list[1])).toBe((list[2].match(/<hh:charPr\s/g) ?? []).length);
  });

  it('바뀐 문단이 많으면 표를 나누고, 너무 많으면 엑셀로 안내한다', async () => {
    const many = (n: number) =>
      compareEditions(
        Array.from({ length: n }, (_, i) => `제${i + 1}조 금액은 ${1000 + i}원이다.`).join('\n'),
        Array.from({ length: n }, (_, i) => `제${i + 1}조 금액은 ${5000 + i}원이다.`).join('\n')
      );
    const { section } = await xmlOf(await buildEditionCompareHwpx(template, input(many(ROWS_PER_TABLE + 5))));
    expect((section.match(/<hp:tbl\b/g) ?? []).length).toBe(2);
    await expect(buildEditionCompareHwpx(template, input(many(MAX_HWPX_CHANGES + 1)))).rejects.toThrow('엑셀로 내려받아');
    const file = await editionCompareHwpxFile(input(many(MAX_HWPX_CHANGES + 1)), async () => template);
    expect(file).toMatchObject({ ok: false, status: 422 });
  });

  it('바뀐 문단이 없으면 그렇게 적는다', async () => {
    const bytes = await buildEditionCompareHwpx(template, input(compareEditions('가\n나', '가\n나')));
    expect((await checkPackage(bytes, { format: 'hwpx', values: ['바뀐 문단이 없습니다.'] })).valid).toBe(true);
    expect((await xmlOf(bytes)).section).not.toContain('<hp:tbl');
  });

  it('양식 파일이 없으면 503', async () => {
    expect(await editionCompareHwpxFile(input(), async () => null)).toMatchObject({ ok: false, status: 503 });
  });

  it('표 한 줄 — 위치·구분·현행·개정, 칸 글은 표시 조각을 이은 것', () => {
    const changed = comparison.rows.find((r) => r.kind === 'changed')!;
    const { cells, runs } = changeRowCellsHwpx(changed as any);
    expect(cells).toEqual(['제2조(일비)', '고침', '제2조(일비) 일비는 1일 20,000원으로 한다.', '제2조(일비) 일비는 1일 25,000원으로 한다.']);
    expect(runs[2]!.filter((r) => r.mark).map((r) => [r.text, r.mark])).toEqual([['20', 'del']]);
    expect(runs[3]!.filter((r) => r.mark).map((r) => [r.text, r.mark])).toEqual([['25', 'ins']]);
    expect(changeRowCellsHwpx({ kind: 'added', new: '새 조문', location: null }).cells).toEqual(['', '신설', '(신설)', '새 조문']);
  });

  it('파일 이름은 엑셀과 같은 규칙에 .hwpx', () => {
    const h = compareHwpxHeaders('여비 규정(2026).hwpx');
    expect(h['Content-Type']).toBe('application/hwp+zip');
    expect(h['Content-Disposition']).toContain(`filename*=UTF-8''${encodeURIComponent('신구대비_여비 규정(2026).hwpx')}`);
  });
});

describe('표 넣기 — 열 폭 비율', () => {
  const t: HwpxTable = { header: ['위치', '구분', '현행', '개정'], rows: [['제1조', '고침', '아주 긴 글'.repeat(20), '짧음']] };
  it('비율을 주면 그대로 나누고 합은 본문 폭', () => {
    const w = columnWidths({ ...t, widths: [17, 9, 37, 37] }, 40000);
    expect(w.reduce((a, b) => a + b, 0)).toBe(40000);
    expect(w[0]).toBe(6800);
    expect(w[2]).toBe(w[3]);
  });
  it('비율이 열 수와 다르거나 0이면 글 길이로 정한다(예전과 같음)', () => {
    expect(columnWidths({ ...t, widths: [1, 1] }, 40000)).toEqual(columnWidths(t, 40000));
    expect(columnWidths({ ...t, widths: [1, 0, 1, 1] }, 40000)).toEqual(columnWidths(t, 40000));
  });
});

describe('연결', () => {
  const docs = readFileSync('src/app/api/documents/[id]/compare/route.ts', 'utf8');
  const common = readFileSync('src/app/api/super/common-documents/[id]/compare/route.ts', 'utf8');
  const ui = readFileSync('src/components/admin/EditionCompareModal.tsx', 'utf8');
  const config = readFileSync('next.config.mjs', 'utf8');

  it('두 라우트 모두 권한 확인·대조 뒤에 한글 파일을 만든다', () => {
    for (const route of [docs, common]) {
      expect(route.indexOf("get('format') === 'hwpx'")).toBeGreaterThan(route.indexOf('if (!outcome.ok)'));
      expect(route).toContain('compareHwpxHeaders(outcome.data.new.name)');
    }
  });

  it('배포 묶음에 표준 양식이 들어간다(없으면 운영에서 503)', () => {
    expect(config).toContain("'/api/documents/**': ['./assets/templates/**/*']");
    expect(config).toContain("'/api/super/common-documents/**': ['./assets/templates/**/*']");
  });

  it('비교 창에 한글·엑셀 두 단추', () => {
    expect(ui).toContain('${endpoint}?format=hwpx');
    expect(ui).toContain('${endpoint}?format=xlsx');
  });
});
