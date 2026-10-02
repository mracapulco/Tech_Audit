import { randomBytes } from 'node:crypto';
import { hashPassword } from '../auth/passwords.js';
import { isMspRole, isRole, ROLES } from '../auth/roles.js';
import { generateToken, hashToken } from '../common/tokens.js';
import type { PrismaService } from '../prisma.service.js';

// Operações administrativas da Tech Master enquanto o portal não existe.
// Usadas pela CLI (src/cli.ts) e pelos testes.

const UNITS: Record<string, number> = { B: 0, KB: 1, MB: 2, GB: 3, TB: 4, PB: 5 };

// "2TB" -> bytes (base 1024, como o Windows mostra tamanhos).
export function parseVolume(v: string): bigint {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([KMGTP]?B)?\s*$/i.exec(v);
  if (!m) throw new Error(`volume inválido: ${v} (ex.: 500GB, 2TB)`);
  const exp = UNITS[(m[2] ?? 'B').toUpperCase()];
  return BigInt(Math.round(Number(m[1]) * 1024 ** exp));
}

// Datas sem hora são dias inteiros no horário de Brasília (UTC-3, sem horário
// de verão desde 2019): validFrom começa às 00:00 e validUntil termina às
// 24:00 do dia informado.
export function parseDay(v: string, end: boolean): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const d = new Date(`${v}T00:00:00-03:00`);
    if (end) d.setUTCDate(d.getUTCDate() + 1);
    return d;
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`data inválida: ${v}`);
  return d;
}

export async function createTenant(db: PrismaService, name: string) {
  return db.tenant.create({ data: { name } });
}

export async function createLicense(
  db: PrismaService,
  o: {
    tenantId: string;
    plan?: string;
    maxAgents: number;
    maxVolumeBytes: bigint;
    retentionDays?: number;
    validFrom: Date;
    validUntil: Date;
    graceDays?: number;
  },
) {
  return db.license.create({
    data: {
      tenantId: o.tenantId,
      plan: o.plan ?? 'Essencial',
      maxAgents: o.maxAgents,
      maxVolumeBytes: o.maxVolumeBytes,
      retentionDays: o.retentionDays ?? 365,
      validFrom: o.validFrom,
      validUntil: o.validUntil,
      graceDays: o.graceDays ?? 1,
    },
  });
}

export async function createEnrollmentToken(
  db: PrismaService,
  o: { tenantId: string; ttlHours?: number; maxUses?: number; description?: string },
) {
  const token = generateToken('ta_enr');
  const row = await db.enrollmentToken.create({
    data: {
      tenantId: o.tenantId,
      tokenHash: hashToken(token),
      description: o.description,
      expiresAt: new Date(Date.now() + (o.ttlHours ?? 24) * 3600_000),
      maxUses: o.maxUses ?? 1,
    },
  });
  return { id: row.id, token, expiresAt: row.expiresAt, maxUses: row.maxUses };
}

// Desativar libera a vaga da licença e invalida o token do agente.
export async function disableAgent(db: PrismaService, agentId: string) {
  return db.agent.update({ where: { id: agentId }, data: { disabledAt: new Date() } });
}

// Cria um usuário do portal. Sem senha informada, gera uma aleatória e a
// devolve uma única vez. Perfis msp_* não têm tenant; os demais exigem.
export async function createUser(
  db: PrismaService,
  o: { email: string; name: string; role: string; tenantId?: string; password?: string },
) {
  if (!isRole(o.role)) throw new Error(`perfil inválido: ${o.role} (use ${ROLES.join(', ')})`);
  if (isMspRole(o.role) && o.tenantId) throw new Error(`o perfil ${o.role} é da Tech Master e não leva --tenant`);
  if (!isMspRole(o.role) && !o.tenantId) throw new Error(`o perfil ${o.role} exige --tenant`);
  const generated = o.password ? undefined : randomBytes(12).toString('base64url');
  const user = await db.user.create({
    data: {
      email: o.email.trim().toLowerCase(),
      name: o.name,
      role: o.role,
      tenantId: o.tenantId ?? null,
      passwordHash: await hashPassword(o.password ?? generated!),
    },
  });
  return { id: user.id, email: user.email, role: user.role, tenantId: user.tenantId, password: generated };
}

export async function setUserPassword(db: PrismaService, email: string, password?: string) {
  const generated = password ? undefined : randomBytes(12).toString('base64url');
  const user = await db.user.update({
    where: { email: email.trim().toLowerCase() },
    data: { passwordHash: await hashPassword(password ?? generated!) },
  });
  // Encerra as sessões abertas com a senha antiga.
  await db.userSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
  return { email: user.email, password: generated };
}

// Campos zerados ao desligar ou redefinir a verificação em duas etapas.
export const clearMfa = { totpSecret: null, totpEnabledAt: null, totpLastStep: null, totpPendingSecret: null };

// Apaga a verificação em duas etapas do usuário (celular perdido) e encerra
// as sessões e logins pela metade.
export async function resetUserMfa(db: PrismaService, where: { id: string } | { email: string }) {
  const user = await db.user.update({ where: 'email' in where ? { email: where.email.trim().toLowerCase() } : where, data: clearMfa });
  const id = user.id;
  await db.userSession.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
  await db.loginChallenge.deleteMany({ where: { userId: id } });
  return user;
}

// Cria o primeiro administrador da Tech Master se ainda não houver nenhum.
// Usado na subida do contêiner (BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD).
export async function bootstrapAdmin(db: PrismaService, email: string, password: string, name = 'Administrador') {
  const existing = await db.user.count({ where: { role: 'msp_admin' } });
  if (existing > 0) return { created: false as const };
  const u = await createUser(db, { email, name, role: 'msp_admin', password });
  return { created: true as const, email: u.email };
}
