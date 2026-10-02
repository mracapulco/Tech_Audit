// Formatação para as telas de administração. Sem dependências, para testar com node --test.

export const ROLE_LABELS: Record<string, string> = {
  msp_admin: 'Administrador',
  msp_operator: 'Operador Tech Master',
  tenant_admin: 'Cliente administrador',
  tenant_auditor: 'Cliente',
};
export const roleLabel = (r: string) => ROLE_LABELS[r] ?? r;

export const LICENSE_STATUS: Record<string, { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' }> = {
  active: { label: 'Vigente', tone: 'ok' },
  grace: { label: 'Em tolerância', tone: 'warn' },
  scheduled: { label: 'Agendada', tone: 'neutral' },
  expired: { label: 'Vencida', tone: 'bad' },
  revoked: { label: 'Revogada', tone: 'bad' },
  none: { label: 'Sem licença', tone: 'bad' },
};
export const licenseStatus = (s: string) => LICENSE_STATUS[s] ?? { label: s, tone: 'neutral' as const };

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

// "2199023255552" -> "2 TB" (base 1024, como o Windows mostra).
export function formatBytes(v: string | number | bigint): string {
  let n = Number(v);
  let i = 0;
  while (n >= 1024 && i < UNITS.length - 1) {
    n /= 1024;
    i++;
  }
  const s = Number.isInteger(n) ? String(n) : n.toFixed(1).replace('.', ',');
  return `${s} ${UNITS[i]}`;
}

const BRT_OFFSET_MS = -3 * 3600_000;

// Data (sem hora) em Brasília: "30/09/2027".
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '-';
  const s = new Date(new Date(iso).getTime() + BRT_OFFSET_MS).toISOString();
  return `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;
}

// Fim de vigência: a API guarda o instante seguinte ao último dia (24:00 em
// Brasília), então o último dia válido é um milissegundo antes.
export const formatLastDay = (iso: string | null | undefined) =>
  iso ? formatDate(new Date(new Date(iso).getTime() - 1).toISOString()) : '-';

export function formatDateTimeShort(iso: string | null | undefined): string {
  if (!iso) return '-';
  const s = new Date(new Date(iso).getTime() + BRT_OFFSET_MS).toISOString();
  return `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)} ${s.slice(11, 16)}`;
}

// Hoje e daqui a um ano em Brasília, para preencher a nova licença.
export function defaultLicenseDates(now = new Date()): { from: string; until: string } {
  const today = new Date(now.getTime() + BRT_OFFSET_MS);
  const from = today.toISOString().slice(0, 10);
  const end = new Date(today);
  end.setUTCFullYear(end.getUTCFullYear() + 1);
  end.setUTCDate(end.getUTCDate() - 1);
  return { from, until: end.toISOString().slice(0, 10) };
}

// Configuração do agente com o token de instalação já preenchido.
export function agentConfig(agentUrl: string, token: string): string {
  return JSON.stringify(
    {
      endpoint: `${agentUrl.replace(/\/$/, '')}/v1/events`,
      enrollment_token: token,
      credentials_file: 'C:\\ProgramData\\TechAudit\\credentials.json',
      state_file: 'C:\\ProgramData\\TechAudit\\bookmark.xml',
    },
    null,
    2,
  );
}
