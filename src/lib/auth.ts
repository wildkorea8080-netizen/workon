import { getServerSession } from 'next-auth/next';
import { authOptions } from './nextAuthOptions';
import type { Session } from 'next-auth';

export async function getServerAuthSession(): Promise<Session | null> {
  return await getServerSession(authOptions);
}

export async function getAdminSession(): Promise<Session | null> {
  const session = await getServerAuthSession();
  return session?.user?.role === 'ADMIN' ? session : null;
}

export function isAdminSession(session: Session | null): boolean {
  return session?.user?.role === 'ADMIN';
}
