import { supabaseAdmin } from '@/lib/supabaseAdmin';

interface AccessLogParams {
  userId?: string | null;
  orgId?: string | null;
  action: string;
  path?: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  statusCode?: number;
  details?: Record<string, unknown>;
}

interface SystemLogParams {
  level: 'info' | 'warning' | 'error' | 'critical';
  category: 'auth' | 'api' | 'database' | 'payment' | 'security' | 'admin';
  message: string;
  details?: Record<string, unknown>;
  orgId?: string | null;
}

export async function logAccess(params: AccessLogParams): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from('access_logs').insert({
      user_id:     params.userId     ?? null,
      org_id:      params.orgId      ?? null,
      action:      params.action,
      path:        params.path        ?? null,
      ip_address:  params.ipAddress   ?? null,
      user_agent:  params.userAgent   ?? null,
      status_code: params.statusCode  ?? null,
      details:     params.details     ?? {},
    });
    // Supabase는 실패를 던지지 않고 돌려준다 — 접속 기록이 빠지면 운영 기록에 표·종류·코드만(2026-11-17)
    if (error) await logSystem({ level: 'error', category: 'security', message: '감사 기록을 남기지 못했습니다', details: { table: 'access_logs', kind: params.action, code: error.code ?? 'error' } });
  } catch { /* 로깅 실패는 부른 일을 막지 않는다 */ }
}

export async function logSystem(params: SystemLogParams): Promise<void> {
  try {
    await supabaseAdmin.from('system_logs').insert({
      level:    params.level,
      category: params.category,
      message:  params.message,
      details:  params.details ?? {},
      org_id:   params.orgId   ?? null,
    });
  } catch { /* 로깅 실패는 조용히 무시 */ }
}
