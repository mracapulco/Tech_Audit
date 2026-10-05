// Planos de licença; espelha server/src/licensing/plans.ts. Servidores e volume
// são contratados à parte em qualquer plano.

export const PLANS: Record<string, { retentionDays: number; auditRead: boolean; email: boolean }> = {
  Essencial: { retentionDays: 90, auditRead: false, email: false },
  Profissional: { retentionDays: 365, auditRead: true, email: true },
  Enterprise: { retentionDays: 1825, auditRead: true, email: true },
};

export const PLAN_NAMES = Object.keys(PLANS);

export function planSummary(plan: string): string {
  if (!Object.hasOwn(PLANS, plan)) return 'Plano fora da lista: todos os recursos liberados.';
  const p = PLANS[plan];
  return `Retenção padrão de ${retentionLabel(p.retentionDays)}; ${p.auditRead ? 'inclui' : 'sem'} auditoria de leitura; ${p.email ? 'com' : 'sem'} alertas e relatórios por e-mail.`;
}

export function retentionLabel(days: number): string {
  if (days % 365 === 0) return days === 365 ? '1 ano' : `${days / 365} anos`;
  return `${days} dias`;
}
