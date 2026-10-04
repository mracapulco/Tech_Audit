import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { PortalUser } from '../auth/roles.js';
import { isMspRole } from '../auth/roles.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { AuthenticatedAgent } from '../ingest/agent-auth.guard.js';
import { LicenseService } from '../licensing/license.service.js';
import { readAuditAllowed } from '../licensing/plans.js';
import { PrismaService } from '../prisma.service.js';
import type { AgentResult, SizeReport } from './agent-input.js';
import { CONFIG_WRITE_ROLES, dedupedVolume, isWithin, normalizePath, PathError, pathKey, volumeUsage, type VolumeUsage } from './paths.js';

type Tx = Prisma.TransactionClient;

export interface PathOptions {
  recursive: boolean;
  auditRead: boolean;
  exclusions: string[];
}

// Quem pediu a alteração, copiado para o log imutável.
export interface Requester {
  user: PortalUser;
  ip: string | null;
}

type PathRow = Awaited<ReturnType<PrismaService['auditedPath']['findMany']>>[number];

const pathJson = (p: PathRow) => ({
  id: p.id,
  tenant_id: p.tenantId,
  agent_id: p.agentId,
  path: p.path,
  recursive: p.recursive,
  audit_read: p.auditRead,
  exclusions: p.exclusions,
  desired_state: p.desiredState,
  status: p.status,
  last_error: p.lastError,
  applied_at: p.appliedAt,
  size_bytes: p.sizeBytes?.toString() ?? null,
  size_error: p.sizeError,
  size_measured_at: p.sizeMeasuredAt,
  created_at: p.createdAt,
  updated_at: p.updatedAt,
});

const usageJson = (u: VolumeUsage) => ({
  used_bytes: u.usedBytes.toString(),
  max_bytes: u.maxBytes.toString(),
  percent: u.percent,
  level: u.level,
});

const optionsJson = (o: { recursive: boolean; auditRead: boolean; exclusions: string[] }) => ({
  recursive: o.recursive,
  audit_read: o.auditRead,
  exclusions: o.exclusions,
});

// Configuração dos caminhos auditados (docs/ARCHITECTURE.md, seção 4.6): o
// portal grava o pedido e sobe a versão do agente; o agente busca, aplica e
// devolve o resultado. Tudo fica em audit_config_changes.
@Injectable()
export class AuditConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly licenses: LicenseService,
  ) {}

  // --- Acesso -------------------------------------------------------------

  // Tenant que o usuário pode ver: qualquer um para a Tech Master, o próprio para o cliente.
  tenantFor(user: PortalUser, requested?: string): string {
    if (isMspRole(user.role)) {
      if (!requested) throw new BadRequestException('Informe a empresa');
      return requested;
    }
    if (!user.tenantId) throw new ForbiddenException('usuário sem empresa');
    if (requested && requested !== user.tenantId) throw new ForbiddenException('empresa de outro cliente');
    return user.tenantId;
  }

  private assertCanWrite(user: PortalUser) {
    if (!CONFIG_WRITE_ROLES.includes(user.role)) throw new ForbiddenException('seu perfil só pode consultar a configuração');
  }

  private async agentFor(user: PortalUser, agentId: string, db: Tx | PrismaService = this.prisma) {
    const agent = await db.agent.findUnique({ where: { id: agentId } });
    if (!agent || (!isMspRole(user.role) && agent.tenantId !== user.tenantId)) throw new NotFoundException('servidor não encontrado');
    return agent;
  }

  private async pathFor(user: PortalUser, id: string, db: Tx | PrismaService = this.prisma) {
    const p = await db.auditedPath.findUnique({ where: { id }, include: { agent: true } });
    if (!p || (!isMspRole(user.role) && p.tenantId !== user.tenantId)) throw new NotFoundException('caminho não encontrado');
    return p;
  }

  // --- Volume -------------------------------------------------------------

  // Volume auditado medido do tenant (caminhos ativos, sem contar aninhados
  // duas vezes) contra o volume das licenças vigentes.
  async usage(tenantId: string, db: Tx | PrismaService = this.prisma): Promise<VolumeUsage> {
    const [license, paths] = await Promise.all([
      this.licenses.stateFor(tenantId, new Date(), db),
      db.auditedPath.findMany({
        where: { tenantId, desiredState: 'active' },
        select: { agentId: true, pathKey: true, sizeBytes: true },
      }),
    ]);
    const byAgent = new Map<string, { pathKey: string; sizeBytes: bigint | null }[]>();
    for (const p of paths) byAgent.set(p.agentId, [...(byAgent.get(p.agentId) ?? []), p]);
    let used = 0n;
    for (const list of byAgent.values()) used += dedupedVolume(list);
    return volumeUsage(used, license.maxVolumeBytes);
  }

  async readAuditAllowed(tenantId: string, db: Tx | PrismaService = this.prisma): Promise<boolean> {
    return readAuditAllowed((await this.licenses.stateFor(tenantId, new Date(), db)).licenses);
  }

  private async assertReadAudit(tenantId: string, db: Tx) {
    if (!(await this.readAuditAllowed(tenantId, db))) {
      throw new BadRequestException('a auditoria de leitura não faz parte do plano Essencial; peça à Tech Master para mudar o plano');
    }
  }

  // --- Portal: consulta ---------------------------------------------------

  async view(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      include: {
        agents: {
          where: { disabledAt: null },
          orderBy: { hostname: 'asc' },
          include: { auditedPaths: { where: { status: { not: 'removed' } }, orderBy: { pathKey: 'asc' } } },
        },
      },
    });
    if (!tenant) throw new NotFoundException('empresa não encontrada');
    const [usage, readAudit, alerts] = await Promise.all([
      this.usage(tenantId),
      this.readAuditAllowed(tenantId),
      this.prisma.alert.findMany({ where: { tenantId, acknowledgedAt: null }, orderBy: { createdAt: 'desc' }, take: 20 }),
    ]);
    return {
      tenant: { id: tenant.id, name: tenant.name },
      volume: usageJson(usage),
      read_audit_allowed: readAudit,
      alerts: alerts.map((a) => ({
        id: a.id.toString(),
        agent_id: a.agentId,
        kind: a.kind,
        severity: a.severity,
        message: a.message,
        created_at: a.createdAt,
      })),
      agents: tenant.agents.map((a) => ({
        id: a.id,
        hostname: a.hostname,
        os: a.os,
        last_seen_at: a.lastSeenAt,
        config_version: a.configVersion,
        config_applied_version: a.configAppliedVersion,
        config_fetched_at: a.configFetchedAt,
        sizes_measured_at: a.sizesMeasuredAt,
        paths: a.auditedPaths.map(pathJson),
      })),
    };
  }

  async changes(tenantId: string, o: { agentId?: string; before?: bigint; limit: number }) {
    const rows = await this.prisma.auditConfigChange.findMany({
      where: { tenantId, ...(o.agentId ? { agentId: o.agentId } : {}), ...(o.before ? { id: { lt: o.before } } : {}) },
      orderBy: { id: 'desc' },
      take: o.limit + 1,
    });
    const agents = await this.prisma.agent.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.agentId))] } },
      select: { id: true, hostname: true },
    });
    const host = new Map(agents.map((a) => [a.id, a.hostname]));
    const items = rows.slice(0, o.limit).map((r) => ({
      id: r.id.toString(),
      created_at: r.createdAt,
      agent_id: r.agentId,
      hostname: host.get(r.agentId) ?? null,
      audited_path_id: r.auditedPathId,
      path: r.path,
      kind: r.kind,
      source: r.source,
      config_version: r.configVersion,
      user_email: r.userEmail,
      user_role: r.userRole,
      ip: r.ip,
      message: r.message,
      details: r.details,
    }));
    return { items, next_before: rows.length > o.limit ? items[items.length - 1].id : null };
  }

  // --- Portal: alterações -------------------------------------------------

  private async bump(tx: Tx, agentId: string): Promise<number> {
    const a = await tx.agent.update({ where: { id: agentId }, data: { configVersion: { increment: 1 } } });
    return a.configVersion;
  }

  private logRequest(
    tx: Tx,
    r: Requester,
    p: { tenantId: string; agentId: string; id: string; path: string },
    kind: string,
    version: number,
    details: Prisma.InputJsonValue,
  ) {
    return tx.auditConfigChange.create({
      data: {
        tenantId: p.tenantId,
        agentId: p.agentId,
        auditedPathId: p.id,
        path: p.path,
        kind,
        source: 'portal',
        configVersion: version,
        userId: r.user.id,
        userEmail: r.user.email,
        userRole: r.user.role,
        ip: r.ip,
        details,
      },
    });
  }

  async addPath(r: Requester, agentId: string, rawPath: unknown, o: PathOptions, override: boolean) {
    this.assertCanWrite(r.user);
    if (override && r.user.role !== 'msp_admin') throw new ForbiddenException('só o administrador da Tech Master pode liberar acima do volume contratado');
    return this.prisma.$transaction(async (tx) => {
      const agent = await this.agentFor(r.user, agentId, tx);
      if (agent.disabledAt) throw new BadRequestException('servidor desativado');
      let path: string;
      try {
        path = normalizePath(rawPath, agent.os);
      } catch (err) {
        if (err instanceof PathError) throw new BadRequestException(err.message);
        throw err;
      }
      const key = pathKey(path);
      // Serializa alterações do mesmo tenant (contagem de volume e versão).
      await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${agent.tenantId}::uuid FOR UPDATE`;

      const existing = await tx.auditedPath.findUnique({ where: { agentId_pathKey: { agentId, pathKey: key } } });
      if (existing && existing.desiredState === 'active') throw new BadRequestException('esse caminho já é auditado neste servidor');

      // Caminho dentro de outro já auditado não aumenta o volume.
      const active = await tx.auditedPath.findMany({ where: { agentId, desiredState: 'active' }, select: { pathKey: true } });
      const nested = active.some((a) => isWithin(key, a.pathKey));
      const usage = await this.usage(agent.tenantId, tx);
      if (!nested && usage.maxBytes <= 0n && !override) throw new BadRequestException('a empresa não tem licença vigente');
      if (!nested && usage.level === 100 && !override) {
        throw new BadRequestException('o volume auditado já atingiu o contratado na licença; peça à Tech Master para ampliar a licença');
      }

      if (o.auditRead) await this.assertReadAudit(agent.tenantId, tx);

      const data = {
        path,
        recursive: o.recursive,
        auditRead: o.auditRead,
        exclusions: o.exclusions,
        desiredState: 'active',
        status: 'pending',
        lastError: null,
        appliedAt: null,
        sizeBytes: null,
        sizeError: null,
        sizeMeasuredAt: null,
        createdById: r.user.id,
      };
      const row = existing
        ? await tx.auditedPath.update({ where: { id: existing.id }, data })
        : await tx.auditedPath.create({ data: { ...data, tenantId: agent.tenantId, agentId, pathKey: key } });
      const version = await this.bump(tx, agentId);
      await this.logRequest(tx, r, row, 'add', version, {
        after: optionsJson(o),
        hostname: agent.hostname,
        ...(override ? { volume_override: true, volume: usageJson(usage) } : {}),
      });
      return pathJson(row);
    });
  }

  // Opções não informadas mantêm o valor atual.
  async updatePath(r: Requester, id: string, merge: (current: PathOptions) => PathOptions) {
    this.assertCanWrite(r.user);
    return this.prisma.$transaction(async (tx) => {
      const p = await this.pathFor(r.user, id, tx);
      if (p.desiredState !== 'active') throw new BadRequestException('caminho removido');
      const o = merge(p);
      // Leitura que já estava ligada continua (ex.: plano rebaixado); só não pode ligar.
      if (o.auditRead && !p.auditRead) await this.assertReadAudit(p.tenantId, tx);
      const row = await tx.auditedPath.update({
        where: { id },
        data: { recursive: o.recursive, auditRead: o.auditRead, exclusions: o.exclusions, status: 'pending', lastError: null },
      });
      const version = await this.bump(tx, p.agentId);
      await this.logRequest(tx, r, p, 'update', version, { before: optionsJson(p), after: optionsJson(o), hostname: p.agent.hostname });
      return pathJson(row);
    });
  }

  async removePath(r: Requester, id: string) {
    this.assertCanWrite(r.user);
    return this.prisma.$transaction(async (tx) => {
      const p = await this.pathFor(r.user, id, tx);
      if (p.desiredState !== 'active') throw new BadRequestException('caminho já removido');
      // Mesmo nunca confirmado, o agente pode já ter aplicado: ele confirma a remoção.
      const row = await tx.auditedPath.update({ where: { id }, data: { desiredState: 'removed', status: 'removing', lastError: null } });
      const version = await this.bump(tx, p.agentId);
      await this.logRequest(tx, r, p, 'remove', version, { before: optionsJson(p), hostname: p.agent.hostname });
      return pathJson(row);
    });
  }

  async reapply(r: Requester, id: string) {
    this.assertCanWrite(r.user);
    return this.prisma.$transaction(async (tx) => {
      const p = await this.pathFor(r.user, id, tx);
      if (p.desiredState !== 'active') throw new BadRequestException('caminho removido');
      const row = await tx.auditedPath.update({ where: { id }, data: { status: 'pending', lastError: null } });
      const version = await this.bump(tx, p.agentId);
      await this.logRequest(tx, r, p, 'reapply', version, { after: optionsJson(p), hostname: p.agent.hostname });
      return pathJson(row);
    });
  }

  async ackAlert(user: PortalUser, id: bigint) {
    const a = await this.prisma.alert.findUnique({ where: { id } });
    if (!a || (!isMspRole(user.role) && a.tenantId !== user.tenantId)) throw new NotFoundException('alerta não encontrado');
    if (!a.acknowledgedAt) {
      await this.prisma.alert.update({ where: { id }, data: { acknowledgedAt: new Date(), acknowledgedBy: user.id } });
    }
    return { id: id.toString(), tenant_id: a.tenantId };
  }

  // --- Agente -------------------------------------------------------------

  // GET /v1/config: caminhos ativos e os removidos que o agente ainda precisa desfazer.
  async agentConfig(agent: AuthenticatedAgent) {
    const a = await this.prisma.agent.update({
      where: { id: agent.id },
      data: { configFetchedAt: new Date(), lastSeenAt: new Date() },
      include: { auditedPaths: { where: { status: { not: 'removed' } }, orderBy: { pathKey: 'asc' } } },
    });
    return {
      agent_id: a.id,
      version: a.configVersion,
      paths: a.auditedPaths.map((p) => ({
        id: p.id,
        path: p.path,
        state: p.desiredState,
        // pending/removing: o portal pediu algo que o agente ainda não confirmou.
        status: p.status,
        recursive: p.recursive,
        audit_read: p.auditRead,
        exclusions: p.exclusions,
      })),
    };
  }

  // POST /v1/config/result: resultado de cada aplicação, remoção ou verificação.
  async agentResults(agent: AuthenticatedAgent, version: number, results: AgentResult[]) {
    return this.prisma.$transaction(async (tx) => {
      const a = await tx.agent.findUniqueOrThrow({ where: { id: agent.id } });
      let recorded = 0;
      let ignored = 0;
      for (const r of results) {
        const p = await tx.auditedPath.findUnique({ where: { id: r.pathId } });
        if (!p || p.agentId !== agent.id) {
          ignored++;
          continue;
        }
        // Verificação periódica sem mudança: nada a registrar.
        if (r.operation === 'verify' && (r.status === p.status || (r.status === 'applied' && p.status === 'pending'))) continue;
        const data: Prisma.AuditedPathUpdateInput = {};
        const now = new Date();
        if (r.status === 'error') Object.assign(data, { status: 'error', lastError: r.message ?? 'erro sem mensagem' });
        else if (r.status === 'divergent') Object.assign(data, { status: 'divergent', lastError: r.message });
        else if (r.status === 'applied' && p.desiredState === 'active') Object.assign(data, { status: 'applied', lastError: null, appliedAt: now });
        else if (r.status === 'removed' && p.desiredState === 'removed') Object.assign(data, { status: 'removed', lastError: null });
        // Resultado atrasado (ex.: aplicado depois de já removido no portal):
        // só entra no log; a próxima versão corrige.
        if (Object.keys(data).length) await tx.auditedPath.update({ where: { id: p.id }, data });

        await tx.auditConfigChange.create({
          data: {
            tenantId: a.tenantId,
            agentId: a.id,
            auditedPathId: p.id,
            path: p.path,
            kind: r.status,
            source: 'agent',
            configVersion: version,
            message: r.message,
            details: { operation: r.operation, before: r.before ?? null, after: r.after ?? null } as Prisma.InputJsonValue,
          },
        });
        await tx.alert.create({ data: alertFor(a, p.path, r) });
        recorded++;
      }
      await tx.agent.update({ where: { id: a.id }, data: { configAppliedVersion: version, lastSeenAt: new Date() } });
      return { recorded, ignored };
    });
  }

  // POST /v1/config/sizes: tamanho de cada caminho; alerta ao cruzar 80% e 100%.
  async agentSizes(agent: AuthenticatedAgent, sizes: SizeReport[]) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${agent.tenantId}::uuid FOR UPDATE`;
      const now = new Date();
      let updated = 0;
      for (const s of sizes) {
        const r = await tx.auditedPath.updateMany({
          where: { id: s.pathId, agentId: agent.id },
          data:
            s.sizeBytes !== null
              ? { sizeBytes: s.sizeBytes, sizeError: null, sizeMeasuredAt: now }
              : { sizeError: s.error, sizeMeasuredAt: now },
        });
        updated += r.count;
      }
      await tx.agent.update({ where: { id: agent.id }, data: { sizesMeasuredAt: now, lastSeenAt: now } });

      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: agent.tenantId } });
      const usage = await this.usage(agent.tenantId, tx);
      const pct = usage.percent === null ? '' : `${String(usage.percent).replace('.', ',')}%`;
      if (usage.level > tenant.volumeAlertLevel) {
        await tx.alert.create({
          data: {
            tenantId: agent.tenantId,
            agentId: agent.id,
            kind: usage.level === 100 ? 'volume_100' : 'volume_80',
            severity: usage.level === 100 ? 'critical' : 'warning',
            message:
              usage.level === 100
                ? `O volume auditado atingiu ${pct || '100%'} do contratado. A auditoria continua; novos caminhos ficam bloqueados até ampliar a licença.`
                : `O volume auditado chegou a ${pct} do contratado.`,
            details: usageJson(usage),
          },
        });
      }
      if (usage.level !== tenant.volumeAlertLevel) {
        await tx.tenant.update({ where: { id: tenant.id }, data: { volumeAlertLevel: usage.level } });
      }
      return { updated, volume: usageJson(usage) };
    });
  }
}

function alertFor(a: { id: string; tenantId: string; hostname: string }, path: string, r: AgentResult): Prisma.AlertUncheckedCreateInput {
  const base = { tenantId: a.tenantId, agentId: a.id, details: { path, operation: r.operation, message: r.message } };
  switch (r.status) {
    case 'applied':
      return { ...base, kind: 'audit_config_changed', severity: 'info', message: `Auditoria aplicada em ${a.hostname}: ${path}` };
    case 'removed':
      return { ...base, kind: 'audit_config_changed', severity: 'info', message: `Auditoria removida em ${a.hostname}: ${path}` };
    case 'divergent':
      return {
        ...base,
        kind: 'audit_config_divergent',
        severity: 'warning',
        message: `Auditoria de ${path} em ${a.hostname} diferente do configurado${r.message ? `: ${r.message}` : ''}`,
      };
    default:
      return {
        ...base,
        kind: 'audit_config_error',
        severity: 'warning',
        message: `Erro ao configurar a auditoria de ${path} em ${a.hostname}${r.message ? `: ${r.message}` : ''}`,
      };
  }
}
