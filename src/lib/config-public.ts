/**
 * 브라우저에서도 읽는 공개 설정. `config.ts`는 서버 전용 환경 변수(service role 등)를 필수로 읽어
 * 브라우저 번들에 들어가면 시작하다 멈춘다 — 화면에서 쓰는 NEXT_PUBLIC_ 값만 여기 둔다.
 *
 * Next가 빌드 때 `process.env.NEXT_PUBLIC_이름`을 값으로 바꾸므로 **이름을 그대로 적어야 한다**
 * (`process.env[key]`처럼 계산하면 브라우저에서 비어 있다).
 */
export const PUBLIC_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
export const PUBLIC_SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
export const SUPABASE_DOCUMENTS_BUCKET = process.env.NEXT_PUBLIC_SUPABASE_DOCUMENTS_BUCKET ?? 'documents';

// 앱 중심 홈은 배포 환경별로 켠다. 기관의 실행 권한·사용 스위치는 서버가 계속 검사한다.
export const PUBLIC_WORKSPACE_HOME = process.env.NEXT_PUBLIC_WORKSPACE_HOME === 'apps' ? 'apps' : 'legacy';
