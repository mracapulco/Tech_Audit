import type pg from 'pg';
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PgService } from '../db/pg.service.js';
import type { AuthenticatedAgent } from '../ingest/agent-auth.guard.js';
import { LicenseService } from '../licensing/license.service.js';
import { permissionsInventoryAllowed } from '../licensing/plans.js';
import { PrismaService } from '../prisma.service.js';
import { formatDateTime, type ReportColumn, type ReportTable } from '../reports/table.js';
import { buildAppendix, type AppendixGroup, type GroupRecord } from './group-appendix.js';
import type { GroupMemberRow, PermissionUpload } from './permissions-input.js';

// Inventário de permissões (plano Enterprise): quem tem acesso a cada pasta
// auditada. O agente coleta uma vez por dia (ou quando pedem "Atualizar
// agora") e envia em partes; o portal mostra a última coleta de cada caminho
// e compara com a anterior.

export const INTERVAL_HOURS = 24;
// Primeira versão do agente com o inventário.
export const MIN_AGENT_VERSION = '0.5.0';
export const NOT_IN_PLAN = 'O inventário de permissões faz parte do plano Enterprise; peça à Tech Master para mudar o plano.';

export interface PermissionFilters {
  tenantId: string;
  agentId?: string;
  pathId?: string;
  // Texto no nome do usuário/grupo, SID ou caminho da pasta.
  q?: string;
  // Só entradas definidas na própria pasta (não herdadas).
  explicitOnly?: boolean;
  // Só negações.
  denyOnly?: boolean;
}

export interface PermissionRowJson {
  agent_id: string;
  hostname: string;
  audited_path_id: string;
  audited_path: string;
  folder_path: string;
  depth: number;
  source: string;
  share: string | null;
  owner: string | null;
  protected: boolean;
  reason: string;
  folder_error: string | null;
  principal: string | null;
  sid: string | null;
  kind: string | null;
  access: string | null;
  rights: string | null;
  raw: string | null;
  inherited: boolean;
  applies_to: string | null;
  is_new: boolean;
}

// "0.5.0-dev" >= "0.5.0"; versões ilegíveis contam como antigas.
export function versionAtLeast(v: string | null, min: string): boolean {
  const parse = (s: string) => s.split(/[^0-9]+/).filter(Boolean).slice(0, 3).map(Number);
  if (!v) return false;
  const a = parse(v);
  const b = parse(min);
  if (a.length === 0) return false;
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

export const SOURCE_LABELS: Record<string, string> = { ntfs: 'Pasta (NTFS)', posix: 'Pasta (Linux)', share: 'Compartilhamento' };
export const KIND_LABELS: Record<string, string> = { user: 'Usuário', group: 'Grupo', other: 'Outros', unknown: 'Desconhecido' };
export const ACCESS_LABELS: Record<string, string> = { allow: 'Permitir', deny: 'Negar' };

// Chave de uma permissão para comparar coletas (tudo menos o id). Igualdade
// simples, para o Postgres comparar com hash mesmo com milhares de linhas.
const KEY = (t: string) =>
  `md5(concat_ws(chr(31), ${t}.folder_path, ${t}.source, ${['share', 'principal', 'sid', 'access', 'rights', 'raw', 'applies_to']
    .map((c) => `coalesce(${t}.${c}, '')`)
    .join(', ')}, ${t}.inherited::text))`;

@Injectable()
export class PermissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pg: PgService,
    private readonly licenses: LicenseService,
  ) {}

  async allowed(tenantId: string): Promise<boolean> {
    return permissionsInventoryAllowed((await this.licenses.stateFor(tenantId)).licenses);
  }

  // --- Agente -------------------------------------------------------------

  // Parte "permissions" de GET /v1/config.
  async agentSettings(agent: { tenantId: string; permissionsRequestedAt: Date | null }) {
    return {
      enabled: await this.allowed(agent.tenantId),
      interval_hours: INTERVAL_HOURS,
      requested_at: agent.permissionsRequestedAt?.toISOString() ?? '',
    };
  }

  // POST /v1/permissions: uma parte da coleta de um caminho.
  async receive(agent: AuthenticatedAgent, u: PermissionUpload) {
    if (!(await this.allowed(agent.tenantId))) throw new ForbiddenException(NOT_IN_PLAN);
    const c = await this.pg.connect();
    try {
      await c.query('BEGIN');
      const path = (
        await c.query<{ id: string; agent_id: string; path: string }>('SELECT id, agent_id, path FROM audited_paths WHERE id = $1', [u.pathId])
      ).rows[0];
      if (!path || path.agent_id !== agent.id) throw new NotFoundException('caminho não encontrado');

      let scan = (
        await c.query<{ agent_id: string; status: string; next_part: number }>(
          'SELECT agent_id, status, next_part FROM permission_scans WHERE id = $1 FOR UPDATE',
          [u.scanId],
        )
      ).rows[0];
      if (!scan) {
        if (u.part !== 0) throw new ConflictException('coleta desconhecida; recomece a coleta');
        await c.query(
          `INSERT INTO permission_scans (id, tenant_id, agent_id, audited_path_id, path, status, started_at)
           VALUES ($1, $2, $3, $4, $5, 'running', $6)`,
          [u.scanId, agent.tenantId, agent.id, u.pathId, path.path, u.startedAt],
        );
        scan = { agent_id: agent.id, status: 'running', next_part: 0 };
      }
      if (scan.agent_id !== agent.id) throw new ConflictException('coleta de outro servidor');
      // Reenvio de uma parte já gravada (a resposta se perdeu): nada a fazer.
      if (scan.status !== 'running' || u.part < scan.next_part) {
        await c.query('COMMIT');
        return { scan_id: u.scanId, duplicate: true };
      }
      if (u.part > scan.next_part) throw new ConflictException(`parte ${u.part} fora de ordem (esperada ${scan.next_part}); recomece a coleta`);

      if (u.rows.length) await insertRows(c, u.scanId, u.rows);
      await c.query('UPDATE permission_scans SET next_part = next_part + 1, folders_recorded = folders_recorded + $2 WHERE id = $1', [
        u.scanId,
        u.folders,
      ]);
      if (u.final) {
        if (u.groupRows.length) await insertGroupRows(c, u.scanId, u.groupRows);
        await c.query(
          `UPDATE permission_scans SET status = $2, finished_at = $3, folders_scanned = $4, truncated = $5, error = $6 WHERE id = $1`,
          [u.scanId, u.error ? 'error' : 'complete', u.finishedAt, u.scanned, u.truncated, u.error],
        );
        await c.query('UPDATE agents SET permissions_scanned_at = now(), last_seen_at = now() WHERE id = $1', [agent.id]);
        // Guarda as linhas só das duas últimas coletas completas do caminho.
        for (const table of ['permission_entries', 'permission_group_members']) {
          await c.query(
            `DELETE FROM ${table} WHERE scan_id IN (
               SELECT id FROM permission_scans
               WHERE audited_path_id = $1 AND status <> 'running' AND id NOT IN (
                 SELECT id FROM permission_scans WHERE audited_path_id = $1 AND status = 'complete' ORDER BY received_at DESC LIMIT 2))`,
            [u.pathId],
          );
        }
        // Coletas que nunca terminaram (agente reiniciado no meio).
        await c.query(`DELETE FROM permission_scans WHERE agent_id = $1 AND status = 'running' AND received_at < now() - interval '2 days'`, [agent.id]);
      }
      await c.query('COMMIT');
      return { scan_id: u.scanId, part: u.part, final: u.final };
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }

  // --- Portal -------------------------------------------------------------

  // "Atualizar agora": o agente coleta na próxima consulta (até 2 min).
  async refresh(tenantId: string, agentId?: string) {
    if (!(await this.allowed(tenantId))) throw new ForbiddenException(NOT_IN_PLAN);
    if (agentId) {
      const a = await this.prisma.agent.findUnique({ where: { id: agentId } });
      if (!a || a.tenantId !== tenantId) throw new NotFoundException('servidor não encontrado');
    }
    const r = await this.prisma.agent.updateMany({
      where: { tenantId, disabledAt: null, ...(agentId ? { id: agentId } : {}) },
      data: { permissionsRequestedAt: new Date() },
    });
    return { requested: r.count };
  }

  // Servidores, caminhos e a situação da última coleta de cada um.
  async status(tenantId: string) {
    const agents = await this.prisma.agent.findMany({
      where: { tenantId, disabledAt: null },
      orderBy: { hostname: 'asc' },
      include: { auditedPaths: { where: { desiredState: 'active' }, orderBy: { pathKey: 'asc' } } },
    });
    const pathIds = agents.flatMap((a) => a.auditedPaths.map((p) => p.id));
    const scans = pathIds.length
      ? (
          await this.pg.query<{
            id: string;
            audited_path_id: string;
            status: string;
            started_at: Date;
            finished_at: Date | null;
            folders_scanned: number;
            folders_recorded: number;
            truncated: boolean;
            error: string | null;
          }>(
            `SELECT DISTINCT ON (audited_path_id) id, audited_path_id, status, started_at, finished_at, folders_scanned, folders_recorded, truncated, error
             FROM permission_scans WHERE audited_path_id = ANY($1::uuid[]) AND status <> 'running'
             ORDER BY audited_path_id, received_at DESC`,
            [pathIds],
          )
        ).rows
      : [];
    const byPath = new Map(scans.map((s) => [s.audited_path_id, s]));
    return agents.map((a) => ({
      id: a.id,
      hostname: a.hostname,
      os: a.os,
      agent_version: a.agentVersion,
      supported: versionAtLeast(a.agentVersion, MIN_AGENT_VERSION),
      requested_at: a.permissionsRequestedAt,
      scanned_at: a.permissionsScannedAt,
      // Pedido ainda não atendido pelo agente.
      pending: !!a.permissionsRequestedAt && (!a.permissionsScannedAt || a.permissionsScannedAt < a.permissionsRequestedAt),
      paths: a.auditedPaths.map((p) => {
        const s = byPath.get(p.id);
        return {
          id: p.id,
          path: p.path,
          scan: s
            ? {
                id: s.id,
                status: s.status,
                started_at: s.started_at,
                finished_at: s.finished_at,
                folders_scanned: s.folders_scanned,
                folders_recorded: s.folders_recorded,
                truncated: s.truncated,
                error: s.error,
              }
            : null,
        };
      }),
    }));
  }

  // Permissões da última coleta de cada caminho, com a marca do que é novo
  // desde a coleta anterior; removed traz o que existia antes e sumiu.
  async rows(f: PermissionFilters, limit: number): Promise<{ rows: PermissionRowJson[]; truncated: boolean; removed: PermissionRowJson[]; groups: AppendixGroup[] }> {
    const values: unknown[] = [f.tenantId];
    const scope: string[] = ['s.tenant_id = $1', `ap.desired_state = 'active'`];
    if (f.agentId) {
      values.push(f.agentId);
      scope.push(`s.agent_id = $${values.length}`);
    }
    if (f.pathId) {
      values.push(f.pathId);
      scope.push(`s.audited_path_id = $${values.length}`);
    }
    const scopeValues = [...values];
    const where: string[] = [];
    if (f.q) {
      values.push(`%${f.q.replace(/[\\%_]/g, (m) => '\\' + m)}%`);
      const p = `$${values.length}`;
      where.push(`(e.principal ILIKE ${p} OR e.sid ILIKE ${p} OR e.folder_path ILIKE ${p} OR e.share ILIKE ${p})`);
    }
    if (f.explicitOnly) where.push('e.inherited = false');
    if (f.denyOnly) where.push(`e.access = 'deny'`);
    const filter = where.length ? `AND ${where.join(' AND ')}` : '';
    const lim = `$${values.length + 1}`;

    const ctes = `
      WITH latest AS (
        SELECT DISTINCT ON (s.audited_path_id) s.id, s.audited_path_id, s.agent_id, s.received_at, s.status
        FROM permission_scans s JOIN audited_paths ap ON ap.id = s.audited_path_id
        WHERE ${scope.join(' AND ')} AND s.status <> 'running'
        ORDER BY s.audited_path_id, s.received_at DESC
      ), prev AS (
        SELECT DISTINCT ON (s.audited_path_id) s.id, s.audited_path_id
        FROM permission_scans s JOIN latest l ON l.audited_path_id = s.audited_path_id
        WHERE l.status = 'complete' AND s.status = 'complete' AND s.id <> l.id AND s.received_at < l.received_at
          AND EXISTS (SELECT 1 FROM permission_entries x WHERE x.scan_id = s.id)
        ORDER BY s.audited_path_id, s.received_at DESC
      )`;
    const cols = `e.folder_path, e.depth, e.source, e.share, e.owner, e.protected, e.reason, e.folder_error, e.principal, e.sid, e.kind,
      e.access, e.rights, e.raw, e.inherited, e.applies_to, a.id AS agent_id, a.hostname, ap.id AS audited_path_id, ap.path AS audited_path`;
    const current = await this.pg.query<PermissionRowJson>(
      `${ctes}, prevkeys AS (
         SELECT DISTINCT pv.audited_path_id, ${KEY('o')} AS k FROM prev pv JOIN permission_entries o ON o.scan_id = pv.id)
       SELECT ${cols}, (pv.id IS NOT NULL AND pk.k IS NULL) AS is_new
       FROM latest l
       JOIN permission_entries e ON e.scan_id = l.id
       JOIN agents a ON a.id = l.agent_id
       JOIN audited_paths ap ON ap.id = l.audited_path_id
       LEFT JOIN prev pv ON pv.audited_path_id = l.audited_path_id
       LEFT JOIN prevkeys pk ON pk.audited_path_id = l.audited_path_id AND pk.k = ${KEY('e')}
       WHERE true ${filter}
       ORDER BY a.hostname, ap.path_key, e.folder_path, e.id
       LIMIT ${lim}`,
      [...values, limit + 1],
    );
    const removed = await this.pg.query<PermissionRowJson>(
      `${ctes}, curkeys AS (
         SELECT DISTINCT l.audited_path_id, ${KEY('n')} AS k FROM latest l JOIN permission_entries n ON n.scan_id = l.id)
       SELECT ${cols}, false AS is_new
       FROM prev pv
       JOIN latest l ON l.audited_path_id = pv.audited_path_id
       JOIN permission_entries e ON e.scan_id = pv.id
       JOIN agents a ON a.id = l.agent_id
       JOIN audited_paths ap ON ap.id = l.audited_path_id
       LEFT JOIN curkeys ck ON ck.audited_path_id = pv.audited_path_id AND ck.k = ${KEY('e')}
       WHERE ck.k IS NULL AND e.principal IS NOT NULL ${filter}
       ORDER BY a.hostname, ap.path_key, e.folder_path, e.id
       LIMIT 200`,
      values,
    );
    const groupRecords = await this.pg.query<GroupRecord>(
      `${ctes}
       SELECT gm.group_name, gm.group_sid, gm.note, gm.error, gm.truncated, gm.member_name, gm.member_sid, gm.member_kind
       FROM latest l JOIN permission_group_members gm ON gm.scan_id = l.id
       ORDER BY gm.id`,
      scopeValues,
    );
    const rows = current.rows.slice(0, limit);
    return { rows, truncated: current.rows.length > limit, removed: removed.rows, groups: buildAppendix(rows, groupRecords.rows) };
  }

  // Tabela para Excel e PDF.
  // Tabela principal e o apêndice com os membros dos grupos citados.
  async table(f: PermissionFilters, max: number, ctx: { tenantName: string; userName: string; now?: Date }): Promise<{ main: ReportTable; appendix: ReportTable }> {
    const { rows, truncated, removed, groups } = await this.rows(f, max);
    const filters: string[] = [];
    if (f.q) filters.push(`contém "${f.q}"`);
    if (f.explicitOnly) filters.push('só permissões definidas na própria pasta');
    if (f.denyOnly) filters.push('só negações');
    const info = [`Empresa: ${ctx.tenantName}`];
    if (filters.length) info.push(`Filtros: ${filters.join('; ')}`);
    info.push('Última coleta de cada caminho auditado. O acesso real é o menor entre a permissão do compartilhamento e a da pasta.');
    info.push(`Gerado em ${formatDateTime((ctx.now ?? new Date()).toISOString())} por ${ctx.userName}`);
    const col = (key: string, label: string, kind: ReportColumn['kind'] = 'text'): ReportColumn => ({ key, label, kind });
    const cell = (r: PermissionRowJson, status: string) => ({
      hostname: r.hostname,
      folder: r.folder_path,
      source: r.source === 'share' && r.share ? `Compartilhamento ${r.share}` : (SOURCE_LABELS[r.source] ?? r.source),
      principal: r.principal ?? (r.folder_error ? '(erro de leitura)' : '(nenhuma permissão)'),
      kind: r.kind ? (KIND_LABELS[r.kind] ?? r.kind) : null,
      access: r.access ? (ACCESS_LABELS[r.access] ?? r.access) : null,
      rights: r.rights,
      applies: r.applies_to,
      inherited: r.principal ? (r.inherited ? 'Sim' : 'Não') : null,
      owner: r.owner,
      status: status || r.folder_error || '',
    });
    const main: ReportTable = {
      title: 'Inventário de permissões',
      info,
      columns: [
        col('hostname', 'Servidor'),
        col('folder', 'Pasta', 'path'),
        col('source', 'Origem'),
        col('principal', 'Usuário ou grupo'),
        col('kind', 'Tipo'),
        col('access', 'Permitir/Negar'),
        col('rights', 'Permissão'),
        col('applies', 'Vale para'),
        col('inherited', 'Herdada'),
        col('owner', 'Dono da pasta'),
        col('status', 'Observação'),
      ],
      rows: [...rows.map((r) => cell(r, r.is_new ? 'Nova desde a coleta anterior' : '')), ...removed.map((r) => cell(r, 'Removida desde a coleta anterior'))],
      truncated,
    };
    return { main, appendix: appendixTable(groups, ctx.tenantName) };
  }
}

// Apêndice: uma linha por membro; grupo sem lista vira uma linha com a observação.
export function appendixTable(groups: AppendixGroup[], tenantName: string): ReportTable {
  const rows: ReportTable['rows'] = [];
  for (const g of groups) {
    const obs = [g.note, g.error && `Não foi possível listar: ${g.error}`, g.truncated && 'Lista cortada no limite de membros'].filter(Boolean).join('; ');
    if (g.members.length === 0) {
      rows.push({ group: g.name, member: obs ? null : '(nenhum membro)', kind: null, via: null, obs });
      continue;
    }
    g.members.forEach((m, i) => {
      rows.push({ group: g.name, member: m.name, kind: MEMBER_KIND_LABELS[m.kind] ?? m.kind, via: m.via ? `Pelo grupo ${m.via}` : 'Direto', obs: i === 0 ? obs : '' });
    });
  }
  return {
    title: 'Apêndice: membros dos grupos citados',
    info: [
      `Empresa: ${tenantName}`,
      'Quem faz parte de cada grupo que aparece no inventário, inclusive pelos grupos que estão dentro dele (coluna "Como faz parte").',
      'Grupos especiais do Windows, como Todos e Usuários autenticados, não têm lista de membros: valem para qualquer conta do tipo descrito.',
    ],
    columns: [
      { key: 'group', label: 'Grupo', kind: 'text' },
      { key: 'member', label: 'Membro', kind: 'text' },
      { key: 'kind', label: 'Tipo', kind: 'text' },
      { key: 'via', label: 'Como faz parte', kind: 'text' },
      { key: 'obs', label: 'Observação', kind: 'text' },
    ],
    rows,
    truncated: false,
  };
}

const MEMBER_KIND_LABELS: Record<string, string> = { user: 'Usuário', group: 'Grupo', unknown: 'Desconhecido' };

type Client = pg.PoolClient;

// Insere as linhas de uma vez, com unnest (milhares por parte).
async function insertRows(c: Client, scanId: string, rows: PermissionUpload['rows']) {
  const col = <K extends keyof (typeof rows)[number]>(k: K) => rows.map((r) => r[k]);
  await c.query(
    `INSERT INTO permission_entries (scan_id, folder_path, depth, source, share, owner, protected, reason, folder_error,
       principal, sid, kind, access, rights, raw, inherited, applies_to)
     SELECT $1, * FROM unnest($2::text[], $3::int[], $4::text[], $5::text[], $6::text[], $7::bool[], $8::text[], $9::text[],
       $10::text[], $11::text[], $12::text[], $13::text[], $14::text[], $15::text[], $16::bool[], $17::text[])`,
    [
      scanId,
      col('folderPath'),
      col('depth'),
      col('source'),
      col('share'),
      col('owner'),
      col('protected'),
      col('reason'),
      col('folderError'),
      col('principal'),
      col('sid'),
      col('kind'),
      col('access'),
      col('rights'),
      col('raw'),
      col('inherited'),
      col('appliesTo'),
    ],
  );
}

async function insertGroupRows(c: Client, scanId: string, rows: GroupMemberRow[]) {
  const col = <K extends keyof GroupMemberRow>(k: K) => rows.map((r) => r[k]);
  await c.query(
    `INSERT INTO permission_group_members (scan_id, group_name, group_sid, note, error, truncated, member_name, member_sid, member_kind)
     SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::bool[], $7::text[], $8::text[], $9::text[])`,
    [scanId, col('groupName'), col('groupSid'), col('note'), col('error'), col('truncated'), col('memberName'), col('memberSid'), col('memberKind')],
  );
}
