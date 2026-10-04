import { redirect } from 'next/navigation';
import { withTenant, tenantParam } from '@/lib/workspace';

// Endereço antigo da tela de caminhos auditados, hoje a aba Servidores.
export default async function OldConfigPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  redirect(withTenant('/servidores', tenantParam(await searchParams)));
}
