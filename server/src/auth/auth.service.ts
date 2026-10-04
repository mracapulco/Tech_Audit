import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { clearMfa } from '../admin/admin.js';
import { generateToken, hashToken } from '../common/tokens.js';
import type { User } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma.service.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { isRole, MSP_ROLES, type PortalUser } from './roles.js';
import { generateSecret, otpauthUrl, verifyCode } from './totp.js';

export const SESSION_TTL_MS = 12 * 3600_000;
// Tempo para digitar o código depois da senha certa, e tentativas por login.
export const CHALLENGE_TTL_MS = 5 * 60_000;
export const CHALLENGE_MAX_ATTEMPTS = 5;
// Teto de códigos errados por usuário, somando todos os logins: sem ele, quem
// sabe a senha poderia abrir desafios novos e chutar códigos sem parar.
export const MFA_MAX_FAILURES = 10;
export const MFA_FAILURE_WINDOW_MS = 15 * 60_000;

// Perfis que precisam da verificação em duas etapas. Padrão: a equipe Tech
// Master, que enxerga todas as empresas. MFA_REQUIRED_ROLES=none desliga (só
// para testes); os demais perfis podem ativar em "Minha conta".
export function mfaRequired(role: string): boolean {
  const v = process.env.MFA_REQUIRED_ROLES ?? MSP_ROLES.join(',');
  return v
    .split(',')
    .map((s) => s.trim())
    .includes(role);
}

type Meta = { ip?: string | null; userAgent?: string | null };
type SessionUser = Omit<PortalUser, 'sessionId'>;

export interface LoginResult {
  token: string;
  expiresAt: Date;
  user: SessionUser;
}

// Senha certa: entra direto, pede o código (verify) ou pede o cadastro do
// autenticador (setup), com o segredo novo para o QR code.
export type LoginOutcome =
  | ({ kind: 'session' } & LoginResult)
  | { kind: 'verify'; challenge: string; expiresAt: Date }
  | { kind: 'setup'; challenge: string; expiresAt: Date; secret: string; otpauthUrl: string };

export type MfaOutcome = LoginResult | 'invalid_code' | 'expired' | 'locked';

const toSessionUser = (u: User): SessionUser => ({ id: u.id, tenantId: u.tenantId, email: u.email, name: u.name, role: u.role as SessionUser['role'] });

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  // Devolve null para e-mail inexistente, senha errada ou usuário desativado,
  // sem distinguir os casos.
  async login(email: string, password: string, meta: Meta): Promise<LoginOutcome | null> {
    const user = await this.prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    const ok = await verifyPassword(user?.passwordHash ?? null, password);
    if (!user || !ok || user.disabledAt || !isRole(user.role)) return null;

    if (user.totpEnabledAt && user.totpSecret) {
      const { challenge, expiresAt } = await this.challenge(user.id, 'verify');
      return { kind: 'verify', challenge, expiresAt };
    }
    if (mfaRequired(user.role)) {
      const secret = generateSecret();
      const { challenge, expiresAt } = await this.challenge(user.id, 'setup', secret);
      return { kind: 'setup', challenge, expiresAt, secret, otpauthUrl: otpauthUrl(secret, user.email) };
    }
    return { kind: 'session', ...(await this.createSession(user, meta)) };
  }

  // Segunda etapa do login: confere o código do autenticador. No cadastro,
  // o primeiro código certo ativa o segredo novo.
  async completeMfa(challengeToken: string, code: string, meta: Meta, now = new Date()): Promise<{ userId: string | null; outcome: MfaOutcome }> {
    const c = await this.prisma.loginChallenge.findUnique({ where: { tokenHash: hashToken(challengeToken) }, include: { user: true } });
    if (!c || c.usedAt || c.expiresAt <= now || c.attempts >= CHALLENGE_MAX_ATTEMPTS || c.user.disabledAt || !isRole(c.user.role)) {
      return { userId: c?.userId ?? null, outcome: 'expired' };
    }
    const user = c.user;
    const recent = await this.prisma.loginChallenge.aggregate({
      _sum: { attempts: true },
      where: { userId: user.id, createdAt: { gte: new Date(now.getTime() - MFA_FAILURE_WINDOW_MS) } },
    });
    if ((recent._sum.attempts ?? 0) >= MFA_MAX_FAILURES) return { userId: user.id, outcome: 'locked' };
    const secret = c.kind === 'setup' ? c.secret : user.totpSecret;
    const lastStep = c.kind === 'setup' ? null : user.totpLastStep === null ? null : Number(user.totpLastStep);
    const step = secret ? verifyCode(secret, code, lastStep, now.getTime()) : null;
    if (step === null) {
      await this.prisma.loginChallenge.update({ where: { id: c.id }, data: { attempts: { increment: 1 } } });
      return { userId: user.id, outcome: 'invalid_code' };
    }
    // Marca como usado antes de abrir a sessão; uma segunda chamada com o
    // mesmo desafio não passa daqui.
    const used = await this.prisma.loginChallenge.updateMany({ where: { id: c.id, usedAt: null }, data: { usedAt: now } });
    if (used.count !== 1) return { userId: user.id, outcome: 'expired' };
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data:
        c.kind === 'setup'
          ? { totpSecret: secret, totpEnabledAt: now, totpLastStep: BigInt(step), totpPendingSecret: null }
          : { totpLastStep: BigInt(step) },
    });
    return { userId: user.id, outcome: await this.createSession(updated, meta) };
  }

  async userForToken(token: string, now = new Date()): Promise<PortalUser | null> {
    const session = await this.prisma.userSession.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: true },
    });
    if (!session || session.revokedAt || session.expiresAt <= now) return null;
    const u = session.user;
    if (u.disabledAt || !isRole(u.role)) return null;
    return { ...toSessionUser(u), sessionId: session.id };
  }

  async logout(sessionId: string): Promise<void> {
    await this.prisma.userSession.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
  }

  // --- Minha conta --------------------------------------------------------

  async rename(userId: string, name: string) {
    return this.prisma.user.update({ where: { id: userId }, data: { name } });
  }

  // Troca da própria senha: exige a atual e encerra as outras sessões abertas,
  // mantendo a de quem trocou.
  async changePassword(userId: string, sessionId: string, current: string, next: string): Promise<boolean> {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await verifyPassword(u.passwordHash, current))) return false;
    let passwordHash: string;
    try {
      passwordHash = await hashPassword(next);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { passwordHash } }),
      this.prisma.userSession.updateMany({ where: { userId, revokedAt: null, id: { not: sessionId } }, data: { revokedAt: new Date() } }),
    ]);
    return true;
  }

  async mfaStatus(userId: string) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return { enabled: !!u.totpEnabledAt, enabled_at: u.totpEnabledAt, required: mfaRequired(u.role) };
  }

  // Gera um segredo novo; só passa a valer depois do primeiro código certo.
  async startMfaSetup(userId: string) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (u.totpEnabledAt) throw new BadRequestException('a verificação em duas etapas já está ativa');
    const secret = generateSecret();
    await this.prisma.user.update({ where: { id: userId }, data: { totpPendingSecret: secret } });
    return { secret, otpauth_url: otpauthUrl(secret, u.email) };
  }

  async confirmMfaSetup(userId: string, code: string): Promise<boolean> {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (u.totpEnabledAt) throw new BadRequestException('a verificação em duas etapas já está ativa');
    if (!u.totpPendingSecret) throw new BadRequestException('gere o QR code antes de confirmar');
    const step = verifyCode(u.totpPendingSecret, code, null);
    if (step === null) return false;
    await this.prisma.user.update({
      where: { id: userId },
      data: { totpSecret: u.totpPendingSecret, totpEnabledAt: new Date(), totpLastStep: BigInt(step), totpPendingSecret: null },
    });
    return true;
  }

  async disableMfa(userId: string, password: string): Promise<boolean> {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (mfaRequired(u.role)) throw new ForbiddenException('a verificação em duas etapas é obrigatória para o seu perfil');
    if (!(await verifyPassword(u.passwordHash, password))) return false;
    await this.prisma.user.update({ where: { id: userId }, data: clearMfa });
    return true;
  }

  // --- interno ------------------------------------------------------------

  private async challenge(userId: string, kind: 'verify' | 'setup', secret?: string) {
    const challenge = generateToken('ta_mfa');
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
    // Limpa os antigos; os do último dia contam para o teto de códigos errados.
    await this.prisma.loginChallenge.deleteMany({ where: { userId, createdAt: { lt: new Date(Date.now() - 24 * 3600_000) } } });
    await this.prisma.loginChallenge.create({ data: { userId, kind, secret, tokenHash: hashToken(challenge), expiresAt } });
    return { challenge, expiresAt };
  }

  private async createSession(user: User, meta: Meta): Promise<LoginResult> {
    const token = generateToken('ta_ses');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await this.prisma.$transaction([
      this.prisma.userSession.create({
        data: {
          userId: user.id,
          tokenHash: hashToken(token),
          expiresAt,
          ip: meta.ip ?? null,
          userAgent: meta.userAgent?.slice(0, 255) ?? null,
        },
      }),
      this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }),
    ]);
    return { token, expiresAt, user: toSessionUser(user) };
  }
}
