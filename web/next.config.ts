import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Gera .next/standalone com só o necessário para rodar no contêiner.
  output: 'standalone',
};

export default nextConfig;
