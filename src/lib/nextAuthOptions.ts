import type { AuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';
import { supabase } from '@/lib/supabase';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { NEXTAUTH_SECRET } from '@/lib/config';
import { canSignIn } from '@/lib/user-withdrawal';
import { decideSignIn } from '@/lib/sign-in-user';

export const authOptions: AuthOptions = {
  providers: [
    CredentialsProvider({
      name: 'Credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' }
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          return null;
        }

        const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
          email: credentials.email,
          password: credentials.password
        });

        // Supabase Auth 실패 시 users 테이블의 password_hash로 폴백 검증
        // 관리자 초대로 생성된 사용자는 Supabase Auth에 없고 password_hash만 가짐
        // ⚠️ 구 SHA-256 해시로 저장된 계정은 로그인 불가 — 비밀번호 재설정 필요
        if (authError || !authData?.user) {
          return await authorizeWithPasswordHash(credentials.email, credentials.password);
        }

        // 소속·역할은 users 행만 정한다(2026-11-12, `sign-in-user.ts`) — 행이 없거나 부서가 비면 들이지 않는다.
        // 예전에는 가장 오래된 부서(어느 기관이든)를 배정해 행을 만들었다(공개 가입 → 첫 기관 직원).
        const authUser = authData.user;
        const { data: existingUser, error: fetchError } = await supabaseAdmin
          .from('users')
          .select('id, email, role, full_name, department_id, is_active, deleted_at')
          .eq('id', authUser.id)
          .maybeSingle();

        // 비활성·삭제(탈퇴) 계정은 Supabase Auth가 통과시켜도 들이지 않는다
        if (existingUser && !canSignIn(existingUser)) return null;

        const decision = decideSignIn(existingUser ?? null, Boolean(fetchError));
        if (!decision.ok) {
          console.warn('[nextAuth] 로그인 거절 — 소속을 확인할 수 없음:', decision.reason);
          return null;
        }

        return {
          id: authUser.id,
          email: authUser.email ?? '',
          name: decision.name || authUser.user_metadata?.full_name || authUser.email || undefined,
          role: decision.role,
          departmentId: decision.departmentId,
        };
      }
    })
  ],
  pages: {
    signIn: '/login'
  },
  session: {
    strategy: 'jwt' as const
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = user.role;
        token.departmentId = user.departmentId ?? null;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.role = token.role as 'ADMIN' | 'USER';
        session.user.departmentId = token.departmentId ?? null;
        if (token.isImpersonating) {
          session.user.isImpersonating   = true;
          session.user.impersonatedBy    = token.impersonatedBy as string;
          session.user.impersonateOrgId  = token.impersonateOrgId as string;
          session.user.impersonateOrgName = token.impersonateOrgName as string;
          session.user.impersonateLogId  = token.impersonateLogId as string;
        }
      }
      return session;
    }
  },
  secret: NEXTAUTH_SECRET
};

// 관리자 초대로 생성된 사용자(Supabase Auth 미등록)의 로컬 password_hash 검증
async function authorizeWithPasswordHash(email: string, password: string) {
  const { data: user, error } = await supabaseAdmin
    .from('users')
    .select('id, email, role, full_name, department_id, password_hash, is_active, deleted_at')
    .eq('email', email)
    .maybeSingle();

  if (error || !user?.password_hash || !canSignIn(user)) return null;

  const isValid = await bcrypt.compare(password, user.password_hash);
  if (!isValid) return null;

  // 부서가 없는 계정은 들이지 않는다(위 Supabase Auth 경로와 같은 규칙)
  const decision = decideSignIn(user, false);
  if (!decision.ok) return null;

  return {
    id: user.id,
    email: user.email ?? '',
    name: decision.name ?? '',
    role: decision.role,
    departmentId: decision.departmentId,
  } as any;
}
