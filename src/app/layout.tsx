import type { Metadata } from 'next';
import './globals.css';
import { Providers } from '@/components/providers';

export const metadata: Metadata = {
  title: 'WORKON',
  description: 'Internal document management and AI-powered reporting platform.'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <Providers>
          {/* 기본 레이아웃: 헤더/푸터는 추후 확장 가능합니다. */}
          {children}
        </Providers>
      </body>
    </html>
  );
}
