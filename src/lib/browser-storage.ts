/**
 * 화면에서 저장소로 직접 올릴 때 쓰는 Supabase 클라이언트.
 * 채팅 첨부(attachments/upload-client.ts)와 참고 문서(document-upload-client.ts)가 함께 쓴다.
 * 화면 코드이므로 config.ts가 아니라 config-public.ts만 가져온다.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from '@/lib/config-public';

let client: SupabaseClient | null = null;

/** 올리기는 서명된 주소(토큰)가 허락하므로 로그인 세션이 필요 없다. 브라우저에서 처음 쓸 때 만든다 */
export function storageClient(): SupabaseClient {
  if (!client) {
    client = createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  }
  return client;
}
