'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { apiSend, type ActionResult } from '@/lib/api';
import { agentConfig } from '@/lib/format';

const AGENT_URL = process.env.PUBLIC_AGENT_URL ?? process.env.API_URL ?? 'http://localhost:3001';
const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();

export async function createTenant(_: ActionResult | undefined, f: FormData): Promise<ActionResult> {
  const r = await apiSend<{ id: string }>('POST', '/api/admin/tenants', { name: str(f, 'name') });
  if (!r.ok) return { error: r.error };
  redirect(`/admin/empresas/${r.data.id}`);
}

export async function renameTenant(id: string, _: ActionResult | undefined, f: FormData): Promise<ActionResult> {
  const r = await apiSend('PATCH', `/api/admin/tenants/${id}`, { name: str(f, 'name') });
  if (!r.ok) return { error: r.error };
  revalidatePath(`/admin/empresas/${id}`);
  return { ok: 'Nome salvo.' };
}

export async function createLicense(tenantId: string, _: ActionResult | undefined, f: FormData): Promise<ActionResult> {
  const r = await apiSend('POST', `/api/admin/tenants/${tenantId}/licenses`, {
    plan: str(f, 'plan'),
    max_agents: str(f, 'max_agents'),
    max_volume: `${str(f, 'volume')}${str(f, 'unit')}`,
    valid_from: str(f, 'valid_from'),
    valid_until: str(f, 'valid_until'),
    retention_days: str(f, 'retention_days'),
  });
  if (!r.ok) return { error: r.error };
  revalidatePath(`/admin/empresas/${tenantId}`);
  return { ok: 'Licença criada.' };
}

export async function revokeLicense(tenantId: string, licenseId: string): Promise<ActionResult> {
  const r = await apiSend('POST', `/api/admin/licenses/${licenseId}/revoke`);
  if (!r.ok) return { error: r.error };
  revalidatePath(`/admin/empresas/${tenantId}`);
  return { ok: 'Licença revogada.' };
}

export async function createToken(tenantId: string, _: ActionResult | undefined, f: FormData): Promise<ActionResult> {
  const r = await apiSend<{ token: string; expires_at: string; max_uses: number }>('POST', `/api/admin/tenants/${tenantId}/tokens`, {
    description: str(f, 'description'),
    max_uses: str(f, 'max_uses'),
    ttl_hours: str(f, 'ttl_hours'),
  });
  if (!r.ok) return { error: r.error };
  revalidatePath(`/admin/empresas/${tenantId}`);
  return {
    ok: `Token criado para ${r.data.max_uses} instalação(ões).`,
    secret: { label: 'Token de instalação do agente.', value: r.data.token, config: agentConfig(AGENT_URL, r.data.token) },
  };
}

export async function revokeToken(tenantId: string, tokenId: string): Promise<ActionResult> {
  const r = await apiSend('POST', `/api/admin/tokens/${tokenId}/revoke`);
  if (!r.ok) return { error: r.error };
  revalidatePath(`/admin/empresas/${tenantId}`);
  return { ok: 'Token revogado.' };
}

export async function disableAgent(tenantId: string, agentId: string): Promise<ActionResult> {
  const r = await apiSend('POST', `/api/admin/agents/${agentId}/disable`);
  if (!r.ok) return { error: r.error };
  revalidatePath(`/admin/empresas/${tenantId}`);
  return { ok: 'Servidor desativado.' };
}

export async function createUser(_: ActionResult | undefined, f: FormData): Promise<ActionResult> {
  const role = str(f, 'role');
  const r = await apiSend<{ email: string; password?: string }>('POST', '/api/admin/users', {
    name: str(f, 'name'),
    email: str(f, 'email'),
    role,
    tenant_id: role === 'msp_admin' ? '' : str(f, 'tenant_id'),
    password: str(f, 'password'),
  });
  if (!r.ok) return { error: r.error };
  revalidatePath('/admin/usuarios');
  return r.data.password
    ? { ok: `Usuário ${r.data.email} criado.`, secret: { label: 'Senha inicial gerada.', value: r.data.password } }
    : { ok: `Usuário ${r.data.email} criado.` };
}

export async function setUserDisabled(userId: string, disabled: boolean): Promise<ActionResult> {
  const r = await apiSend('PATCH', `/api/admin/users/${userId}`, { disabled });
  if (!r.ok) return { error: r.error };
  revalidatePath('/admin/usuarios');
  return { ok: disabled ? 'Usuário desativado.' : 'Usuário reativado.' };
}

export async function resetPassword(userId: string): Promise<ActionResult> {
  const r = await apiSend<{ password?: string }>('POST', `/api/admin/users/${userId}/password`);
  if (!r.ok) return { error: r.error };
  return { ok: 'Senha redefinida; as sessões abertas foram encerradas.', secret: { label: 'Nova senha.', value: r.data.password ?? '' } };
}

export async function deleteUser(userId: string): Promise<ActionResult> {
  const r = await apiSend('DELETE', `/api/admin/users/${userId}`);
  if (!r.ok) return { error: r.error };
  revalidatePath('/admin/usuarios');
  return { ok: 'Usuário excluído.' };
}
