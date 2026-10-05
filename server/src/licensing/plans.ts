// Planos de licença (docs/ARCHITECTURE.md, seção 9.2). Servidores e volume são
// contratados à parte em qualquer plano; o plano define a retenção padrão e
// os recursos liberados.

export interface PlanFeatures {
  // Retenção sugerida ao criar a licença ou trocar o plano (pode ser alterada).
  retentionDays: number;
  // Auditoria de leitura (quem abriu o arquivo) nos caminhos auditados.
  auditRead: boolean;
  // Inventário de permissões (quem tem acesso a cada pasta auditada).
  permissionsInventory: boolean;
}

export const PLANS: Record<string, PlanFeatures> = {
  Essencial: { retentionDays: 90, auditRead: false, permissionsInventory: false },
  Profissional: { retentionDays: 365, auditRead: true, permissionsInventory: false },
  Enterprise: { retentionDays: 1825, auditRead: true, permissionsInventory: true },
};

export const DEFAULT_PLAN = 'Essencial';

// Nomes fora da lista (licenças antigas ou personalizadas) não perdem recursos.
const OTHER: PlanFeatures = { retentionDays: 365, auditRead: true, permissionsInventory: true };

export function planFeatures(plan: string): PlanFeatures {
  return Object.hasOwn(PLANS, plan) ? PLANS[plan] : OTHER;
}

// Com várias licenças vigentes, vale o recurso de qualquer uma delas.
export function readAuditAllowed(licenses: { plan: string }[]): boolean {
  return licenses.some((l) => planFeatures(l.plan).auditRead);
}

export function permissionsInventoryAllowed(licenses: { plan: string }[]): boolean {
  return licenses.some((l) => planFeatures(l.plan).permissionsInventory);
}
