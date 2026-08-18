import { Suspense } from 'react';
import LoginForm from '@/components/auth/LoginForm';

export default function LoginPage() {
  return (
    <Suspense fallback={
      <main className="min-h-screen bg-gradient-to-br from-[#001a5c] via-[#003087] to-[#0066CC]" />
    }>
      <LoginForm />
    </Suspense>
  );
}
