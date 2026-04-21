import type { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  interface Session {
    user: {
      name?: string | null;
      email?: string | null;
      id?: string;
      role?: 'ADMIN' | 'USER';
      departmentId?: string | null;
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
  }
}
