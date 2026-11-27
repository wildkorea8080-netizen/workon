// src/lib/public-ask/purge.ts
// 시민 상담 기록 30일 보관(0136) — 5분 실행기가 지난 줄을 지운다. 던지지 않고 실패는 운영 기록에
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logSystem } from '@/lib/logger';
import { PUBLIC_ASK_LOG_DAYS } from './spec';

export async function purgePublicAskLogs(now: number = Date.now()): Promise<{ deleted: number } | null> {
  const cutoff = new Date(now - PUBLIC_ASK_LOG_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { count, error } = await supabaseAdmin.from('public_ask_logs').delete({ count: 'exact' }).lt('created_at', cutoff);
  if (error) {
    await logSystem({ level: 'warning', category: 'database', message: '지난 시민 상담 기록을 지우지 못했습니다', details: { code: error.code ?? 'error' } });
    return null;
  }
  return { deleted: count ?? 0 };
}
