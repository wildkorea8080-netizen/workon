import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { csvCell, csvLine, CSV_BOM } from '@/lib/csv-cell';

/**
 * 2026-11-18 — CSV 내보내기의 수식 주입(OWASP 'CSV Injection').
 * `=`·`+`·`-`·`@`·탭·CR로 시작하는 칸은 엑셀이 수식으로 실행한다(큰따옴표로 감싸도). 직원 이름·비서 이름·질문 같은 사용자가 정한 글이
 * 감사 기록·이용통계·직원 등록 결과·슈퍼관리자 로그 CSV에 실렸는데, 다섯 곳이 각자 감쌌고 그중 넷이 막지 않았다.
 */

describe('csvCell', () => {
  it('수식으로 읽힐 글 앞에 작은따옴표', () => {
    expect(csvCell('=HYPERLINK("http://x","click")')).toBe(`"'=HYPERLINK(""http://x"",""click"")"`);
    expect(csvCell('+1+1')).toBe("'+1+1");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('-2+3')).toBe("'-2+3");
    expect(csvCell('\t=1')).toBe("'\t=1");
    expect(csvCell('\r=1')).toBe(`"'\r=1"`);
  });

  it('평범한 숫자·홑 "-"는 그대로(음수 글도), 숫자 값은 숫자 그대로', () => {
    expect(csvCell('-5')).toBe('-5');
    expect(csvCell('-1,234.5')).toBe('"-1,234.5"');
    expect(csvCell('-')).toBe('-');
    expect(csvCell(-12)).toBe('-12');
    expect(csvCell(3.5)).toBe('3.5');
    expect(csvCell(Number.NaN)).toBe('');
  });

  it('쉼표·큰따옴표·줄바꿈이 있으면 감싼다, 없으면 그대로', () => {
    expect(csvCell('홍길동, 주무관')).toBe('"홍길동, 주무관"');
    expect(csvCell('말 "그대로"')).toBe('"말 ""그대로"""');
    expect(csvCell('줄\n바꿈')).toBe('"줄\n바꿈"');
    expect(csvCell('총무과')).toBe('총무과');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('한 줄·BOM', () => {
    expect(csvLine(['이름', '=1+1', 3, null])).toBe("이름,'=1+1,3,");
    expect(CSV_BOM).toBe('﻿');
  });
});

describe('원본 — CSV를 만드는 곳은 모두 csv-cell을 쓴다', () => {
  const files = [
    'src/app/api/admin/audit-logs/route.ts',
    'src/app/api/admin/usage-summary/route.ts',
    'src/lib/adoption-report.ts',
    'src/lib/rag-eval.ts',
    'src/lib/department-adoption.ts',
    'src/components/admin/CsvRegisterTab.tsx',
    'src/app/super/logs/page.tsx',
    'src/app/super/usage/page.tsx',
  ];

  for (const f of files) {
    it(`${f} — csv-cell을 가져온다`, () => {
      expect(readFileSync(f, 'utf8')).toContain("from '@/lib/csv-cell'");
    });
  }

  it('직원 등록 결과는 칸을 그냥 쉼표로 잇지 않는다(쉼표가 든 이름이 칸을 밀었다)', () => {
    const src = readFileSync('src/components/admin/CsvRegisterTab.tsx', 'utf8');
    expect(src).not.toContain('`${r.직원이름},${r.이메일}');
    expect(src).toContain('csvLine([r.직원이름, r.이메일, r.부서명');
  });

  it('슈퍼관리자 로그는 JSON.stringify로 칸을 만들지 않는다(CSV 감싸기가 아니다)', () => {
    expect(readFileSync('src/app/super/logs/page.tsx', 'utf8')).not.toContain('JSON.stringify(r[k]');
  });

  /** 감싸기 꼴을 써도 되는 곳 — 이유와 함께 */
  const ALLOWED = new Map<string, string>([
    ['src/lib/rag-eval.ts', "ragEvalSetText — 엑셀로 내려받는 CSV가 아니라 평가 세트 입력칸에 되돌려 넣는 탭 구분 글이다. 앞에 '를 붙이면 다시 읽을 때 질문이 바뀐다"],
  ]);

  it('src 어디에도 CSV 칸을 따로 감싸는 꼴이 다시 생기지 않는다(이유 적은 곳만)', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && !p.replace(/\\/g, '/').endsWith('src/lib/csv-cell.ts')) {
          const src = readFileSync(p, 'utf8');
          // CSV 칸 감싸기의 꼴: 큰따옴표를 두 개로 바꾸는 replace
          const rel = p.replace(/\\/g, '/');
          if (/replace\(\/"\/g, '""'\)/.test(src) && !ALLOWED.has(rel)) offenders.push(rel);
        }
      }
    };
    walk('src');
    expect(offenders).toEqual([]);
  });
});
