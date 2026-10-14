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

  it('승인 대기 비서에 승인 판 번호를 채운다', () => {
    // 비어 있으면 승인할 때 판 확인을 건너뛴다. 0026 이전 신청과, 배포
    // 사이 옛 신청 코드(approval_status만 바꾼다)가 남긴 신청 모두.
    expect(sql).toMatch(
      /UPDATE agents SET approval_version = version\s+WHERE approval_status = 'pending' AND approval_version IS NULL/
    );
    const trigger = sql.slice(
      sql.indexOf('CREATE OR REPLACE FUNCTION agents_sync_legacy_columns'),
      sql.indexOf('CREATE TRIGGER trg_agents_sync_legacy')
    );
    expect(trigger).toContain('NEW.approval_version := NEW.version');
    expect(trigger).toMatch(/OLD\.approval_status IS DISTINCT FROM 'pending'/);
  });

  it('자동 켜기는 사람이 고친 비서로 남기지 않는다', () => {
    // save_agent는 p_actor가 있으면 updated_by를 바꾼다. 그러면 기본 비서
    // 갱신(--update)이 그 비서를 '관리자가 고친 것'으로 보고 건너뛴다.
    const fn = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION enable_agent_capability'));
    expect(fn).toMatch(/PERFORM save_agent\([\s\S]*?NULL, 'settings'/);
    expect(fn).toContain("'actor', p_actor");
  });

  it('나만의 비서 이름 인덱스 전에 겹치는 이름을 정리한다', () => {
    // 예전 유일성은 부서 단위라 같은 사람이 부서를 옮기며 같은 이름을 둘 가질 수 있었다.
    // 정리 없이 인덱스를 만들면 마이그레이션 전체가 실패한다.
    const dedupe = sql.indexOf('row_number()');
    expect(dedupe).toBeGreaterThan(-1);
    expect(dedupe).toBeLessThan(sql.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS agents_personal_name_idx'));
    expect(sql).toMatch(/PARTITION BY owner_id, name\s+ORDER BY created_at, id/);
  });

  it('단계 변경은 공개 범위를 검사한다', () => {
    expect(sql).toMatch(/p_visibility IS NULL OR p_visibility NOT IN \('organization', 'department'\)/);
  });

  it('판 사본의 양식 순서가 안정적이다', () => {
    expect(sql).toContain('ORDER BY t.created_at, t.id');
  });
});
