import { describe, it, expect } from 'vitest';
import { MAX_TABLE_COLS, MAX_TABLE_ROWS } from '@/lib/attachments/limits';
import { SCAN_WARNING, isLikelyScanned, parsedToExtract } from '@/lib/attachments/scan';
import type { NodaParsedDocument } from '@/lib/noda';

function doc(over: Partial<NodaParsedDocument> = {}): NodaParsedDocument {
  return { readable: true, reason: null, pages: 1, blocks: [], tables: [], ...over };
}

describe('parsedToExtract — 글', () => {
  it('글은 꼬리글을 빼고 읽는 차례대로 줄바꿈으로 잇는다', () => {
    const out = parsedToExtract(
      doc({
        pages: 2,
        blocks: [
          { type: 'heading', text: '제1장 총칙', page: 1 },
          { type: 'paragraph', text: '첫 문단입니다.', page: 1 },
          { type: 'footer', text: '- 1 -', page: 1 },
          { type: 'table', text: '구분 예산', page: 2 },
          { type: 'paragraph', text: '', page: 2 },
          { type: 'paragraph', text: '마지막 문단', page: 2 },
          { type: 'footer', text: '- 2 -', page: 2 },
        ],
      })
    );
    expect(out.text).toBe('제1장 총칙\n첫 문단입니다.\n구분 예산\n마지막 문단');
    expect(out.pages).toBe(2);
  });

  it('글이 없거나 글자가 아닌 블록은 건너뛴다', () => {
    const out = parsedToExtract(doc({ blocks: [{ type: 'paragraph' }, { text: null }, { text: '있음' }] }));
    expect(out.text).toBe('있음');
  });
});

describe('parsedToExtract — 표', () => {
  it('병합 칸은 주인 칸에만 값, 덮인 칸은 null, merges에 범위', () => {
    const out = parsedToExtract(
      doc({
        tables: [
          {
            id: 'x',
            n_rows: 2,
            n_cols: 2,
            caption: '(단위: 천원)',
            cells: [
              { r: 0, c: 0, rowspan: 2, text: '구분' },
              { r: 0, c: 1, text: '예산' },
              { r: 1, c: 1, text: '100' },
            ],
          },
        ],
      })
    );
    expect(out.tables).toHaveLength(1);
    const t = out.tables[0];
    expect(t.id).toBe('t1');
    expect(t.title).toBe('표 1');
    expect(t.caption).toBe('(단위: 천원)');
    expect(t.cells).toEqual([
      ['구분', '예산'],
      [null, '100'],
    ]);
    expect(t.merges).toEqual([{ row: 0, col: 0, rows: 2, cols: 1 }]);
  });

  it('표는 번호가 이어지고 칸이 없는 표는 건너뛴다', () => {
    const cell = (text: string) => ({ r: 0, c: 0, text });
    const out = parsedToExtract(
      doc({
        tables: [
          { id: 'a', n_rows: 1, n_cols: 1, cells: [cell('가')] },
          { id: 'b', n_rows: 0, n_cols: 0, cells: [] },
          { id: 'c', n_rows: 1, n_cols: 1, cells: [cell('나')] },
        ],
      })
    );
    expect(out.tables.map((t) => [t.id, t.title])).toEqual([
      ['t1', '표 1'],
      ['t2', '표 2'],
    ]);
  });

  it('격자 크기는 칸에서 정한다 — n_rows·n_cols가 이상해도 터지지 않는다', () => {
    const out = parsedToExtract(
      doc({
        tables: [
          {
            id: 'a',
            // 글자·음수·소수는 믿지 않는다
            n_rows: '1000000' as unknown as number,
            n_cols: -3,
            cells: [
              { r: 0, c: 0, text: '구분' },
              { r: 0, c: 1, text: '값' },
              { r: 1, c: 0, text: '총무과' },
              { r: 1, c: 1, text: '10' },
            ],
          },
        ],
      })
    );
    expect(out.tables[0].cells).toEqual([
      ['구분', '값'],
      ['총무과', '10'],
    ]);
  });

  it('쓸 수 없는 칸 주소·병합 값은 버리거나 1로 본다', () => {
    const out = parsedToExtract(
      doc({
        tables: [
          {
            id: 'a',
            n_rows: 2,
            n_cols: 2,
            cells: [
              { r: 0, c: 0, text: '가', rowspan: 0, colspan: 1.5 },
              { r: 0, c: 1, text: '나', rowspan: -2, colspan: '3' as unknown as number },
              { r: -1, c: 0, text: '버림' },
              { r: 1.5, c: 0, text: '버림' },
              { r: 1, c: 0, text: '다' },
            ],
          },
        ],
      })
    );
    const t = out.tables[0];
    expect(t.cells).toEqual([
      ['가', '나'],
      ['다', null],
    ]);
    expect(t.merges).toEqual([]);
  });

  it('상한을 넘는 표는 잘라 읽고 원래 크기와 경고를 남긴다', () => {
    const out = parsedToExtract(
      doc({
        tables: [
          {
            id: 'a',
            n_rows: MAX_TABLE_ROWS + 5,
            n_cols: MAX_TABLE_COLS + 2,
            cells: [
              { r: 0, c: 0, text: '머리' },
              { r: MAX_TABLE_ROWS + 4, c: 0, text: '범위 밖' },
              { r: 0, c: MAX_TABLE_COLS + 1, text: '범위 밖' },
            ],
          },
        ],
      })
    );
    const t = out.tables[0];
    expect(t.cells).toHaveLength(MAX_TABLE_ROWS);
    expect(t.cells[0]).toHaveLength(MAX_TABLE_COLS);
    expect(t.truncated).toEqual({ rows: MAX_TABLE_ROWS + 5, cols: MAX_TABLE_COLS + 2 });
    expect(out.warnings.join('\n')).toContain('표 1: 행');
    expect(out.warnings.join('\n')).toContain('표 1: 열');
  });

  it('병합이 칸이 있는 범위 밖으로 번지면 그 범위 안으로 줄인다', () => {
    const out = parsedToExtract(
      doc({
        tables: [
          {
            id: 'a',
            n_rows: 2,
            n_cols: 3,
            cells: [
              { r: 0, c: 0, text: '합침', rowspan: 5 },
              { r: 1, c: 2, text: '끝' },
            ],
          },
        ],
      })
    );
    // 원점이 가장 먼 칸은 (1,2) → 격자는 2행 3열, 병합은 그 안으로
    expect(out.tables[0].cells).toEqual([
      ['합침', null, null],
      [null, null, '끝'],
    ]);
    expect(out.tables[0].merges).toEqual([{ row: 0, col: 0, rows: 2, cols: 1 }]);
  });

  it('병합 안에 놓인 칸은 값을 덮어쓰지 않고 건너뛴다 — 도착 순서와 무관', () => {
    const owner = { r: 1, c: 0, rowspan: 2, text: '100' };
    const stray = { r: 2, c: 0, text: '100' };
    for (const cells of [[owner, stray], [stray, owner]]) {
      const out = parsedToExtract(doc({ tables: [{ id: 'a', n_rows: 3, n_cols: 1, cells }] }));
      const t = out.tables[0];
      expect(t.cells[1][0]).toBe('100');
      expect(t.cells[2][0]).toBeNull();
      expect(t.merges).toEqual([{ row: 1, col: 0, rows: 2, cols: 1 }]);
      expect(out.warnings).toContain('표 1: 병합 안에 놓인 칸 1개를 건너뛰었습니다');
    }
  });

  it('병합 안에 놓인 칸의 글이 비어 있으면 건너뛰어도 경고하지 않는다', () => {
    for (const text of [null, '', '  ']) {
      const out = parsedToExtract(
        doc({
          tables: [
            {
              id: 'a',
              n_rows: 2,
              n_cols: 1,
              cells: [
                { r: 0, c: 0, rowspan: 2, text: '합침' },
                { r: 1, c: 0, text },
              ],
            },
          ],
        })
      );
      expect(out.tables[0].cells).toEqual([['합침'], [null]]);
      expect(out.warnings.filter((w) => w.includes('병합 안에 놓인'))).toEqual([]);
    }
  });

  it('같은 자리에 두 칸이 오면 앞의 것만 둔다', () => {
    const out = parsedToExtract(
      doc({ tables: [{ id: 'a', n_rows: 1, n_cols: 1, cells: [{ r: 0, c: 0, text: '앞' }, { r: 0, c: 0, text: '뒤' }] }] })
    );
    expect(out.tables[0].cells).toEqual([['앞']]);
    expect(out.warnings).toContain('표 1: 병합 안에 놓인 칸 1개를 건너뛰었습니다');
  });

  it('merges 안에 겹치는 범위를 기록하지 않는다', () => {
    const out = parsedToExtract(
      doc({
        tables: [
          {
            id: 'a',
            n_rows: 2,
            n_cols: 2,
            cells: [
              { r: 0, c: 1, rowspan: 2, text: 'A' },
              { r: 1, c: 0, colspan: 2, text: 'B' },
            ],
          },
        ],
      })
    );
    const m = out.tables[0].merges;
    const covered = new Set<string>();
    for (const x of m) {
      for (let r = x.row; r < x.row + x.rows; r += 1) {
        for (let c = x.col; c < x.col + x.cols; c += 1) {
          expect(covered.has(`${r},${c}`)).toBe(false);
          covered.add(`${r},${c}`);
        }
      }
    }
    expect(out.tables[0].cells).toEqual([
      [null, 'A'],
      ['B', null],
    ]);
  });

  it('칸 하나의 엄청난 rowspan·colspan이 격자나 잘림 경고를 부풀리지 않는다', () => {
    const out = parsedToExtract(
      doc({
        tables: [
          {
            id: 'a',
            n_rows: 1_000_000_000,
            n_cols: 1_000_000_000,
            cells: [
              { r: 0, c: 0, text: '머리', rowspan: 1_000_000_000, colspan: 1_000_000_000 },
              { r: 1, c: 1, text: '끝' },
            ],
          },
        ],
      })
    );
    const t = out.tables[0];
    expect(t.cells).toHaveLength(2);
    expect(t.cells[0]).toHaveLength(2);
    expect(t.truncated).toBeUndefined();
    expect(out.warnings.join(' ')).not.toContain('개 중');
  });

  it('멀리 떨어진 엉뚱한 칸 하나는 있는 그대로 잘림으로 알린다', () => {
    const out = parsedToExtract(
      doc({ tables: [{ id: 'a', n_rows: 0, n_cols: 0, cells: [{ r: 0, c: 0, text: '가' }, { r: MAX_TABLE_ROWS + 9, c: 0, text: '멀리' }] }] })
    );
    expect(out.tables[0].truncated).toEqual({ rows: MAX_TABLE_ROWS + 10 });
  });
});

describe('isLikelyScanned', () => {
  it('페이지당 50자 미만이면 스캔', () => {
    expect(isLikelyScanned('', 3)).toBe(true);
    expect(isLikelyScanned('가'.repeat(100), 3)).toBe(true);
    expect(isLikelyScanned('가'.repeat(150), 3)).toBe(false);
    expect(isLikelyScanned(' \n ', 1)).toBe(true);
  });

  it('쪽수를 모르면 스캔으로 보지 않는다', () => {
    expect(isLikelyScanned('', 0)).toBe(false);
  });
});

describe('SCAN_WARNING', () => {
  it('문구가 정해져 있다', () => {
    expect(SCAN_WARNING).toBe('글자 층이 없는 PDF라 글자 인식(OCR)으로 읽었습니다 — 숫자·글자가 원문과 다를 수 있습니다');
  });
});
