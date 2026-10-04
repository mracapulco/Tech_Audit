import { redirect } from 'next/navigation';
import { withTenant, tenantParam } from '@/lib/workspace';

// Endereço antigo do histórico de caminhos auditados.
export default async function OldHistoryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  redirect(withTenant('/servidores/historico', tenantParam(await searchParams)));
}
