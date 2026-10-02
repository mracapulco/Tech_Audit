import type { NextConfig } from 'next';

// Cabeçalhos de segurança em todas as páginas: o portal não pode ser aberto
// dentro de outro site (clickjacking), o navegador não adivinha tipos de
// arquivo e formulários só enviam para o próprio portal.
const securityHeaders = [
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'same-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const nextConfig: NextConfig = {
  // Gera .next/standalone com só o necessário para rodar no contêiner.
  output: 'standalone',
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
