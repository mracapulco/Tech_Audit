'use server';

import { revalidatePath } from 'next/cache';
import { apiSend, type ActionResult } from '@/lib/api';

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const checked = (f: FormData, k: string) => f.get(k) === 'on';

// O formulário só chega aqui depois do aviso de que o agente vai alterar a
// SACL e a política de auditoria; a API exige confirm: true.

export async function addPath(agentId: string, _: ActionResult | undefined, f: FormData): Promise<ActionResult> {
  if (!checked(f, 'ciente')) return { error: 'Marque que está ciente da alteração no servidor.' };
  const r = await apiSend<{ path: string }>('POST', `/api/config/agents/${agentId}/paths`, {
    path: str(f, 'path'),
    recursive: checked(f, 'recursive'),
    audit_read: checked(f, 'audit_read'),
    exclusions: str(f, 'exclusions'),
    override_volume: checked(f, 'override_volume'),
    confirm: true,
  });
  if (!r.ok) return { error: r.error };
  revalidatePath('/servidores', 'layout');
  return { ok: `${r.data.path} cadastrado. O agente aplica na próxima consulta.` };
}

export async function updatePath(pathId: string, _: ActionResult | undefined, f: FormData): Promise<ActionResult> {
  const r = await apiSend('PATCH', `/api/config/paths/${pathId}`, {
    recursive: checked(f, 'recursive'),
    audit_read: checked(f, 'audit_read'),
    exclusions: str(f, 'exclusions'),
    confirm: true,
  });
  if (!r.ok) return { error: r.error };
  revalidatePath('/servidores', 'layout');
  return { ok: 'Opções salvas. O agente aplica na próxima consulta.' };
}

export async function removePath(pathId: string): Promise<ActionResult> {
  const r = await apiSend('DELETE', `/api/config/paths/${pathId}`, { confirm: true });
  if (!r.ok) return { error: r.error };
  revalidatePath('/servidores', 'layout');
  return { ok: 'Remoção pedida.' };
}

export async function reapplyPath(pathId: string): Promise<ActionResult> {
  const r = await apiSend('POST', `/api/config/paths/${pathId}/reapply`, { confirm: true });
  if (!r.ok) return { error: r.error };
  revalidatePath('/servidores', 'layout');
  return { ok: 'Reaplicação pedida.' };
}

export async function ackAlert(alertId: string): Promise<ActionResult> {
  const r = await apiSend('POST', `/api/config/alerts/${alertId}/ack`);
  if (!r.ok) return { error: r.error };
  revalidatePath('/servidores', 'layout');
  return { ok: 'Ok.' };
}
