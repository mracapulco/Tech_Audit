'use server';

import { revalidatePath } from 'next/cache';
import { apiGet, apiSend, type CurrentUser } from '@/lib/api';
import { otpauthUrl, qrDataUrl } from '@/lib/mfa';

export type MfaState = { error?: string; ok?: string; qr?: string; secret?: string } | undefined;

// Gera o QR code; a verificação só passa a valer depois do primeiro código.
export async function startMfa(): Promise<MfaState> {
  const r = await apiSend<{ secret: string }>('POST', '/api/auth/mfa/setup');
  if (!r.ok) return { error: r.error };
  const me = await apiGet<CurrentUser>('/api/auth/me');
  return { secret: r.data.secret, qr: await qrDataUrl(otpauthUrl(r.data.secret, me.email)) };
}

export async function confirmMfa(prev: MfaState, f: FormData): Promise<MfaState> {
  const r = await apiSend('POST', '/api/auth/mfa/enable', { code: String(f.get('code') ?? '').replace(/\s/g, '') });
  if (!r.ok) return { ...prev, error: r.error, ok: undefined };
  revalidatePath('/conta');
  return { ok: 'Verificação em duas etapas ativada.' };
}

export async function disableMfa(_: MfaState, f: FormData): Promise<MfaState> {
  const r = await apiSend('POST', '/api/auth/mfa/disable', { password: String(f.get('password') ?? '') });
  if (!r.ok) return { error: r.error };
  revalidatePath('/conta');
  return { ok: 'Verificação em duas etapas desativada.' };
}
