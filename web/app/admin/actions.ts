'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { FormResult } from '@/components/action-form';
import { agentServerUrl, linuxRegisterCommand, silentInstallCommand } from '@/lib/agent';
import { apiFetch, apiSend, sessionToken, type ActionResult } from '@/lib/api';
import { agentConfig } from '@/lib/format';

const AGENT_URL = agentServerUrl(process.env.PUBLIC_AGENT_URL ?? process.env.API_URL ?? 'http://localhost:3001');
const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
// As mesmas informações aparecem em várias abas (licença, servidores, usuários, painel).
const refresh = () => revalidatePath('/', 'layout');

export async function createTenant(_: ActionResult | undefined, f: FormData): Promise<ActionResult> {
  const r = await apiSend<{ id: string }>('POST', '/api/admin/tenants', { name: str(f, 'name') });
  if (!r.ok) return { error: r.error };
  // Empresa nova começa pela licença, sem ela os agentes não se registram.
  redirect(`/licenca?cliente=${r.data.id}`);
}

export async function renameTenant(id: string, _: ActionResult | undefined, f: FormData): Promise<ActionResult> {
  const r = await apiSend('PATCH', `/api/admin/tenants/${id}`, { name: str(f, 'name') });
  if (!r.ok) return { error: r.error };
  refresh();
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
  refresh();
  return { ok: 'Licença criada.' };
}

export async function updateLicense(tenantId: string, licenseId: string, _: ActionResult | undefined, f: FormData): Promise<ActionResult> {
  const r = await apiSend('PATCH', `/api/admin/licenses/${licenseId}`, {
    plan: str(f, 'plan'),
    max_agents: str(f, 'max_agents'),
    max_volume: `${str(f, 'volume')}${str(f, 'unit')}`,
    valid_from: str(f, 'valid_from'),
    valid_until: str(f, 'valid_until'),
    retention_days: str(f, 'retention_days'),
    grace_days: str(f, 'grace_days'),
  });
  if (!r.ok) return { error: r.error };
  refresh();
  return { ok: 'Licença alterada.' };
}

export async function revokeLicense(tenantId: string, licenseId: string): Promise<ActionResult> {
  const r = await apiSend('POST', `/api/admin/licenses/${licenseId}/revoke`);
  if (!r.ok) return { error: r.error };
  refresh();
  return { ok: 'Licença revogada.' };
}

export async function createToken(tenantId: string, _: FormResult | undefined, f: FormData): Promise<FormResult> {
  const r = await apiSend<{ token: string; expires_at: string; max_uses: number }>('POST', `/api/admin/tenants/${tenantId}/tokens`, {
    description: str(f, 'description'),
    max_uses: str(f, 'max_uses'),
    ttl_hours: str(f, 'ttl_hours'),
  });
  if (!r.ok) return { error: r.error };
  refresh();
  return {
    ok: `Token criado para ${r.data.max_uses} instalação(ões).`,
    secret: {
      label: 'Token de instalação do agente.',
      value: r.data.token,
      server: AGENT_URL,
      command: silentInstallCommand(await installerName(), AGENT_URL, r.data.token),
      linuxCommand: linuxRegisterCommand(AGENT_URL, r.data.token),
      config: agentConfig(AGENT_URL, r.data.token),
    },
  };
}

// Nome do MSI disponível para download, para o comando de instalação silenciosa.
async function installerName(): Promise<string> {
  try {
    const r = await apiFetch('/api/agent/installer', { token: await sessionToken() });
    const i = r.ok ? ((await r.json()) as { file_name?: string }) : {};
    return i.file_name ?? 'TechAuditAgent.msi';
  } catch {
    return 'TechAuditAgent.msi';
  }
}

export async function revokeToken(tenantId: string, tokenId: string): Promise<ActionResult> {
  const r = await apiSend('POST', `/api/admin/tokens/${tokenId}/revoke`);
  if (!r.ok) return { error: r.error };
  refresh();
  return { ok: 'Token revogado.' };
}

export async function disableAgent(tenantId: string, agentId: string): Promise<ActionResult> {
  const r = await apiSend('POST', `/api/admin/agents/${agentId}/disable`);
  if (!r.ok) return { error: r.error };
  refresh();
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
  refresh();
  return r.data.password
    ? { ok: `Usuário ${r.data.email} criado.`, secret: { label: 'Senha inicial gerada.', value: r.data.password } }
    : { ok: `Usuário ${r.data.email} criado.` };
}

export async function setUserDisabled(userId: string, disabled: boolean): Promise<ActionResult> {
  const r = await apiSend('PATCH', `/api/admin/users/${userId}`, { disabled });
  if (!r.ok) return { error: r.error };
  refresh();
  return { ok: disabled ? 'Usuário desativado.' : 'Usuário reativado.' };
}

export async function renameUser(userId: string, _: ActionResult | undefined, f: FormData): Promise<ActionResult> {
  const r = await apiSend('PATCH', `/api/admin/users/${userId}`, { name: str(f, 'name') });
  if (!r.ok) return { error: r.error };
  refresh();
  return { ok: 'Nome atualizado.' };
}

// Com a senha preenchida, usa a escolhida; em branco, gera uma e mostra uma vez.
export async function resetPassword(userId: string, _: ActionResult | undefined, f: FormData): Promise<ActionResult> {
  const password = String(f.get('password') ?? '');
  if (password && password !== String(f.get('confirm') ?? '')) return { error: 'As duas senhas não conferem.' };
  const r = await apiSend<{ password?: string }>('POST', `/api/admin/users/${userId}/password`, password ? { password } : {});
  if (!r.ok) return { error: r.error };
  return r.data.password
    ? { ok: 'Senha redefinida; as sessões abertas foram encerradas.', secret: { label: 'Nova senha.', value: r.data.password } }
    : { ok: 'Senha definida; as sessões abertas foram encerradas.' };
}

export async function deleteUser(userId: string): Promise<ActionResult> {
  const r = await apiSend('DELETE', `/api/admin/users/${userId}`);
  if (!r.ok) return { error: r.error };
  refresh();
  return { ok: 'Usuário excluído.' };
}

export async function resetMfa(userId: string): Promise<ActionResult> {
  const r = await apiSend('POST', `/api/admin/users/${userId}/mfa/reset`);
  if (!r.ok) return { error: r.error };
  refresh();
  return { ok: 'Verificação redefinida; as sessões abertas foram encerradas.' };
}
