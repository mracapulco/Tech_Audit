import type { Metadata } from 'next';
import localFont from 'next/font/local';
import type { ReactNode } from 'react';
import './globals.css';

// Fonte da identidade visual da Tech Master (Expo), servida pelo próprio portal.
const expo = localFont({
  src: [
    { path: './fonts/expo-book.ttf', weight: '400', style: 'normal' },
    { path: './fonts/expo-medium.ttf', weight: '500', style: 'normal' },
    { path: './fonts/expo-bold.ttf', weight: '700', style: 'normal' },
    { path: './fonts/expo-black.ttf', weight: '900', style: 'normal' },
  ],
  variable: '--font-brand',
  display: 'swap',
  fallback: ['system-ui', 'Segoe UI', 'sans-serif'],
});

export const metadata: Metadata = {
  title: 'Tech Audit',
  description: 'Auditoria de servidores de arquivos',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR" className={expo.variable}>
      <body>{children}</body>
    </html>
  );
}
