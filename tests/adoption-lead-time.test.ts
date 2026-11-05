import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import pg from 'pg';
import { adoptionCsv, adoptionRows, formatAdoptionChange, formatAdoptionValue, readAdoptionStats } from '@/lib/adoption-report';

/** 월별 도입 현황의 '완료까지 걸린 시간(중앙값)'(2026-11-06, 0066) — 기록된 시간만, 없으면 0이 아니라 '—' */

describe('읽기·표기', () => {
  it('없거나 이상하면 null(—), 숫자 글자는 숫자로', () => {
    expect(readAdoptionStats({}).completed_median_hours).toBeNull();
    expect(readAdoptionStats({ completed_median_hours: null }).completed_median_hours).toBeNull();
    expect(readAdoptionStats({ completed_median_hours: 'abc' }).completed_median_hours).toBeNull();
    expect(readAdoptionStats({ completed_median_hours: -2 }).completed_median_hours).toBeNull();
    expect(readAdoptionStats({ completed_median_hours: '26.25' }).completed_median_hours).toBe(26.25);
    expect(readAdoptionStats({ completed_median_hours: 0 }).completed_median_hours).toBe(0);
  });

  it('보고서 줄 — 업무 작업 묶음, 시간 표기·전월 대비(줄면 △), 비교할 수 없으면 —', () => {
    const rows = adoptionRows(readAdoptionStats({ completed_median_hours: 20 }), readAdoptionStats({ completed_median_hours: 26.25 }));
    const row = rows.find((r) => r.key === 'completed_median_hours')!;
    expect(row).toMatchObject({ group: '업무 작업', label: '완료까지 걸린 시간(중앙값)', unit: 'hours', value: 20, previous: 26.25 });
    expect(row.note).toContain('기다린 시간도');
    expect(formatAdoptionValue('hours', 20)).toBe('20.0시간');
    expect(formatAdoptionValue('hours', null)).toBe('—');
    expect(formatAdoptionChange(row)).toBe('△6.3시간');
    expect(formatAdoptionChange({ ...row, previous: null })).toBe('—');
    expect(formatAdoptionChange({ ...row, previous: 20 })).toBe('0시간');
    expect(adoptionCsv('2026-11', '2026-10', rows)).toContain('완료까지 걸린 시간(중앙값),20.0시간,26.3시간,△6.3시간');
  });

  it('0066은 0056과 같은 이름·인자로 다시 정의하고 칸 하나만 더한다, 실행 권한 다시 걸기', () => {
    const sql = readFileSync('supabase/migrations/0066_adoption_lead_time.sql', 'utf8');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.adoption_report(');
    expect(sql).toContain("'completed_median_hours', (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM t.approved_at - t.created_at) / 3600.0)");
    expect(sql).toContain("'completed_versions',");
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.adoption_report(uuid, uuid[], timestamptz, timestamptz) TO service_role');
  });
});

const url = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!url)('완료까지 걸린 시간 (0066, 시험 DB)', () => {
  let db: pg.Client;
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(url!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: url });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });

  it('그 달에 완료한 작업만의 중앙값, 완료 작업이 없으면 null', async () => {
    const sql = readFileSync('supabase/migrations/0066_adoption_lead_time.sql', 'utf8');
    await db.query(sql);
    await db.query(sql);
    await db.query('BEGIN');
    try {
      const org = (await db.query("INSERT INTO organizations (name) VALUES ('시간 시험 기관') RETURNING id")).rows[0].id;
      const dept = (await db.query("INSERT INTO departments (name, slug, organization_id) VALUES ('총무과', 'lead-time', $1) RETURNING id", [org])).rows[0].id;
      const owner = (await db.query("INSERT INTO users (email, department_id, is_active) VALUES ('lead@test.invalid', $1, true) RETURNING id", [dept])).rows[0].id;
      const task = (created: string, approved: string | null) =>
        db.query("INSERT INTO work_tasks (organization_id, department_id, owner_id, workflow_key, workflow_version, title, created_at, approved_at) VALUES ($1, $2, $3, 'report', '1', '시험', $4, $5)", [org, dept, owner, created, approved]);
      await task('2026-10-01T00:00:00Z', '2026-10-01T02:00:00Z'); // 2시간
      await task('2026-10-02T00:00:00Z', '2026-10-02T10:00:00Z'); // 10시간
      await task('2026-10-03T00:00:00Z', '2026-10-05T00:00:00Z'); // 48시간
      await task('2026-09-01T00:00:00Z', '2026-09-20T00:00:00Z'); // 지난달 완료 — 빠짐
      await task('2026-10-04T00:00:00Z', null); // 아직 완료 안 함 — 빠짐
      const call = async (from: string, to: string) => (await db.query('SELECT adoption_report($1, $2, $3, $4) AS r', [org, [dept], from, to])).rows[0].r;
      const oct = await call('2026-09-30T15:00:00Z', '2026-10-31T15:00:00Z');
      expect(Number(oct.completed_median_hours)).toBe(10);
      expect(oct.tasks_completed).toBe(3);
      const nov = await call('2026-10-31T15:00:00Z', '2026-11-30T15:00:00Z');
      expect(nov.completed_median_hours).toBeNull();
      expect(readAdoptionStats(nov).completed_median_hours).toBeNull();
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
