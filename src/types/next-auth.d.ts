import type { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  interface Session {
    user: {
      name?: string | null;
      email?: string | null;
      id?: string;
      role?: 'ADMIN' | 'USER';
      departmentId?: string | null;
      isImpersonating?: boolean;
      impersonatedBy?: string;
      impersonateOrgId?: string;
      impersonateOrgName?: string;
      impersonateLogId?: string;
      /** 기관 계정(SSO, 0107)으로 들어온 로그인 */
      sso?: boolean;
    };
  }

  interface User {
    id: string;
    email: string;
    role?: 'ADMIN' | 'USER';
    departmentId?: string | null;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    id?: string;
    role?: 'ADMIN' | 'USER';
    departmentId?: string | null;
    isImpersonating?: boolean;
    impersonatedBy?: string;
    impersonateOrgId?: string;
    impersonateOrgName?: string;
    impersonateLogId?: string;
    /** 로그인한 때(ms, 2026-11-16) — 세션을 다시 쓸 때 바뀌는 iat 대신 비밀번호 바꾼 때와 맞댄다 */
    authAt?: number;
    /** 기관 계정(SSO, 0107)으로 들어온 로그인 */
    sso?: boolean;
  }
}
