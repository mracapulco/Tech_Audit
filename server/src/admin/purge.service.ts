import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import type { PortalUser } from '../auth/roles.js';
import { PgService } from '../db/pg.service.js';
import { evaluateLicenses } from '../licensing/license.js';
import { AuditLogService } from '../portal/audit-log.service.js';
import { PrismaService } from '../prisma.service.js';
import { dayWindows, effectiveRetention, resolveRange, type PurgeRange, type PurgeRequest } from './purge.js';

type LicenseRow = Awaited<ReturnType<PrismaService['license']['findMany']>>[number];
type PurgeRow = Awaited<ReturnType<PrismaService['eventPurge']['findMany']>>[number];

export interface PurgePreview {
  tenant: { id: string; name: string };
  agent: { id: string; hostname: string } | null;
  mode: PurgeRequest['mode'];
  retention_days: number | null;
  from: Date | null;
  to: Date;
  count: string;
  first: Date | null;
  last: Date | null;
}

// Retenção das licenças que contam agora (vigentes ou em tolerância).
function currentRetention(licenses: LicenseRow[], now: Date): number | null {
  const counted = new Set(evaluateLicenses(licenses, now).licenses.map((l) => l.id));
  return effectiveRetention(licenses.filter((l) => counted.has(l.id)));
}

export const purgeJson = (p: PurgeRow & { tenant?: { name: string } }) => ({
  id: p.id,
  tenant_id: p.tenantId,
  tenant_name: p.tenant?.name ?? null,
  agent_id: p.agentId,
  hostname: p.hostname,
  mode: p.mode,
  retention_days: p.retentionDays,
  from: p.fromTime,
  to: p.toTime,
  user_name: p.userName,
  status: p.status,
  expected_count: p.expectedCount.toString(),
  deleted_count: p.deletedCount.toString(),
  error: p.error,
  created_at: p.createdAt,
  finished_at: p.finishedAt,
});

// Limpeza de eventos (events.file_events) pedida pela Tech Master no portal.
@Injectable()
export class PurgeService implements OnModuleInit {
  private readonly logger = new Logger(PurgeService.name);
  // Exclusões em andamento neste processo, para os testes esperarem o fim.
  readonly running = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly pg: PgService,
    private readonly audit: AuditLogService,
  ) {}

  // Uma limpeza que estava rodando quando o servidor parou não continua sozinha:
  // fica marcada como interrompida e o que faltou pode ser pedido de novo.
  async onModuleInit() {
    await this.prisma.eventPurge.updateMany({
      where: { status: 'running' },
      data: { status: 'interrupted', finishedAt: new Date(), error: 'o servidor reiniciou durante a limpeza' },
    });
  }

  private where(tenantId: string, agentId: string | null, range: PurgeRange, values: unknown[]): string {
    values.push(tenantId, range.to);
    const parts = [`tenant_id = $${values.length - 1}`, `time < $${values.length}`];
    if (range.from) {
      values.push(range.from);
      parts.push(`time >= $${values.length}`);
    }
    if (agentId) {
      values.push(agentId);
      parts.push(`agent_id = $${values.length}`);
    }
    return parts.join(' AND ');
  }

  async preview(req: PurgeRequest, now = new Date()): Promise<PurgePreview> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: req.tenantId }, include: { licenses: true } });
    if (!tenant) throw new NotFoundException('empresa não encontrada');
    let agent: { id: string; hostname: string } | null = null;
    if (req.agentId) {
      const a = await this.prisma.agent.findUnique({ where: { id: req.agentId } });
      if (!a || a.tenantId !== tenant.id) throw new BadRequestException('o servidor escolhido não é desta empresa');
      agent = { id: a.id, hostname: a.hostname };
    }
    const retention = currentRetention(tenant.licenses, now);
    const range = resolveRange(req, retention, now);
    const values: unknown[] = [];
    const where = this.where(tenant.id, agent?.id ?? null, range, values);
    const { rows } = await this.pg.query<{ count: string; first: Date | null; last: Date | null }>(
      `SELECT count(*)::text AS count, min(time) AS first, max(time) AS last FROM events.file_events WHERE ${where}`,
      values,
    );
    return {
      tenant: { id: tenant.id, name: tenant.name },
      agent,
      mode: req.mode,
      retention_days: req.mode === 'retention' ? retention : null,
      from: range.from,
      to: range.to,
      count: rows[0].count,
      first: rows[0].first,
      last: rows[0].last,
    };
  }

  // Registra o pedido e apaga em segundo plano; a tela acompanha pelo histórico.
  async start(req: PurgeRequest, user: PortalUser, ip: string | undefined) {
    const p = await this.preview(req);
    if (p.count === '0') throw new BadRequestException('nenhum evento encontrado nesse período');
    const busy = await this.prisma.eventPurge.findFirst({ where: { tenantId: p.tenant.id, status: 'running' } });
    if (busy) throw new ConflictException('já existe uma limpeza em andamento para esta empresa; aguarde terminar');
    const row = await this.prisma.eventPurge.create({
      data: {
        tenantId: p.tenant.id,
        agentId: p.agent?.id ?? null,
        hostname: p.agent?.hostname ?? null,
        fromTime: p.from,
        toTime: p.to,
        mode: p.mode,
        retentionDays: p.retention_days,
        userId: user.id,
        userName: user.name,
        status: 'running',
        expectedCount: BigInt(p.count),
      },
      include: { tenant: true },
    });
    await this.audit.record({
      userId: user.id,
      tenantId: p.tenant.id,
      action: 'admin.events.purge',
      ip,
      details: {
        purge: row.id,
        agent: p.agent?.id ?? null,
        hostname: p.agent?.hostname ?? null,
        mode: p.mode,
        from: p.from?.toISOString() ?? null,
        to: p.to.toISOString(),
        expected: p.count,
      },
    });
    const job = this.execute(row.id, p).finally(() => this.running.delete(row.id));
    this.running.set(row.id, job);
    return purgeJson(row);
  }

  private async execute(id: string, p: PurgePreview): Promise<void> {
    let deleted = 0n;
    try {
      if (p.first && p.last) {
        for (const w of dayWindows({ from: p.from, to: p.to }, p.first, p.last)) {
          const values: unknown[] = [];
          const where = this.where(p.tenant.id, p.agent?.id ?? null, w, values);
          const r = await this.pg.query(`DELETE FROM events.file_events WHERE ${where}`, values);
          if (r.rowCount) {
            deleted += BigInt(r.rowCount);
            await this.prisma.eventPurge.update({ where: { id }, data: { deletedCount: deleted } });
          }
        }
      }
      await this.prisma.eventPurge.update({ where: { id }, data: { status: 'done', deletedCount: deleted, finishedAt: new Date() } });
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`limpeza ${id}: ${message}`);
      await this.prisma.eventPurge
        .update({ where: { id }, data: { status: 'failed', deletedCount: deleted, error: message.slice(0, 500), finishedAt: new Date() } })
        .catch(() => undefined);
    }
  }

  async list(tenantId: string | null) {
    const rows = await this.prisma.eventPurge.findMany({
      where: tenantId ? { tenantId } : {},
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { tenant: true },
    });
    return rows.map(purgeJson);
  }

  // Empresas e servidores para os campos da tela, com a retenção vigente.
  async options(now = new Date()) {
    const tenants = await this.prisma.tenant.findMany({
      orderBy: { name: 'asc' },
      include: { licenses: true, agents: { orderBy: { hostname: 'asc' } } },
    });
    return tenants.map((t) => ({
      id: t.id,
      name: t.name,
      retention_days: currentRetention(t.licenses, now),
      agents: t.agents.map((a) => ({ id: a.id, hostname: a.hostname, disabled: a.disabledAt !== null })),
    }));
  }
}
