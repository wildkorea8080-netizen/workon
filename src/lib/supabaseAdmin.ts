import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } from '@/lib/config';

// service role 클라이언트 — API Routes 서버 전용, RLS 우회 필요 시 사용
// 클라이언트 컴포넌트나 브라우저에 절대 노출하지 마세요
const url = SUPABASE_URL || 'https://placeholder.supabase.co';
const key = SUPABASE_SERVICE_ROLE_KEY || 'placeholder';
export const supabaseAdmin = createClient(url, key, {
  auth: { persistSession: false }
});
