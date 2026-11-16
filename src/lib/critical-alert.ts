import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logSystem } from '@/lib/logger';
import { APP_URL } from '@/lib/config';
import { criticalLogAlertMail, sendCriticalLogAlertEmail } from '@/lib/mailer';
import { CRITICAL_LOGS_LINK, CRITICAL_WINDOW_MS, criticalSummary } from '@/lib/super-log-links';

/**
 * 심각한 운영 기록 메일 알림(2026-11-17).
 *
 * 사용 기록·감사 기록·계약 맞추기 실패 등을 `system_logs` critical로 남기고 대시보드 띠에 올렸지만, 대시보드를 열어야 보인다.
 * 5분 실행기(`/api/cron/app-schedules`)가 부를 때마다 아직 알리지 않은 critical 기록(최근 24시간 안)이 있으면 활성 슈퍼관리자에게
 * 메일을 보낸다 — **한 시간에 한 번까지**. 어디까지 알렸는지는 `system_settings`의 `critical_log_alert`(값 = 알린 마지막 기록의 시각)에 두고,
 * 겹친 실행기는 그 값을 조건부로 바꾼 한쪽만 보낸다. 메일에는 수·문구·시각만(사람·상세 없음). 실패는 warning으로만 남긴다(critical로 남기면
 * 그 기록이 또 알림을 부른다). 던지지 않는다.
 */

export const CRITICAL_ALERT_KEY = 'critical_log_alert';
export const CRITICAL_ALERT_INTERVAL_MS = 60 * 60_000;

export interface CriticalAlertState { value: string | null; updatedAt: string | null }

export interface CriticalAlertDeps {
  /** 행이 없으면 null, 못 읽으면 던짐 */
  readState(): Promise<CriticalAlertState | null>;
  /** 그 시각 뒤의 critical 기록 — 수(정확히)·문구(500줄까지)·가장 늦은 시각 */
  criticalSince(sinceIso: string): Promise<{ count: number; messages: Array<{ message: string | null }>; latestAt: string | null }>;
  /** 값이 아직 `prev`일 때만 `next`로(행이 없으면 만든다) — 차지했으면 true */
  claim(prev: CriticalAlertState | null, next: string, nowIso: string): Promise<boolean>;
  superAdminEmails(): Promise<string[]>;
  send(to: string, mail: { subject: string; html: string }): Promise<{ sent: boolean }>;
  log(message: string, details: Record<string, unknown>): Promise<void>;
}

export type CriticalAlertResult = { skipped: 'recent' | 'none' | 'raced' | 'error' } | { count: number; notified: number };

export async function runCriticalAlert(deps: CriticalAlertDeps, nowMs = Date.now()): Promise<CriticalAlertResult> {
  try {
    const state = await deps.readState();
    // 한 시간 안에 이미 알렸으면 쉰다(값이 있는 행 = 알린 적 있음)
    if (state?.value && state.updatedAt && nowMs - Date.parse(state.updatedAt) < CRITICAL_ALERT_INTERVAL_MS) return { skipped: 'recent' };
    const floor = nowMs - CRITICAL_WINDOW_MS;
    const lastCovered = state?.value ? Date.parse(state.value) : NaN;
    const since = new Date(Number.isFinite(lastCovered) ? Math.max(lastCovered, floor) : floor).toISOString();
    const found = await deps.criticalSince(since);
    if (found.count === 0 || !found.latestAt) return { skipped: 'none' };
    if (!(await deps.claim(state, found.latestAt, new Date(nowMs).toISOString()))) return { skipped: 'raced' };

    const mail = criticalLogAlertMail({ count: found.count, top: criticalSummary(found.messages), since: new Date(since), checkedAt: new Date(nowMs), url: `${APP_URL}${CRITICAL_LOGS_LINK}` });
    let notified = 0;
    for (const to of await deps.superAdminEmails()) {
      if ((await deps.send(to, mail).catch(() => ({ sent: false }))).sent) notified++;
    }
    if (notified === 0) await deps.log('심각한 운영 기록 알림 메일을 보내지 못함', { count: found.count });
    return { count: found.count, notified };
  } catch (error) {
    await deps.log('심각한 운영 기록 알림을 확인하지 못함', { error: error instanceof Error ? error.message.slice(0, 200) : 'unknown' }).catch(() => {});
    return { skipped: 'error' };
  }
}

export function criticalAlertDeps(): CriticalAlertDeps {
  return {
    async readState() {
      const { data, error } = await supabaseAdmin.from('system_settings').select('value, updated_at').eq('key', CRITICAL_ALERT_KEY).maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return null;
      const row = data as { value: string | null; updated_at: string | null };
      return { value: row.value || null, updatedAt: row.updated_at };
    },
    async criticalSince(sinceIso) {
      const { data, count, error } = await supabaseAdmin.from('system_logs').select('message, created_at', { count: 'exact' })
        .eq('level', 'critical').gt('created_at', sinceIso).order('created_at', { ascending: false }).limit(500);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as Array<{ message: string | null; created_at: string }>;
      return { count: count ?? rows.length, messages: rows, latestAt: rows[0]?.created_at ?? null };
    },
    async claim(prev, next, nowIso) {
      if (!prev) {
        const { data, error } = await supabaseAdmin.from('system_settings')
          .upsert({ key: CRITICAL_ALERT_KEY, value: next, description: '심각한(critical) 운영 기록 메일 알림 — 알린 마지막 기록의 시각, 자동으로 바뀐다', updated_at: nowIso }, { onConflict: 'key', ignoreDuplicates: true })
          .select('key');
        return !error && Boolean(data?.length);
      }
      const q = supabaseAdmin.from('system_settings').update({ value: next, updated_at: nowIso }).eq('key', CRITICAL_ALERT_KEY);
      const { data, error } = await (prev.value === null ? q.eq('value', '') : q.eq('value', prev.value)).select('key');
      return !error && Boolean(data?.length);
    },
    async superAdminEmails() {
      const { data, error } = await supabaseAdmin.from('users').select('email').eq('is_super_admin', true).eq('is_active', true).is('deleted_at', null);
      if (error) throw new Error(error.message);
      return Array.from(new Set(((data ?? []) as Array<{ email: string | null }>).map((u) => (u.email ?? '').trim()).filter((e) => /^[^\s@]+@[^\s@]+$/.test(e))));
    },
    send: (to, mail) => sendCriticalLogAlertEmail(to, mail),
    log: (message, details) => logSystem({ level: 'warning', category: 'admin', message, details }),
  };
}
