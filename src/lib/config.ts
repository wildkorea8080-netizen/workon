const isBuildPhase = process.env.NEXT_PHASE === 'phase-production-build';

function getEnv(key: string, required = true, fallbackKeys: string[] = []): string {
  const keys = [key, ...fallbackKeys];

  for (const currentKey of keys) {
    const value = process.env[currentKey];
    if (value) {
      return value;
    }
  }

  if (required && !isBuildPhase) {
    throw new Error(`Missing required environment variable: ${key}`);
  }

  return '';
}

export const SUPABASE_URL = getEnv('NEXT_PUBLIC_SUPABASE_URL', true, ['SUPABASE_URL']);
export const SUPABASE_ANON_KEY = getEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', true, ['SUPABASE_ANON_KEY']);
export const SUPABASE_SERVICE_ROLE_KEY = getEnv('SUPABASE_SERVICE_ROLE_KEY');
export const SUPABASE_DOCUMENTS_BUCKET = process.env.NEXT_PUBLIC_SUPABASE_DOCUMENTS_BUCKET ?? 'documents';
export const NEXTAUTH_URL = getEnv('NEXTAUTH_URL');
export const NEXTAUTH_SECRET = getEnv('NEXTAUTH_SECRET');
export const VOYAGE_API_KEY = getEnv('VOYAGE_API_KEY');
export const ANTHROPIC_API_KEY = getEnv('ANTHROPIC_API_KEY');
export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? 'WORKON';

// 메일 발송 (선택) — 미설정이면 초대 링크를 관리자가 직접 전달하는 방식으로 폴백한다
export const RESEND_API_KEY = getEnv('RESEND_API_KEY', false);
export const MAIL_FROM = process.env.MAIL_FROM ?? '';
export const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ?? process.env.NEXTAUTH_URL ?? 'http://localhost:3000';

// API 원가를 원화로 환산할 때 쓰는 고정 환율. 변동 반영이 필요하면 환경변수로 조정한다.
export const USD_KRW_RATE = Number(process.env.USD_KRW_RATE ?? '1350');
