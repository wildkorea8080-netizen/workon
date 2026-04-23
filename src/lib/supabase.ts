import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '@/lib/config';

// anon key 클라이언트 — 클라이언트 컴포넌트 및 Row Level Security가 적용되는 쿼리에 사용
// 서버 전용 쿼리(API Routes)에서는 supabaseAdmin을 사용하세요
const url = SUPABASE_URL || 'https://placeholder.supabase.co';
const key = SUPABASE_ANON_KEY || 'placeholder';
export const supabase = createClient(url, key, {
  auth: {
    persistSession: false
  }
});
