'use server';

import { revalidatePath } from 'next/cache';
import { apiSend, type ActionResult } from '@/lib/api';

// "Atualizar agora": o agente coleta na próxima consulta (até 2 minutos).
export async function refreshPermissions(tenantId: string, agentId: string): Promise<ActionResult> {
  const r = await apiSend<{ requested: number }>('POST', '/api/permissions/refresh', { tenant: tenantId || undefined, agent: agentId || undefined });
  if (!r.ok) return { error: r.error };
  revalidatePath('/permissoes');
  return { ok: 'Coleta pedida. O agente começa em até 2 minutos.' };
}
