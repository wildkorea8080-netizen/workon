import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

/**
 * 이용통계의 모델·활동별 내역.
 *
 * 합계만 보면 "이 부서가 비싸다"까지는 알아도 **왜 비싼지**를 모른다.
 * Opus를 쓰고 있는 것과 Haiku를 많이 쓰는 것은 대응이 다르다.
 * 기록은 usage_logs.details에 이미 있었고 화면에 내지 않았을 뿐이다.
 */

const ROUTE = 'src/app/api/admin/usage-summary/route.ts';
const src = readFileSync(ROUTE, 'utf8');

describe('집계', () => {
  it('모델별·활동별로 나눈다', () => {
    expect(src).toContain('models: Breakdown[]');
    expect(src).toContain('actions: Breakdown[]');
  });

  it('옛 로그의 모델을 기본 모델로 추정하지 않는다', () => {
    // details.model이 없는 2026-08 이전 로그는 LEGACY 상수로 묶는다.
    // 기본 모델(DEFAULT_MODEL_ID)로 묶으면 기본 모델을 바꾸는 순간
    // 과거 집계가 소급해서 달라진다.
    expect(src).toContain('LEGACY_PRICING_MODEL_ID');
    expect(src).not.toContain('DEFAULT_MODEL_ID');
  });

  it('토큰을 쓰지 않은 활동은 모델별에 넣지 않는다', () => {
    // 비서 생성·로그인 같은 기록에 모델을 붙이면 없는 사용량이 생긴다
    const at = src.indexOf('bump(row.models');
    expect(at).toBeGreaterThan(-1);
    const before = src.slice(Math.max(0, at - 400), at);
    expect(before).toContain('input_tokens');
  });
});

describe('CSV', () => {
  it('모델 열이 있다', () => {
    // 감사에서 "어떤 데이터가 어느 모델로 갔는가"를 실제로 묻는다
    expect(src).toContain("'모델'");
  });

  it('합계 줄과 모델 줄을 섞지 않는다', () => {
    // 두 층위를 한 파일에 섞으면 비용 열을 통째로 더하는 사람이 반드시
    // 있고, 그 합이 두 배가 된다. 모델 줄만 두면 열의 합이 곧 총액이다.
    const at = src.indexOf("const headers = ['구분'");
    const block = src.slice(at, at + 1600);
    expect(block).toContain('flatMap');
    // 합계 행을 따로 덧붙이지 않는다
    expect(block).not.toContain('총합');
  });

  it('토큰을 쓰지 않은 행도 빠뜨리지 않는다', () => {
    const at = src.indexOf("const headers = ['구분'");
    const block = src.slice(at, at + 1600);
    expect(block).toContain('(해당 없음)');
  });

  it('UTF-8 BOM을 유지한다', () => {
    // 없으면 Excel에서 한글이 깨진다
    expect(src).toContain('﻿');
  });
});

describe('화면', () => {
  const ui = readFileSync('src/components/admin/UsageSummary.tsx', 'utf8');

  it('눌러서 펴는 방식이다', () => {
    // 태블릿에는 호버가 없고, 툴팁 안의 표는 읽기도 옮겨 적기도 어렵다
    expect(ui).toContain('setOpenKey');
    expect(ui).toContain('BreakdownList');
  });

  it('모델별과 활동별을 함께 낸다', () => {
    expect(ui).toContain('모델별');
    expect(ui).toContain('활동별');
  });
});
