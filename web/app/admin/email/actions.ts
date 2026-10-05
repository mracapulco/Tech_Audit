'use server';

import { revalidatePath } from 'next/cache';
import { apiSend, type ActionResult } from '@/lib/api';

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();

export async function saveMail(_: ActionResult | undefined, f: FormData): Promise<ActionResult> {
  const keys = ['provider', 'from_address', 'from_name', 'portal_url', 'smtp_host', 'smtp_port', 'smtp_security', 'smtp_user', 'smtp_password', 'ms_tenant_id', 'ms_client_id', 'ms_client_secret'];
  const r = await apiSend('POST', '/api/admin/mail', Object.fromEntries(keys.map((k) => [k, str(f, k)])));
  if (!r.ok) return { error: r.error };
  revalidatePath('/admin/email');
  return { ok: 'Configuração salva. Use "Enviar teste" para conferir.' };
}

export async function testMail(_: ActionResult | undefined, f: FormData): Promise<ActionResult> {
  const r = await apiSend<{ to: string[] }>('POST', '/api/admin/mail/test', { to: str(f, 'to') });
  if (!r.ok) return { error: r.error };
  return { ok: `E-mail de teste enviado para ${r.data.to.join(', ')}. Confira a caixa de entrada (e o lixo eletrônico).` };
}
