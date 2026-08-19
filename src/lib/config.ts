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

// 국가법령정보 공동활용 OPEN API 사용자 ID (open.law.go.kr에서 발급).
// 기본값 'test'는 법제처가 열어둔 시험용 계정이라 제한이 있을 수 있으니
// 운영에서는 자체 ID를 발급받아 설정하세요.
export const LAW_API_OC = process.env.LAW_API_OC ?? 'test';

// 공공 데이터 커넥터 (선택) — 미설정 시 해당 커넥터가 도구 목록에서 제외된다
export const KOSIS_API_KEY = getEnv('KOSIS_API_KEY', false);
export const G2B_API_KEY = getEnv('G2B_API_KEY', false);
export const DART_API_KEY = getEnv('DART_API_KEY', false);
