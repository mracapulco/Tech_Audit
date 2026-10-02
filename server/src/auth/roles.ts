// Perfis do portal (docs/ARCHITECTURE.md, seção 6.2).
export const MSP_ROLES = ['msp_admin', 'msp_operator'] as const;
export const TENANT_ROLES = ['tenant_admin', 'tenant_auditor'] as const;
export const ROLES = [...MSP_ROLES, ...TENANT_ROLES] as const;
export type Role = (typeof ROLES)[number];

export const isRole = (v: string): v is Role => (ROLES as readonly string[]).includes(v);
// Equipe Tech Master: enxerga todos os tenants.
export const isMspRole = (r: string) => (MSP_ROLES as readonly string[]).includes(r);

export interface PortalUser {
  id: string;
  tenantId: string | null;
  email: string;
  name: string;
  role: Role;
  sessionId: string;
}
