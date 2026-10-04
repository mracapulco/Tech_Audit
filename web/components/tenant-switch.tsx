'use client';

import { usePathname, useRouter } from 'next/navigation';
import { switchTarget } from '@/lib/workspace';

// Troca de empresa na barra roxa (Tech Master). Fica na mesma aba quando ela
// existe para a empresa escolhida.
export function TenantSwitch({ role, tenants, current }: { role: string; tenants: { id: string; name: string }[]; current: string }) {
  const router = useRouter();
  const pathname = usePathname();
  return (
    <label className="tenant-switch">
      <span className="sr-only">Empresa</span>
      <select value={current} onChange={(e) => router.push(switchTarget(pathname, role, e.target.value))}>
        <option value="">{current ? 'Todas as empresas' : 'Escolher empresa…'}</option>
        {tenants.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    </label>
  );
}
