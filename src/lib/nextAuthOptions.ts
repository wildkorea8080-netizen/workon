import type { AuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';
import { supabase } from '@/lib/supabase';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { NEXTAUTH_SECRET } from '@/lib/config';
import { canSignIn } from '@/lib/user-withdrawal';
import { decideSignIn } from '@/lib/sign-in-user';
import { ACCOUNT_LOCKED, IP_LOCKED, noteSignInFailure, noteSignInSuccess, requestIp, signInLock, throttleDeps } from '@/lib/sign-in-throttle';
import { recordSignIn, signInRecordDeps, type SignInOutcome } from '@/lib/sign-in-record';
import { dormantDeps, lockIfDormant } from '@/lib/dormant-lock';
import { ACCOUNT_DORMANT } from '@/lib/sign-in-lock-spec';
import { AUTH_UNAVAILABLE, isAuthUnavailable } from '@/lib/auth-unavailable';
import { logSystem } from '@/lib/logger';
import { passwordLoginBlocked } from '@/lib/sso-only';
import { SSO_ONLY } from '@/lib/org-sso-spec';

export const authOptions: AuthOptions = {
  providers: [
    CredentialsProvider({
      name: 'Credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' }
      },
      async authorize(credentials, req) {
        if (!credentials?.email || !credentials?.password) {
          return null;
        }

        // 로그인 실패 잠금(2026-11-13, `sign-in-throttle.ts`) — 30분 안에 5번 틀린 계정·30번 틀린 IP는 맞는 비밀번호도 받지 않는다
        const throttle = throttleDeps();
        const ip = requestIp(req?.headers as Record<string, unknown> | undefined);
        // 직원 접속 기록(2026-11-16, 0094) — 성공·실패·잠김·거절. 입력한 이메일은 남기지 않는다(계정이 있으면 그 사람으로)
        const uaRaw = (req?.headers as Record<string, unknown> | undefined)?.['user-agent'];
        const record = (outcome: SignInOutcome, user?: { id: string; departmentId: string | null } | null) =>
          recordSignIn(signInRecordDeps(), { outcome, email: credentials.email, ip, userAgent: typeof uaRaw === 'string' ? uaRaw : null, user });
        // IP 잠금이면 다른 안내(2026-11-17) — 기관 관리자도 같은 주소라 풀 수 없고, 서비스 운영자만 푼다
        const lock = await signInLock(throttle, 'user', credentials.email, ip);
        if (lock) {
          await record('login_locked');
          throw new Error(lock === 'ip' ? IP_LOCKED : ACCOUNT_LOCKED);
        }

        const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
          email: credentials.email,
          password: credentials.password
        });

        // Supabase Auth 실패 시 users 테이블의 password_hash로 폴백 검증
        // 관리자 초대로 생성된 사용자는 Supabase Auth에 없고 password_hash만 가짐
        // ⚠️ 구 SHA-256 해시로 저장된 계정은 로그인 불가 — 비밀번호 재설정 필요
        if (authError || !authData?.user) {
          const local = await authorizeWithPasswordHash(credentials.email, credentials.password);
          if (local === 'unavailable') {
            // 저장해 둔 비밀번호(users)를 못 읽은 것도 틀린 비밀번호가 아니다(2026-11-20) — 관리자가 등록한 계정은 이 길로만 들어온다
            await logSystem({ level: 'warning', category: 'auth', message: '로그인 확인을 하지 못했습니다(사용자 정보를 읽지 못함) — 실패로 세지 않음', details: {} }).catch(() => {});
            throw new Error(AUTH_UNAVAILABLE);
          }
          if (local) {
            await noteSignInSuccess(throttle, 'user', credentials.email);
            // 기관 SSO 전용(0109) — 직원은 기관 계정으로만. 비밀번호가 맞아도 막는다(관리자는 그대로)
            if (await passwordLoginBlocked(local)) {
              await record('login_rejected', { id: local.id, departmentId: local.departmentId ?? null });
              throw new Error(SSO_ONLY);
            }
            // 장기 미접속 잠금(0095, 기관이 켰을 때) — 비밀번호가 맞아도 사용 중지로 돌리고 막는다
            if (await lockIfDormant(dormantDeps(), local.id)) {
              await record('login_rejected', { id: local.id, departmentId: local.departmentId ?? null });
              throw new Error(ACCOUNT_DORMANT);
            }
            await record('login', { id: local.id, departmentId: local.departmentId ?? null });
          } else if (authError && isAuthUnavailable(authError)) {
            // Auth가 지금 확인하지 못한 것은 틀린 비밀번호가 아니다(2026-11-20) — 실패로 세지 않는다(세면 계정·사무실 IP가 잠긴다)
            await logSystem({ level: 'warning', category: 'auth', message: '로그인 확인을 하지 못했습니다(Auth 응답 없음) — 실패로 세지 않음', details: { status: (authError as { status?: unknown }).status ?? null } }).catch(() => {});
            throw new Error(AUTH_UNAVAILABLE);
          } else {
            await noteSignInFailure(throttle, 'user', credentials.email, ip);
            await record('login_failed');
          }
          return local;
        }
        // 비밀번호는 맞았다 — 실패 기록을 지운다(소속 확인은 아래에서 따로)
        await noteSignInSuccess(throttle, 'user', credentials.email);

        // 소속·역할은 users 행만 정한다(2026-11-12, `sign-in-user.ts`) — 행이 없거나 부서가 비면 들이지 않는다.
        // 예전에는 가장 오래된 부서(어느 기관이든)를 배정해 행을 만들었다(공개 가입 → 첫 기관 직원).
        const authUser = authData.user;
        const { data: existingUser, error: fetchError } = await supabaseAdmin
          .from('users')
          .select('id, email, role, full_name, department_id, is_active, deleted_at')
          .eq('id', authUser.id)
          .maybeSingle();

        // 비활성·삭제(탈퇴) 계정은 Supabase Auth가 통과시켜도 들이지 않는다
        if (existingUser && !canSignIn(existingUser)) {
          await record('login_rejected', { id: existingUser.id, departmentId: existingUser.department_id ?? null });
          return null;
        }

        const decision = decideSignIn(existingUser ?? null, Boolean(fetchError));
        if (!decision.ok) {
          console.warn('[nextAuth] 로그인 거절 — 소속을 확인할 수 없음:', decision.reason);
          await record('login_rejected', existingUser ? { id: existingUser.id, departmentId: existingUser.department_id ?? null } : null);
          return null;
        }
        // 기관 SSO 전용(0109) — 위 저장해 둔 비밀번호 길과 같은 규칙
        if (await passwordLoginBlocked({ role: decision.role, departmentId: decision.departmentId })) {
          await record('login_rejected', { id: authUser.id, departmentId: decision.departmentId });
          throw new Error(SSO_ONLY);
        }
        if (await lockIfDormant(dormantDeps(), authUser.id)) {
          await record('login_rejected', { id: authUser.id, departmentId: decision.departmentId });
          throw new Error(ACCOUNT_DORMANT);
        }
        await record('login', { id: authUser.id, departmentId: decision.departmentId });

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
        // 로그인한 때 — 토큰을 다시 쓸 때(세션 갱신) 바뀌는 iat와 달리 그대로 남는다. 비밀번호를 바꾼 뒤 옛 로그인을 끝내는 기준(미들웨어)
        token.authAt = Date.now();
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.role = token.role as 'ADMIN' | 'USER';
        session.user.departmentId = token.departmentId ?? null;
        // 기관 계정(SSO)으로 들어온 로그인 — 로그아웃할 때 계정 서비스에서도 로그아웃할지 보는 데 쓴다(0111)
        if (token.sso === true) session.user.sso = true;
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
/** 저장해 둔 비밀번호로 확인 — 맞으면 사용자, 아니면 null, 사용자를 못 읽었으면 'unavailable'(실패로 세지 않게, 2026-11-20) */
async function authorizeWithPasswordHash(email: string, password: string) {
  const { data: user, error } = await supabaseAdmin
    .from('users')
    .select('id, email, role, full_name, department_id, password_hash, is_active, deleted_at')
    .eq('email', email)
    .maybeSingle();

  if (error) return 'unavailable' as const;
  if (!user?.password_hash || !canSignIn(user)) return null;

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
