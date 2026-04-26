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
    await supabaseAdmin.from('access_logs').insert({
      user_id:     params.userId     ?? null,
      org_id:      params.orgId      ?? null,
      action:      params.action,
      path:        params.path        ?? null,
      ip_address:  params.ipAddress   ?? null,
      user_agent:  params.userAgent   ?? null,
      status_code: params.statusCode  ?? null,
      details:     params.details     ?? {},
    });
  } catch { /* 로깅 실패는 조용히 무시 */ }
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
