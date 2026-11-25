import { readFileSync } from 'fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

/**
 * 2026-11-25 — 앱 예약의 5분 단위 시각과 목록 밖 시간대(0119에 함께). 실행기가 5분마다 돌아 분을 0~55의 5분 단위로 넓히고,
 * 시간대는 자주 쓰는 목록 밖에서도 실행 환경(Intl)이 아는 IANA 정식 이름이면(대소문자까지 같을 때) 받는다.
 */

import {
  SCHEDULE_MINUTES, SCHEDULE_TIME_ZONES, describeSchedule, isScheduleTimeZone, nextRunAt, otherScheduleTimeZones, parseScheduleSpec, timeZoneLabel,
  type AppScheduleSpec,
} from '@/lib/apps/schedule-spec';
import AppScheduleForm from '@/components/apps/AppScheduleForm';

const spec = (over: Partial<AppScheduleSpec> = {}): AppScheduleSpec => ({ frequency: 'daily', weekday: null, monthDay: null, hour: 9, minute: 0, timeZone: 'Asia/Seoul', ...over });

describe('5분 단위 시각', () => {
  it('0~55의 5분 단위만 받는다', () => {
    expect(SCHEDULE_MINUTES).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
    for (const minute of [0, 5, 15, 45, 55, '20']) expect(parseScheduleSpec({ frequency: 'daily', hour: 9, minute }).ok).toBe(true);
    for (const minute of [17, 60, -5, 2.5, null]) {
      expect(parseScheduleSpec({ frequency: 'daily', hour: 9, minute })).toEqual({ ok: false, message: '실행 시각(분)은 0~55 사이 5분 단위입니다.' });
    }
  });
  it('다음 실행·설명에 그대로', () => {
    expect(nextRunAt(spec({ minute: 5 }), Date.parse('2026-11-25T00:00:00Z')).toISOString()).toBe('2026-11-25T00:05:00.000Z');
    expect(nextRunAt(spec({ minute: 45, timeZone: 'America/New_York' }), Date.parse('2026-11-25T00:00:00Z')).toISOString()).toBe('2026-11-25T14:45:00.000Z');
    expect(describeSchedule(spec({ minute: 5 }))).toBe('매일 09:05');
  });
});

describe('목록 밖 시간대', () => {
  it('Intl이 아는 정식 이름이면 받는다 — 대소문자가 다르거나 모르는 이름·DB 꼴 밖은 아님', () => {
    for (const tz of ['Europe/Madrid', 'America/Port-au-Prince', 'Etc/GMT+5', 'America/Buenos_Aires']) expect(isScheduleTimeZone(tz)).toBe(true);
    for (const tz of ['europe/madrid', 'Europe/Nowhere', 'Europe/Madrid/', '/Europe', 'x'.repeat(70), 'Europe/Ma drid', "Asia/Seoul'"]) expect(isScheduleTimeZone(tz)).toBe(false);
    expect(parseScheduleSpec({ frequency: 'daily', hour: 9, minute: 0, time_zone: 'Europe/Madrid' })).toMatchObject({ ok: true, value: { timeZone: 'Europe/Madrid' } });
  });
  it('이름표는 목록이면 한국어, 밖이면 IANA 이름', () => {
    expect(timeZoneLabel('Asia/Tokyo')).toBe('일본(도쿄) 시간');
    expect(timeZoneLabel('Europe/Madrid')).toBe('Europe/Madrid 시간');
    expect(describeSchedule(spec({ timeZone: 'Europe/Madrid' }))).toBe('매일 09:00 (Europe/Madrid 시간)');
  });
  it('그 밖의 시간대 목록 — 자주 쓰는 목록은 빼고, 모두 받는 값', () => {
    const others = otherScheduleTimeZones();
    expect(others.length).toBeGreaterThan(100);
    expect(others).toContain('Europe/Madrid');
    expect(others).not.toContain('Asia/Seoul');
    for (const tz of Object.keys(SCHEDULE_TIME_ZONES)) expect(others).not.toContain(tz);
    expect(others.every((tz) => isScheduleTimeZone(tz))).toBe(true);
    // 목록 밖 시간대도 다음 실행을 셀 수 있다
    expect(Number.isFinite(nextRunAt(spec({ timeZone: others[0] }), Date.parse('2026-11-25T00:00:00Z')).getTime())).toBe(true);
  });
});

describe('예약 화면', () => {
  it('분은 5분 단위, 시간대는 자주 쓰는 것과 그 밖의 것(IANA 이름)', () => {
    const html = renderToStaticMarkup(createElement(AppScheduleForm, {
      agentId: 'a', appVersion: 1, definition: { schemaVersion: 1, fields: [], output: 'paragraphs' } as never, values: {},
      editing: { id: 's', agentId: 'a', appName: '앱', appVersion: 1, inputs: {}, documentCount: 0, documentIds: [], spec: spec({ minute: 35, timeZone: 'Europe/Madrid' }), description: '', status: 'active', pausedReason: null, adminPaused: false, nextRunAt: '2026-11-25T00:00:00Z', lastRunAt: null, lastStatus: null, lastError: null, lastConversationId: null, consecutiveFailures: 0, runCount: 0, overdue: false, createdAt: '', notifyOnSuccess: false, heldByOrg: false, orgStopped: false, exportHwpx: false, files: [] },
    }));
    expect(html).toContain('35분');
    expect(html).toContain('55분');
    expect(html).toContain('label="자주 쓰는 시간대"');
    expect(html).toContain('label="그 밖의 시간대(IANA 이름)"');
    expect(html).toContain('Europe/Madrid');
  });
});

const dbUrl = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!dbUrl)('0119 — 5분 단위·IANA 이름 꼴(시험 DB)', () => {
  let db: pg.Client;
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(dbUrl!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });
  it('여러 번 적용해도 분 제약은 하나(5분 단위), 시간대 꼴은 -·+·숫자를 받는다', async () => {
    await db.query('BEGIN');
    try {
      const sql = readFileSync('supabase/migrations/0119_app_schedule_time_zone.sql', 'utf8');
      await db.query(sql); await db.query(sql);
      const checks = await db.query("SELECT conname, pg_get_constraintdef(oid) d FROM pg_constraint WHERE conrelid = 'public.app_schedules'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%run_minute%'");
      expect(checks.rows.map((r) => r.conname)).toEqual(['app_schedules_run_minute_5_check']);
      const ok = (expr: string, v: unknown) => db.query(`SELECT ${expr} AS ok`, [v]).then((r) => r.rows[0].ok);
      expect(await ok('($1::int BETWEEN 0 AND 55 AND $1::int % 5 = 0)', 35)).toBe(true);
      expect(await ok('($1::int BETWEEN 0 AND 55 AND $1::int % 5 = 0)', 17)).toBe(false);
      const tz = "($1::text ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$')";
      for (const name of ['America/Port-au-Prince', 'Etc/GMT+5', 'America/Argentina/Buenos_Aires', ...otherScheduleTimeZones()]) expect(await ok(tz, name)).toBe(true);
      for (const name of ["Asia/Seoul'", '/x', 'a b']) expect(await ok(tz, name)).toBe(false);
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
