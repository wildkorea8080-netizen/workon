import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

/**
 * 2026-11-25 — 앱 예약의 시간대(0119). 예약마다 정해 둔 목록의 IANA 시간대를 고르고(기본 한국 시간), 다음 실행 시각은 그 시간대의
 * 벽시계로 셈한다. 서머타임: 없는 시각(봄)이면 한 시간 뒤의 같은 실제 시각, 두 번 오는 시각(가을)이면 앞의 것에 한 번만.
 */

import {
  DEFAULT_SCHEDULE_TIME_ZONE, SCHEDULE_COLUMNS, SCHEDULE_TIME_ZONES, describeSchedule, formatInZone, isScheduleTimeZone, nextRunAt,
  parseScheduleSpec, specColumns, specOfRow, timeZoneLabel, wallToUtc, zoneOffsetMs, type AppScheduleSpec,
} from '@/lib/apps/schedule-spec';

const spec = (over: Partial<AppScheduleSpec> = {}): AppScheduleSpec => ({ frequency: 'daily', weekday: null, monthDay: null, hour: 9, minute: 0, timeZone: 'Asia/Seoul', ...over });
const iso = (ms: number | Date) => new Date(ms).toISOString();

describe('시간대 고르기', () => {
  it('없으면 한국 시간, 목록 안만 받는다', () => {
    expect(parseScheduleSpec({ frequency: 'daily', hour: 9, minute: 0 })).toMatchObject({ ok: true, value: { timeZone: 'Asia/Seoul' } });
    expect(parseScheduleSpec({ frequency: 'daily', hour: 9, minute: 0, time_zone: '' })).toMatchObject({ ok: true, value: { timeZone: 'Asia/Seoul' } });
    expect(parseScheduleSpec({ frequency: 'daily', hour: 9, minute: 0, time_zone: 'America/New_York' })).toMatchObject({ ok: true, value: { timeZone: 'America/New_York' } });
    expect(parseScheduleSpec({ frequency: 'daily', hour: 9, minute: 0, timeZone: 'Europe/London' })).toMatchObject({ ok: true, value: { timeZone: 'Europe/London' } });
    for (const bad of ['Mars/Olympus', 'asia/seoul', 'Asia/Nowhere', 9, 'toString', 'Asia/Seoul; --']) {
      expect(parseScheduleSpec({ frequency: 'daily', hour: 9, minute: 0, time_zone: bad })).toEqual({ ok: false, message: '시간대를 확인해 주세요(목록에 있는 시간대나 IANA 시간대 이름만).' });
    }
    expect(isScheduleTimeZone('hasOwnProperty')).toBe(false);
    expect(DEFAULT_SCHEDULE_TIME_ZONE).toBe('Asia/Seoul');
  });
  it('목록의 시간대는 모두 이 실행 환경의 IANA 자료로 셀 수 있다', () => {
    for (const tz of Object.keys(SCHEDULE_TIME_ZONES)) {
      expect(() => new Intl.DateTimeFormat('en-US', { timeZone: tz })).not.toThrow();
      expect(Number.isFinite(zoneOffsetMs(tz as keyof typeof SCHEDULE_TIME_ZONES, Date.parse('2026-06-01T00:00:00Z')))).toBe(true);
    }
  });
  it('행 → 규칙(옛 행은 한국 시간), 규칙 → DB 칸, 화면이 읽는 칸에 time_zone', () => {
    expect(specOfRow({ frequency: 'daily', weekday: null, month_day: null, run_hour: 9, run_minute: 0 }).timeZone).toBe('Asia/Seoul');
    expect(specOfRow({ frequency: 'daily', weekday: null, month_day: null, run_hour: 9, run_minute: 0, time_zone: 'Asia/Tokyo' }).timeZone).toBe('Asia/Tokyo');
    expect(specColumns(spec({ timeZone: 'Europe/Paris' }))).toMatchObject({ time_zone: 'Europe/Paris' });
    expect(SCHEDULE_COLUMNS.split(', ')).toContain('time_zone');
  });
  it('설명·시간 이름 — 한국 시간이면 예전 그대로', () => {
    expect(describeSchedule(spec())).toBe('매일 09:00');
    expect(describeSchedule(spec({ timeZone: 'America/New_York', frequency: 'weekly', weekday: 1 }))).toBe('매주 월요일 09:00 (미국 동부(뉴욕·워싱턴) 시간)');
    expect(timeZoneLabel('UTC')).toBe('협정 세계시(UTC)');
    expect(formatInZone('2026-11-25T14:00:00Z', 'America/New_York')).toBe('11월 25일 09:00');
    expect(formatInZone('nope', 'UTC')).toBe('—');
  });
});

describe('다음 실행 시각', () => {
  it('한국 시간은 예전 셈과 같다(09:00 KST = 00:00Z)', () => {
    expect(iso(nextRunAt(spec(), Date.parse('2026-11-25T00:30:00Z')))).toBe('2026-11-26T00:00:00.000Z');
    expect(iso(nextRunAt(spec(), Date.parse('2026-11-24T23:59:00Z')))).toBe('2026-11-25T00:00:00.000Z');
    // 정확히 실행 시각이면 다음 차례
    expect(iso(nextRunAt(spec(), Date.parse('2026-11-25T00:00:00Z')))).toBe('2026-11-26T00:00:00.000Z');
    expect(iso(nextRunAt(spec({ frequency: 'monthly', monthDay: 1, hour: 0, minute: 30 }), Date.parse('2026-11-25T00:00:00Z')))).toBe('2026-11-30T15:30:00.000Z');
  });
  it('뉴욕 09:00 — 겨울(EST)은 14:00Z, 여름(EDT)은 13:00Z', () => {
    const ny = spec({ timeZone: 'America/New_York' });
    expect(iso(nextRunAt(ny, Date.parse('2026-11-25T00:00:00Z')))).toBe('2026-11-25T14:00:00.000Z');
    expect(iso(nextRunAt(ny, Date.parse('2026-07-01T00:00:00Z')))).toBe('2026-07-01T13:00:00.000Z');
    // 날짜가 한국보다 늦게 바뀐다 — 한국 11/26 오전이어도 뉴욕은 아직 11/25
    expect(iso(nextRunAt(ny, Date.parse('2026-11-25T13:00:00Z')))).toBe('2026-11-25T14:00:00.000Z');
  });
  it('봄 서머타임 — 없는 시각(02:30)은 한 시간 뒤의 같은 실제 시각(03:30 EDT = 07:30Z)', () => {
    const ny = spec({ timeZone: 'America/New_York', hour: 2, minute: 30 });
    expect(iso(nextRunAt(ny, Date.parse('2026-03-08T00:00:00Z')))).toBe('2026-03-08T07:30:00.000Z');
    expect(iso(nextRunAt(ny, Date.parse('2026-03-08T07:30:00Z')))).toBe('2026-03-09T06:30:00.000Z');
  });
  it('가을 서머타임 — 두 번 오는 시각(01:30)은 앞의 것에 한 번만', () => {
    const ny = spec({ timeZone: 'America/New_York', hour: 1, minute: 30 });
    expect(iso(nextRunAt(ny, Date.parse('2026-11-01T00:00:00Z')))).toBe('2026-11-01T05:30:00.000Z');
    expect(iso(nextRunAt(ny, Date.parse('2026-11-01T05:30:00Z')))).toBe('2026-11-02T06:30:00.000Z');
    expect(wallToUtc('America/New_York', Date.UTC(2026, 10, 1, 1, 30))).toBe(Date.parse('2026-11-01T05:30:00Z'));
  });
  it('요일·날은 그 시간대의 날짜로 — 시드니 월요일 08:00은 UTC로 일요일', () => {
    const syd = spec({ timeZone: 'Australia/Sydney', frequency: 'weekly', weekday: 1, hour: 8 });
    const at = nextRunAt(syd, Date.parse('2026-11-25T00:00:00Z'));
    expect(iso(at)).toBe('2026-11-29T21:00:00.000Z'); // AEDT(UTC+11) 11/30(월) 08:00
    expect(at.getUTCDay()).toBe(0);
    const weekdays = spec({ timeZone: 'America/Los_Angeles', frequency: 'weekdays', hour: 17 });
    // 금요일 17:00 PST(= 토 01:00Z) 다음은 월요일
    expect(iso(nextRunAt(weekdays, Date.parse('2026-11-28T01:00:00Z')))).toBe('2026-12-01T01:00:00.000Z');
  });
  it('30분 단위 시간대(인도 UTC+5:30)도 맞게', () => {
    expect(iso(nextRunAt(spec({ timeZone: 'Asia/Kolkata' }), Date.parse('2026-11-25T00:00:00Z')))).toBe('2026-11-25T03:30:00.000Z');
  });
});

describe('화면·서버 연결', () => {
  it('예약 화면이 시간대를 고르고 보내며, 목록·저장 안내가 현지 시각을 함께 보인다', () => {
    const form = readFileSync('src/components/apps/AppScheduleForm.tsx', 'utf8');
    expect(form).toContain('aria-label="시간대"');
    expect(form).toContain('time_zone: timeZone');
    const list = readFileSync('src/app/apps/schedules/page.tsx', 'utf8');
    expect(list).toContain('formatInZone(s.nextRunAt, s.spec.timeZone)');
  });
  it('관리자 목록·조치 알림도 time_zone을 읽어 설명에 시간대가 실린다', () => {
    expect(readFileSync('src/lib/apps/automation-admin.ts', 'utf8')).toContain('run_minute, time_zone,');
    expect(readFileSync('src/lib/apps/automation-notice.ts', 'utf8')).toContain("run_minute, time_zone')");
  });
});

const dbUrl = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!dbUrl)('0119 — 예약 시간대 칸(시험 DB)', () => {
  let db: pg.Client;
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(dbUrl!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });
  it('여러 번 적용해도 안전·기본 Asia/Seoul·꼴 CHECK', async () => {
    await db.query('BEGIN');
    try {
      const sql = readFileSync('supabase/migrations/0119_app_schedule_time_zone.sql', 'utf8');
      await db.query(sql); await db.query(sql);
      const col = await db.query("SELECT column_default, is_nullable FROM information_schema.columns WHERE table_name = 'app_schedules' AND column_name = 'time_zone'");
      expect(col.rows[0].is_nullable).toBe('NO');
      expect(String(col.rows[0].column_default)).toContain('Asia/Seoul');
      const check = (tz: string) => db.query("SELECT $1::text ~ '^[A-Za-z_]+(/[A-Za-z_]+){0,2}$' AND char_length($1::text) <= 64 AS ok", [tz]);
      for (const tz of Object.keys(SCHEDULE_TIME_ZONES)) expect((await check(tz)).rows[0].ok).toBe(true);
      for (const tz of ["Asia/Seoul'; --", '../etc', 'x'.repeat(65)]) expect((await check(tz)).rows[0].ok).toBe(false);
      const con = await db.query("SELECT count(*)::int n FROM pg_constraint WHERE conname = 'app_schedules_time_zone_check'");
      expect(con.rows[0].n).toBe(1);
      expect(randomUUID()).toBeTruthy();
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
