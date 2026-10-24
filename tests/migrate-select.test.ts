import { describe, it, expect } from 'vitest';
// @ts-expect-error — 순수 .mjs 모듈(타입 선언 없음)
import { selectPending, MANUAL_ONLY, manualOnlyNotice } from '../scripts/migrate-select.mjs';

const files = ['0026_a.sql', '0027_b.sql', '0028_c.sql'];
const files32 = [...files, '0032_d.sql'];

describe('마이그레이션 선택', () => {
  it('0028·0032는 수동 전용으로 등록돼 있다', () => {
    expect(MANUAL_ONLY).toEqual(['0028', '0032']);
  });

  it('번호 없이 돌리면 0032(임베딩 칸 비우기 — 되돌릴 수 없음)도 건너뛰고 알린다', () => {
    const r = selectPending(files32, new Set(['0026', '0027', '0028']), undefined);
    expect(r.pending).toEqual([]);
    expect(r.skippedManual).toEqual(['0032_d.sql']);
  });

  it('0032는 번호로 지정하면 적용한다', () => {
    const r = selectPending(files32, new Set(['0026', '0027', '0028']), '0032');
    expect(r.pending).toEqual(['0032_d.sql']);
  });

  it('안내 문구는 0028과 0032의 선행 조건을 각각 알린다', () => {
    const msg = manualOnlyNotice(['0028_c.sql', '0032_d.sql']);
    const [a, b] = msg.split(String.fromCharCode(10));
    expect(a).toContain('0028');
    expect(a).toContain('코드 배포');
    expect(b).toContain('0032');
    expect(b).toContain('noda:migrate');
    expect(b).toContain('되돌릴 수 없');
    expect(b).toContain('db:migrate -- 0032');
  });

  it('번호 없이 돌리면 미적용 중 0028은 건너뛰고 따로 알린다', () => {
    const r = selectPending(files, new Set(['0026']), undefined);
    expect(r.pending).toEqual(['0027_b.sql']);
    expect(r.skippedManual).toEqual(['0028_c.sql']);
  });

  it('0028이 이미 적용돼 있으면 안내하지 않는다', () => {
    const r = selectPending(files, new Set(['0026', '0027', '0028']), undefined);
    expect(r.pending).toEqual([]);
    expect(r.skippedManual).toEqual([]);
  });

  it('번호로 지정하면 0028도 적용한다', () => {
    const r = selectPending(files, new Set(['0026', '0027']), '0028');
    expect(r.pending).toEqual(['0028_c.sql']);
    expect(r.skippedManual).toEqual([]);
  });

  it('번호 지정은 적용돼 있어도 다시 고른다(재적용)', () => {
    const r = selectPending(files, new Set(['0027']), '0027');
    expect(r.pending).toEqual(['0027_b.sql']);
  });

  it('수동 전용이 아닌 것은 평소대로 전부 고른다', () => {
    const r = selectPending(files, new Set(), undefined);
    expect(r.pending).toEqual(['0026_a.sql', '0027_b.sql']);
  });
});
