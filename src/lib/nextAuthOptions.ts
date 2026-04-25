import type { AuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';
import { supabase } from '@/lib/supabase';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { NEXTAUTH_SECRET } from '@/lib/config';

const ADMIN_EMAILS = ['admin@welfare.org', 'admin@researchcenter.kr'];
const ADMIN_DEPARTMENT_SLUG = 'admin-team';

async function getDepartmentIdBySlug(slug: string) {
  const { data: department, error } = await supabaseAdmin
    .from('departments')
    .select('id')
    .eq('slug', slug)
    .maybeSingle();

  if (error) {
    console.warn('[nextAuth] department lookup failed:', error.message);
    return null;
  }

  return department?.id ?? null;
}

async function getDefaultDepartmentId() {
  const { data: departments, error } = await supabaseAdmin
    .from('departments')
    .select('id')
    .order('created_at', { ascending: true })
    .limit(1);

  if (error || !departments?.length) {
    console.warn('[nextAuth] default department lookup failed:', error?.message);
    return null;
  }

  return departments[0].id;
}

async function assignDefaultDepartmentToUser(userId: string, isAdminEmail: boolean) {
  const defaultDepartmentId = isAdminEmail
    ? await getDepartmentIdBySlug(ADMIN_DEPARTMENT_SLUG)
    : await getDefaultDepartmentId();

  if (!defaultDepartmentId) {
    return null;
  }

  const { error } = await supabaseAdmin
    .from('users')
    .update({ department_id: defaultDepartmentId })
    .eq('id', userId);

  if (error) {
    console.warn('[nextAuth] default department assign failed:', error.message);
    return null;
  }

  return defaultDepartmentId;
}

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

        // 이메일 확인되지 않은 계정도 허용
        const authUser = authData.user;
        const isAdminEmail = ADMIN_EMAILS.includes(authUser.email ?? '');
        const { data: existingUser, error: fetchError } = await supabaseAdmin
          .from('users')
          .select('id, email, role, full_name, department_id')
          .eq('id', authUser.id)
          .maybeSingle();

        if (fetchError) {
          console.warn('[nextAuth] users table access failed, continue with auth user only:', fetchError.message);
        }

        let role = 'USER';
        let fullName = authUser.user_metadata?.full_name || authUser.email || undefined;
        let departmentId: string | null = null;

        if (existingUser) {
          role = (existingUser.role ?? 'USER').toString().toUpperCase();
          fullName = existingUser.full_name || fullName;
          departmentId = existingUser.department_id ?? null;

          if (!departmentId) {
            departmentId = await assignDefaultDepartmentToUser(authUser.id, isAdminEmail);
          }
        }

        if (!existingUser && !fetchError) {
          const defaultDepartmentId = isAdminEmail
            ? await getDepartmentIdBySlug(ADMIN_DEPARTMENT_SLUG)
            : await getDefaultDepartmentId();

          const insertData = {
            id: authUser.id,
            email: authUser.email,
            full_name: fullName,
            role: isAdminEmail ? 'ADMIN' : 'USER',
            department_id: defaultDepartmentId,
          };

          const { error: createError } = await supabaseAdmin.from('users').insert(insertData);
          if (createError) {
            console.warn('[nextAuth] users insert failed:', createError.message);
          }

          role = isAdminEmail ? 'ADMIN' : 'USER';
          departmentId = defaultDepartmentId;
        }

        if (!existingUser && fetchError && isAdminEmail) {
          role = 'ADMIN';
        }

        if (!departmentId) {
          departmentId = isAdminEmail
            ? await getDepartmentIdBySlug(ADMIN_DEPARTMENT_SLUG)
            : await getDefaultDepartmentId();
        }

        // 사용자 최종 정보 재조회
        if (authUser.id) {
          const { data: finalUser, error: finalFetchError } = await supabaseAdmin
            .from('users')
            .select('id, email, role, full_name, department_id')
            .eq('id', authUser.id)
            .maybeSingle();

          if (!finalFetchError && finalUser) {
            role = (finalUser.role ?? role).toString().toUpperCase();
            fullName = finalUser.full_name || fullName;
            departmentId = finalUser.department_id ?? departmentId;
          }
        }

        return {
          id: authUser.id,
          email: authUser.email ?? '',
          name: fullName,
          role: role === 'ADMIN' ? 'ADMIN' : 'USER',
          departmentId: departmentId
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
    .select('id, email, role, full_name, department_id, password_hash')
    .eq('email', email)
    .maybeSingle();

  if (error || !user?.password_hash) return null;

  const isValid = await bcrypt.compare(password, user.password_hash);
  if (!isValid) return null;

  return {
    id: user.id,
    email: user.email ?? '',
    name: user.full_name ?? user.email ?? '',
    role: (user.role ?? 'USER').toString().toUpperCase() === 'ADMIN' ? 'ADMIN' : 'USER',
    departmentId: user.department_id ?? null,
  } as any;
}
