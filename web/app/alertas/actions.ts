'use server';

import { revalidatePath } from 'next/cache';
import { apiSend, type ActionResult } from '@/lib/api';

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const q = (tenantId: string) => (tenantId ? `?tenant=${tenantId}` : '');

export async function saveAlerts(tenantId: string, _: ActionResult | undefined, f: FormData): Promise<ActionResult> {
  const r = await apiSend('POST', `/api/notifications/alerts${q(tenantId)}`, {
    recipients: str(f, 'recipients'),
    groups: f.getAll('groups').map(String),
    mass_delete_threshold: str(f, 'mass_delete_threshold'),
    mass_delete_window_minutes: str(f, 'mass_delete_window_minutes'),
  });
  if (!r.ok) return { error: r.error };
  revalidatePath('/alertas');
  return { ok: 'Alertas salvos.' };
}

export async function sendTest(tenantId: string): Promise<ActionResult> {
  const r = await apiSend<{ recipients: string[] }>('POST', `/api/notifications/test${q(tenantId)}`);
  if (!r.ok) return { error: r.error };
  revalidatePath('/alertas');
  return { ok: `E-mail de teste enviado para ${r.data.recipients.join(', ')}.` };
}

function schedule(f: FormData) {
  return {
    name: str(f, 'name'),
    report_type: str(f, 'report_type'),
    format: str(f, 'format'),
    frequency: str(f, 'frequency'),
    weekday: str(f, 'weekday'),
    hour: str(f, 'hour'),
    filter_user: str(f, 'filter_user'),
    filter_path: str(f, 'filter_path'),
    filter_action: str(f, 'filter_action'),
    recipients: str(f, 'recipients'),
  };
}

export async function createReport(tenantId: string, _: ActionResult | undefined, f: FormData): Promise<ActionResult> {
  const r = await apiSend<{ name: string }>('POST', `/api/notifications/reports${q(tenantId)}`, schedule(f));
  if (!r.ok) return { error: r.error };
  revalidatePath('/alertas');
  return { ok: `${r.data.name} agendado.` };
}

export async function updateReport(id: string, _: ActionResult | undefined, f: FormData): Promise<ActionResult> {
  const r = await apiSend('PATCH', `/api/notifications/reports/${id}`, { ...schedule(f), enabled: true });
  if (!r.ok) return { error: r.error };
  revalidatePath('/alertas');
  return { ok: 'Alterações salvas.' };
}

export async function setReportEnabled(id: string, enabled: boolean): Promise<ActionResult> {
  const r = await apiSend('PATCH', `/api/notifications/reports/${id}`, { enabled });
  if (!r.ok) return { error: r.error };
  revalidatePath('/alertas');
  return { ok: enabled ? 'Envio retomado.' : 'Envio pausado.' };
}

export async function sendReportNow(id: string): Promise<ActionResult> {
  const r = await apiSend<{ recipients: string[] }>('POST', `/api/notifications/reports/${id}/send`);
  if (!r.ok) return { error: r.error };
  revalidatePath('/alertas');
  return { ok: `Enviado para ${r.data.recipients.join(', ')}.` };
}

export async function deleteReport(id: string): Promise<ActionResult> {
  const r = await apiSend('DELETE', `/api/notifications/reports/${id}`);
  if (!r.ok) return { error: r.error };
  revalidatePath('/alertas');
  return { ok: 'Relatório agendado excluído.' };
}
