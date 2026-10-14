import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

/**
 * 0026은 S1 전체의 바탕이다. 여기 규칙이 빠지면 오류 없이 결과만 틀린다
 * (판이 안 남거나, 옛 코드가 만든 비서의 단계가 비거나). 실제 동작은
 * `npm run db:test-agents`가 DB에서 확인하고, 여기서는 규칙이 파일에
 * 들어 있는지만 본다.
 */
const sql = readFileSync('supabase/migrations/0026_agent_tiers.sql', 'utf8');

describe('0026 비서 단계', () => {
  it('파일 안에서 트랜잭션을 열지 않는다', () => {
    // db:migrate가 파일 전체를 한 트랜잭션으로 감싼다. 안에서 COMMIT하면
    // 실패해도 앞부분이 남는다.
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
  });

  it('단계를 기존 is_personal에서 채운다', () => {
    expect(sql).toContain("CASE WHEN COALESCE(is_personal, false) THEN 'personal' ELSE 'official' END");
  });

  it('부서 비서는 공개 범위가 부서여야 한다', () => {
    expect(sql).toContain("CHECK (tier <> 'department' OR visibility = 'department')");
  });

  it('이름 유일성을 단계별로 나눈다', () => {
    // 같은 부서 직원 둘이 같은 이름의 나만의 비서를 못 만들던 문제
    expect(sql).toContain('DROP INDEX IF EXISTS agents_department_name_idx');
    expect(sql).toMatch(/agents_personal_name_idx[\s\S]*\(owner_id, name\)[\s\S]*tier = 'personal'/);
  });

  it('save_agent가 판 번호를 비교한다', () => {
    expect(sql).toContain("'reason', 'conflict'");
    expect(sql).toContain('FOR UPDATE');
  });

  it('양식은 save_agent만 활성화한다', () => {
    // 새 양식 행은 retired 상태로 들어가고 save_agent가 판을 올리며 켠다.
    // 그래야 양식 추가도 판 사본에 남는다.
    expect(sql).toMatch(/retired_at\s+timestamptz\s+DEFAULT now\(\)/);
    expect(sql).toContain("USING ERRCODE = '23514'");
  });

  it('모든 기존 비서에 판 1을 남긴다', () => {
    expect(sql).toContain("'migrated'");
  });

  it('새로 만든 비서는 트리거가 판 1을 남긴다', () => {
    expect(sql).toContain('AFTER INSERT ON agents');
  });
});
