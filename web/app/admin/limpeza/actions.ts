'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { apiSend, type ActionResult } from '@/lib/api';

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();

export async function startPurge(_: ActionResult | undefined, f: FormData): Promise<ActionResult> {
  const r = await apiSend('POST', '/api/admin/purges', {
    tenant_id: str(f, 'tenant_id'),
    agent_id: str(f, 'agent_id'),
    mode: str(f, 'mode'),
    from: str(f, 'from'),
    to: str(f, 'to'),
  });
  if (!r.ok) return { error: r.error };
  revalidatePath('/admin/limpeza');
  redirect('/admin/limpeza?iniciada=1');
}
