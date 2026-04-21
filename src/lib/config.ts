function getEnv(key: string, required = true, fallbackKeys: string[] = []): string {
  const keys = [key, ...fallbackKeys];

  for (const currentKey of keys) {
    const value = process.env[currentKey];
    if (value) {
      return value;
    }
  }

  if (required) {
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
