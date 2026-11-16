import { readFileSync } from 'fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));

import { DORMANT_CHOICES, isDormant, lockIfDormant, validDormantDays, type DormantDeps } from '@/lib/dormant-lock';

/**
 * 2026-11-16 — 장기 미접속 계정 잠금(0095, 기관이 켤 때만)·기관 정보는 기관 전체 관리자만 바꾸기.
 */

const NOW = Date.parse('2026-11-16T10:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const ON = { days: 90, since: daysAgo(200) };

describe('잠글 때인가', () => {
  it('꺼져 있으면 언제나 아님', () => {
    expect(isDormant({ lastSignInAt: daysAgo(1000) }, { days: null, since: null }, NOW)).toBe(false);
    expect(isDormant({ lastSignInAt: daysAgo(1000) }, { days: 90, since: null }, NOW)).toBe(false);
  });
  it('마지막 활동에서 기간이 지나면 잠금', () => {
    expect(isDormant({ lastSignInAt: daysAgo(91), createdAt: daysAgo(500) }, ON, NOW)).toBe(true);
    expect(isDormant({ lastSignInAt: daysAgo(89), createdAt: daysAgo(500) }, ON, NOW)).toBe(false);
  });
  it('켠 날보다 앞의 미접속은 세지 않는다 — 켜는 순간 모두 잠기지 않게', () => {
    expect(isDormant({ lastSignInAt: null, createdAt: daysAgo(900) }, { days: 90, since: daysAgo(10) }, NOW)).toBe(false);
    expect(isDormant({ lastSignInAt: null, createdAt: daysAgo(900) }, { days: 90, since: daysAgo(91) }, NOW)).toBe(true);
  });
  it('다시 사용하게 한 때·비밀번호 바꾼 때·가입도 활동', () => {
    expect(isDormant({ lastSignInAt: daysAgo(150), reactivatedAt: daysAgo(5) }, ON, NOW)).toBe(false);
    expect(isDormant({ lastSignInAt: daysAgo(150), passwordChangedAt: daysAgo(5) }, ON, NOW)).toBe(false);
    expect(isDormant({ lastSignInAt: null, createdAt: daysAgo(20) }, ON, NOW)).toBe(false);
  });
  it('기간 값 — 30~365 정수', () => {
    expect(validDormantDays(30)).toBe(true);
    expect(validDormantDays(365)).toBe(true);
    expect(validDormantDays(29)).toBe(false);
    expect(validDormantDays(90.5)).toBe(false);
    expect(validDormantDays('90')).toBe(false);
    expect([...DORMANT_CHOICES]).toEqual([30, 60, 90, 180, 365]);
  });
});

describe('로그인 직전 확인', () => {
  function deps(o: { row?: Awaited<ReturnType<DormantDeps['load']>>; throwLoad?: boolean; throwLock?: boolean } = {}) {
    const locked: string[] = [];
    const d: DormantDeps = {
      load: vi.fn(async () => { if (o.throwLoad) throw new Error('db'); return o.row === undefined ? null : o.row; }),
      lock: vi.fn(async (id, dept, days) => { if (o.throwLock) throw new Error('db'); locked.push(`${id}:${dept}:${days}`); }),
    };
    return { d, locked };
  }
  it('잠글 때면 사용 중지로 돌리고 true', async () => {
    const { d, locked } = deps({ row: { facts: { lastSignInAt: daysAgo(100) }, policy: ON, departmentId: 'D' } });
    expect(await lockIfDormant(d, 'U', NOW)).toBe(true);
    expect(locked).toEqual(['U:D:90']);
  });
  it('아니면 false, 못 읽거나 잠그다 실패하면 막지 않는다(열림)', async () => {
    expect(await lockIfDormant(deps({ row: { facts: { lastSignInAt: daysAgo(1) }, policy: ON, departmentId: 'D' } }).d, 'U', NOW)).toBe(false);
    expect(await lockIfDormant(deps({ row: null }).d, 'U', NOW)).toBe(false);
    expect(await lockIfDormant(deps({ throwLoad: true }).d, 'U', NOW)).toBe(false);
    expect(await lockIfDormant(deps({ row: { facts: { lastSignInAt: daysAgo(100) }, policy: ON, departmentId: 'D' }, throwLock: true }).d, 'U', NOW)).toBe(false);
  });
});

describe('연결(원본)', () => {
  it('직원 로그인 두 길 모두 성공 기록 전에 확인하고 ACCOUNT_DORMANT를 던진다', () => {
    const src = readFileSync('src/lib/nextAuthOptions.ts', 'utf8');
    expect(src.match(/if \(await lockIfDormant\(dormantDeps\(\), /g)).toHaveLength(2);
    expect(src.match(/throw new Error\(ACCOUNT_DORMANT\);/g)).toHaveLength(2);
    expect(src.indexOf('lockIfDormant(dormantDeps(), authUser.id)')).toBeLessThan(src.indexOf("await record('login', { id: authUser.id"));
    expect(readFileSync('src/components/auth/LoginForm.tsx', 'utf8')).toContain('res.error === ACCOUNT_DORMANT ? DORMANT_MESSAGE');
  });
  it('다시 사용하게 하면 reactivated_at(기관 관리자·슈퍼관리자)', () => {
    expect(readFileSync('src/app/api/users/[id]/active/route.ts', 'utf8')).toContain('{ is_active: true, reactivated_at: new Date().toISOString() }');
    expect(readFileSync('src/app/api/super/accounts/users/[id]/route.ts', 'utf8')).toContain('if (body.isActive === true) update.reactivated_at');
  });
  it('설정 라우트 — 기관 전체 관리자만·대리 접근 막음·처음 켤 때만 켠 때를 적음·보안 로그 high', () => {
    const src = readFileSync('src/app/api/admin/organization/dormant-lock/route.ts', 'utf8');
    expect(src).toContain('scope?.managesWholeOrganization');
    expect(src).toContain('if (session.user.isImpersonating)');
    expect(src).toContain('dormant_lock_since: before.dormant_lock_since ?? new Date().toISOString()');
    expect(src).toContain("logSecurityEvent(scope.departmentId, session.user.id, 'dormant_lock_changed', { before_days: before.dormant_lock_days ?? null, after_days: days }, 'high')");
  });
  it('기관 정보 PATCH는 기관 전체 관리자만', () => {
    const src = readFileSync('src/app/api/admin/organization/route.ts', 'utf8');
    const patch = src.slice(src.indexOf('export async function PATCH'));
    expect(patch.indexOf('if (!scope?.managesWholeOrganization)')).toBeGreaterThan(0);
    expect(patch.indexOf('if (!scope?.managesWholeOrganization)')).toBeLessThan(patch.indexOf("request.headers.get('content-type')"));
  });
});

const url = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!url)('0095 장기 미접속 잠금 칸 (시험 DB)', () => {
  let db: pg.Client;
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(url!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: url });
    await db.connect();
    const sql = readFileSync('supabase/migrations/0095_dormant_lock.sql', 'utf8');
    await db.query(sql);
    await db.query(sql);
  });
  afterAll(async () => { await db?.end(); });
  it('칸 셋과 CHECK — 30~365, 켤 때는 켠 때가 있어야', async () => {
    const cols = await db.query(`SELECT table_name, column_name FROM information_schema.columns
      WHERE (table_name='organizations' AND column_name IN ('dormant_lock_days','dormant_lock_since')) OR (table_name='users' AND column_name='reactivated_at') ORDER BY 1,2`);
    expect(cols.rows.map((r) => `${r.table_name}.${r.column_name}`)).toEqual([
      'organizations.dormant_lock_days', 'organizations.dormant_lock_since', 'users.reactivated_at',
    ]);
    const org = await db.query('SELECT id FROM organizations LIMIT 1');
    if (org.rowCount === 0) return;
    const id = org.rows[0].id;
    for (const [days, since] of [[29, 'now()'], [366, 'now()'], [90, 'NULL']] as const) {
      await db.query('BEGIN');
      try {
        await expect(db.query(`UPDATE organizations SET dormant_lock_days=${days}, dormant_lock_since=${since} WHERE id=$1`, [id])).rejects.toMatchObject({ code: '23514' });
      } finally { await db.query('ROLLBACK'); }
    }
    await db.query('BEGIN');
    try {
      await db.query('UPDATE organizations SET dormant_lock_days=90, dormant_lock_since=now() WHERE id=$1', [id]);
    } finally { await db.query('ROLLBACK'); }
  });
});
