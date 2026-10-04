import { redirect } from 'next/navigation';

// Endereço antigo da página da empresa: hoje é o espaço da empresa, aba Licença e contrato.
export default async function OldTenantPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/licenca?cliente=${encodeURIComponent(id)}`);
}
