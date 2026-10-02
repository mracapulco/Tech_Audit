import { Injectable } from '@nestjs/common';
import { generateToken, hashToken } from '../common/tokens.js';
import { PrismaService } from '../prisma.service.js';
import { verifyPassword } from './passwords.js';
import { isRole, type PortalUser } from './roles.js';

export const SESSION_TTL_MS = 12 * 3600_000;

export interface LoginResult {
  token: string;
  expiresAt: Date;
  user: Omit<PortalUser, 'sessionId'>;
}

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  // Devolve null para e-mail inexistente, senha errada ou usuário desativado,
  // sem distinguir os casos.
  async login(
    email: string,
    password: string,
    meta: { ip?: string | null; userAgent?: string | null },
  ): Promise<LoginResult | null> {
    const user = await this.prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    const ok = await verifyPassword(user?.passwordHash ?? null, password);
    if (!user || !ok || user.disabledAt || !isRole(user.role)) return null;
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
    return {
      token,
      expiresAt,
      user: { id: user.id, tenantId: user.tenantId, email: user.email, name: user.name, role: user.role },
    };
  }

  async userForToken(token: string, now = new Date()): Promise<PortalUser | null> {
    const session = await this.prisma.userSession.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: true },
    });
    if (!session || session.revokedAt || session.expiresAt <= now) return null;
    const u = session.user;
    if (u.disabledAt || !isRole(u.role)) return null;
    return { id: u.id, tenantId: u.tenantId, email: u.email, name: u.name, role: u.role, sessionId: session.id };
  }

  async logout(sessionId: string): Promise<void> {
    await this.prisma.userSession.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
  }
}
