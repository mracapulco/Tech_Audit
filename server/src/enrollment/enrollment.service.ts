import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { generateToken, hashToken } from '../common/tokens.js';
import { LicenseService } from '../licensing/license.service.js';
import { PrismaService } from '../prisma.service.js';

export interface EnrollRequest {
  enrollmentToken: string;
  hostname: string;
  machineId: string;
  os: string;
  agentVersion: string | null;
}

export interface EnrollResult {
  agent_id: string;
  tenant_id: string;
  // Mostrado uma única vez; o servidor guarda só o hash.
  agent_token: string;
  license: { status: string; valid_until: string | null; grace_until: string | null };
}

@Injectable()
export class EnrollmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly licenses: LicenseService,
  ) {}

  async enroll(req: EnrollRequest, now = new Date()): Promise<EnrollResult> {
    const agentToken = generateToken('ta_agt');
    return this.prisma.$transaction(async (tx) => {
      const token = await tx.enrollmentToken.findUnique({ where: { tokenHash: hashToken(req.enrollmentToken) } });
      if (!token || token.revokedAt || token.expiresAt <= now || token.uses >= token.maxUses) {
        throw new UnauthorizedException('token de registro inválido, vencido ou esgotado');
      }
      // Serializa registros do mesmo tenant para a contagem de vagas não correr.
      await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${token.tenantId}::uuid FOR UPDATE`;

      const license = await this.licenses.stateFor(token.tenantId, now, tx);
      // Na tolerância de 1 dia a ingestão continua, mas novos registros não.
      if (license.status !== 'active') {
        throw new ForbiddenException(license.status === 'none' ? 'tenant sem licença' : 'licença vencida');
      }

      const existing = await tx.agent.findUnique({
        where: { tenantId_machineId: { tenantId: token.tenantId, machineId: req.machineId } },
      });
      // A mesma máquina reinstalada reaproveita a vaga; só agente novo ou
      // reativado ocupa uma vaga a mais.
      if (!existing || existing.disabledAt) {
        const active = await tx.agent.count({ where: { tenantId: token.tenantId, disabledAt: null } });
        if (active >= license.maxAgents) {
          throw new ForbiddenException(`limite de ${license.maxAgents} servidor(es) da licença atingido`);
        }
      }

      const data = {
        hostname: req.hostname,
        os: req.os,
        agentVersion: req.agentVersion,
        tokenHash: hashToken(agentToken),
        disabledAt: null,
      };
      const agent = existing
        ? await tx.agent.update({ where: { id: existing.id }, data })
        : await tx.agent.create({ data: { ...data, tenantId: token.tenantId, machineId: req.machineId } });

      await tx.enrollmentToken.update({ where: { id: token.id }, data: { uses: { increment: 1 } } });
      // A ativação fica na licença que vence por último.
      const lic = license.licenses.reduce((a, b) => (b.validUntil > a.validUntil ? b : a));
      await tx.licenseActivation.create({
        data: { licenseId: lic.id, agentId: agent.id, hostname: req.hostname, machineId: req.machineId },
      });

      return {
        agent_id: agent.id,
        tenant_id: agent.tenantId,
        agent_token: agentToken,
        license: {
          status: license.status,
          valid_until: license.validUntil?.toISOString() ?? null,
          grace_until: license.graceUntil?.toISOString() ?? null,
        },
      };
    });
  }
}
