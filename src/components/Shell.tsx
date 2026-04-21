import { ReactNode } from 'react';
import Navigation from './Navigation';

export default function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50">
      <Navigation />
      <main className="px-6 py-8 mx-auto max-w-6xl">{children}</main>
    </div>
  );
}
