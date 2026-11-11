import { readFileSync } from 'fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { adoptionCsv, adoptionRows, formatAdoptionValue, readAdoptionStats } from '@/lib/adoption-report';

/** 월별 도입 현황의 '줄인 시간(자기 신고)'(2026-11-10, 0083) — 직원이 고른 값의 합·고른 답 수, 없으면 0이 아니라 '—', 추정치 아님을 밝힌다 */

describe('읽기·표기', () => {
  it('칸이 없으면(0083 전) null — 0으로 보이지 않게', () => {
    const s = readAdoptionStats({ chat_messages: 3 });
    expect(s.saved_minutes_reported).toBeNull();
    expect(s.saved_reports).toBeNull();
    const row = adoptionRows(s, s).find((r) => r.key === 'saved_hours_reported')!;
    expect(formatAdoptionValue(row.unit, row.value)).toBe('—');
  });
  it('합은 시간으로, 고른 답 수는 건으로, 이상한 값은 null', () => {
    const cur = readAdoptionStats({ saved_minutes_reported: 270, saved_reports: 6 });
    const prev = readAdoptionStats({ saved_minutes_reported: 90, saved_reports: '2' });
    const rows = adoptionRows(cur, prev);
    const hours = rows.find((r) => r.key === 'saved_hours_reported')!;
    expect(hours).toMatchObject({ group: '자기 신고', value: 4.5, previous: 1.5 });
    expect(formatAdoptionValue('hours', hours.value)).toBe('4.5시간');
    expect(rows.find((r) => r.key === 'saved_reports')).toMatchObject({ value: 6, previous: 2 });
    expect(readAdoptionStats({ saved_minutes_reported: -1, saved_reports: 'x' })).toMatchObject({ saved_minutes_reported: null, saved_reports: null });
  });
  it('이름·읽는 법·CSV에 자기 신고이며 측정·추정이 아님을 밝힌다', () => {
    const s = readAdoptionStats({ saved_minutes_reported: 60, saved_reports: 1 });
    const row = adoptionRows(s, s).find((r) => r.key === 'saved_hours_reported')!;
    expect(row.note).toContain('측정하거나 추정한 시간이 아닙니다');
    const csv = adoptionCsv('2026-11', '2026-10', adoptionRows(s, s));
    expect(csv).toContain('자기 신고,직원이 고른 줄인 시간,1.0시간');
  });
  it('0083은 0066과 같은 이름·인자, 0066 칸을 그대로 두고 둘만 더한다, 실행 권한 다시 걸기', () => {
    const sql = readFileSync('supabase/migrations/0083_adoption_saved_minutes.sql', 'utf8');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.adoption_report(');
    expect(sql).toContain("'completed_median_hours'");
    expect(sql).toContain("'saved_minutes_reported'");
    expect(sql).toContain("AND f.rating = 'up' AND f.saved_minutes IS NOT NULL");
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.adoption_report(uuid, uuid[], timestamptz, timestamptz) TO service_role');
  });
});

const url = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!url)('줄인 시간 합 (0083, 시험 DB)', () => {
  let db: pg.Client;
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(url!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: url });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });

  it('그 달·관리 범위의 도움됨 + 고른 값만 더한다', async () => {
    const sql = readFileSync('supabase/migrations/0083_adoption_saved_minutes.sql', 'utf8');
    await db.query(sql);
    await db.query(sql);
    await db.query('BEGIN');
    try {
      const org = (await db.query("INSERT INTO organizations (name) VALUES ('줄인 시간 시험') RETURNING id")).rows[0].id;
      const dept = (await db.query("INSERT INTO departments (name, slug, organization_id) VALUES ('민원과', 'saved-min', $1) RETURNING id", [org])).rows[0].id;
      const other = (await db.query("INSERT INTO departments (name, slug, organization_id) VALUES ('감사과', 'saved-min-2', $1) RETURNING id", [org])).rows[0].id;
      const user = (await db.query("INSERT INTO users (email, department_id, is_active) VALUES ('saved@test.invalid', $1, true) RETURNING id", [dept])).rows[0].id;
      const conv = (await db.query("INSERT INTO conversations (department_id, user_id, title) VALUES ($1, $2, '대화') RETURNING id", [dept, user])).rows[0].id;
      const fb = async (deptId: string, rating: string, minutes: number | null, at: string) => {
        const m = (await db.query("INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'assistant', '답') RETURNING id", [conv])).rows[0].id;
        await db.query('INSERT INTO message_feedback (message_id, conversation_id, user_id, department_id, organization_id, rating, saved_minutes, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [m, conv, user, deptId, org, rating, minutes, at]);
      };
      await fb(dept, 'up', 30, '2026-10-05T00:00:00Z');
      await fb(dept, 'up', 60, '2026-10-06T00:00:00Z');
      await fb(dept, 'up', null, '2026-10-07T00:00:00Z'); // 안 고름 — 빠짐
      await fb(dept, 'down', null, '2026-10-07T00:00:00Z'); // 아쉬움 — 빠짐
      await fb(dept, 'up', 120, '2026-09-10T00:00:00Z'); // 지난달 — 빠짐
      await fb(other, 'up', 240, '2026-10-08T00:00:00Z'); // 범위 밖 부서 — 빠짐
      const r = (await db.query('SELECT adoption_report($1, $2, $3, $4) AS r', [org, [dept], '2026-09-30T15:00:00Z', '2026-10-31T15:00:00Z'])).rows[0].r;
      expect(Number(r.saved_minutes_reported)).toBe(90);
      expect(Number(r.saved_reports)).toBe(2);
      expect(readAdoptionStats(r).saved_minutes_reported).toBe(90);
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
