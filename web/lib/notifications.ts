// Aba "Alertas e e-mails": rótulos e regras simples da tela. Sem dependências,
// para testar com node --test.

export const FREQUENCIES: [string, string][] = [
  ['daily', 'Diário (dia anterior)'],
  ['weekly', 'Semanal (7 dias anteriores)'],
  ['monthly', 'Mensal (mês anterior, no dia 1º)'],
];

export const WEEKDAYS: [number, string][] = [
  [1, 'Segunda-feira'],
  [2, 'Terça-feira'],
  [3, 'Quarta-feira'],
  [4, 'Quinta-feira'],
  [5, 'Sexta-feira'],
  [6, 'Sábado'],
  [7, 'Domingo'],
];

export const HOURS = Array.from({ length: 24 }, (_, h) => [h, `${String(h).padStart(2, '0')}:00`] as [number, string]);

export const FORMATS: [string, string][] = [
  ['pdf', 'PDF'],
  ['xlsx', 'Excel'],
];

type Tone = 'ok' | 'warn' | 'bad' | 'neutral';

const STATUS: Record<string, { label: string; tone: Tone }> = {
  sent: { label: 'Enviado', tone: 'ok' },
  failed: { label: 'Falhou', tone: 'bad' },
  skipped: { label: 'Não enviado', tone: 'warn' },
};

export const deliveryStatus = (s: string | null) => (s ? (STATUS[s] ?? { label: s, tone: 'neutral' as Tone }) : { label: 'Ainda não enviado', tone: 'neutral' as Tone });

const KINDS: Record<string, string> = { alert: 'Alertas', report: 'Relatório agendado', test: 'Teste' };
export const deliveryKind = (k: string) => KINDS[k] ?? k;

// Destinatários num campo de texto: um por linha.
export const recipientsText = (list: string[]) => list.join('\n');

// Quem altera: administradores do cliente e a equipe Tech Master.
export const canEditNotifications = (role: string) => role === 'msp_admin' || role === 'msp_operator' || role === 'tenant_admin';
