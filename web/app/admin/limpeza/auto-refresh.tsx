'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

// Atualiza a página enquanto alguma limpeza estiver em andamento.
export function AutoRefresh({ seconds = 3 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(t);
  }, [router, seconds]);
  return null;
}
