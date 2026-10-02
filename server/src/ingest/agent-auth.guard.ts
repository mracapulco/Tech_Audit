import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { bearerToken, hashToken } from '../common/tokens.js';
import { acceptsIngestion } from '../licensing/license.js';
import { LicenseService } from '../licensing/license.service.js';
import { PrismaService } from '../prisma.service.js';

export interface AuthenticatedAgent {
  id: string;
  tenantId: string;
}

export type AgentRequest = Request & { agent: AuthenticatedAgent };

// Identifica o agente pelo token Bearer recebido no registro. O tenant vem do
// agente, nunca do corpo da requisição.
async function authenticateAgent(prisma: PrismaService, req: AgentRequest): Promise<AuthenticatedAgent> {
  const token = bearerToken(req.headers.authorization);
  if (!token) throw new UnauthorizedException('token ausente');
  const agent = await prisma.agent.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { id: true, tenantId: true, disabledAt: true },
  });
  if (!agent) throw new UnauthorizedException('token inválido');
  if (agent.disabledAt) throw new ForbiddenException('agente desativado');
  return { id: agent.id, tenantId: agent.tenantId };
}

// Só autentica, sem olhar a licença: o heartbeat continua chegando com a
// licença vencida, para o portal mostrar que o agente está vivo.
@Injectable()
export class AgentIdentityGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AgentRequest>();
    req.agent = await authenticateAgent(this.prisma, req);
    return true;
  }
}

// Autentica e recusa a ingestão de licença vencida além da tolerância; o
// agente segura o lote e tenta de novo.
@Injectable()
export class AgentAuthGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly licenses: LicenseService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AgentRequest>();
    const agent = await authenticateAgent(this.prisma, req);
    const license = await this.licenses.stateFor(agent.tenantId);
    if (!acceptsIngestion(license)) {
      throw new ForbiddenException(license.status === 'none' ? 'tenant sem licença' : 'licença vencida');
    }
    req.agent = { id: agent.id, tenantId: agent.tenantId };
    return true;
  }
}
