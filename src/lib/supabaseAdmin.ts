import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } from '@/lib/config';

// service role 클라이언트 — API Routes 서버 전용, RLS 우회 필요 시 사용
// 클라이언트 컴포넌트나 브라우저에 절대 노출하지 마세요
export const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});
