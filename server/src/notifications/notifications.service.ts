import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import type { PortalUser } from '../auth/roles.js';
import { isMspRole } from '../auth/roles.js';
import { PgService } from '../db/pg.service.js';
import type { EventFilters } from '../events/event-query.js';
import type { Prisma } from '../generated/prisma/client.js';
import { acceptsIngestion, evaluateLicenses } from '../licensing/license.js';
import { emailAllowed } from '../licensing/plans.js';
import { PrismaService } from '../prisma.service.js';
import { REPORT_LIMITS } from '../reports/reports.controller.js';
import { agentHealth, lastContact, REPORT_TITLES, ReportsService, type ReportType } from '../reports/reports.service.js';
import { reportPdf } from '../reports/pdf.js';
import { actionLabel, formatDateTime } from '../reports/table.js';
import { reportXlsx } from '../reports/xlsx.js';
import { MailerService, MailNotConfiguredError } from './mailer.service.js';
import {
  ALERT_GROUP_KEYS,
  ALERT_GROUPS,
  DEFAULT_ALERT_GROUPS,
  kindsFor,
  MASS_DELETE_DEFAULTS,
  MASS_DELETE_MAX_WINDOW,
  massDeletes,
  nextRun,
  periodLabel,
  reportPeriod,
  scheduleLabel,
  type AlertSettingsInput,
  type DeleteMinute,
  type Frequency,
  type ScheduleInput,
} from './rules.js';
import { alertMail, reportMail, testMail } from './templates.js';

type ScheduledRow = Awaited<ReturnType<PrismaService['scheduledReport']['findMany']>>[number];

// Alertas não enviados depois disso não vão mais por e-mail (ficam só no portal).
const ALERT_MAX_AGE_MS = 24 * 3600_000;
const MAX_EMAIL_ATTEMPTS = 3;
// Linhas do relatório "Eventos detalhados" por e-mail; o anexo precisa caber.
const EMAIL_EVENT_ROWS = 20_000;
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
// Envio de teste ou "enviar agora": no máximo um por minuto.
const MANUAL_INTERVAL_MS = 60_000;

const CONTENT_TYPE = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
} as const;

export const WRITE_ROLES = ['msp_admin', 'msp_operator', 'tenant_admin'];

const planMessage = 'Alertas e relatórios por e-mail fazem parte dos planos Profissional e Enterprise. Fale com a Tech Master para mudar o plano.';

const reportJson = (r: ScheduledRow) => ({
  id: r.id,
  tenant_id: r.tenantId,
  name: r.name,
  report_type: r.reportType,
  report_title: REPORT_TITLES[r.reportType as ReportType] ?? r.reportType,
  format: r.format,
  frequency: r.frequency,
  weekday: r.weekday,
  hour: r.hour,
  schedule_label: scheduleLabel({ frequency: r.frequency as Frequency, weekday: r.weekday, hour: r.hour }),
  filter_user: r.filterUser,
  filter_path: r.filterPath,
  filter_action: r.filterAction,
  recipients: r.recipients,
  enabled: r.enabled,
  next_run_at: r.nextRunAt,
  last_run_at: r.lastRunAt,
  last_status: r.lastStatus,
  last_error: r.lastError,
  created_by_name: r.createdByName,
  created_at: r.createdAt,
});

// Alertas por e-mail e relatórios agendados (planos Profissional e
// Enterprise). Um laço a cada minuto (NOTIFY_INTERVAL_MS) detecta servidores
// parados e exclusões em massa, manda os alertas novos e os relatórios do horário.
@Injectable()
export class NotificationsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(NotificationsService.name);
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly pg: PgService,
    private readonly reports: ReportsService,
    private readonly mailer: MailerService,
  ) {}

  onApplicationBootstrap() {
    const every = Number(process.env.NOTIFY_INTERVAL_MS ?? 60_000);
    if (!(every > 0)) return;
    this.timer = setInterval(() => void this.tick(), every);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // Uma rodada do laço; cada etapa falha sozinha sem parar as outras.
  async tick(now = new Date()): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const [name, step] of [
        ['servidores parados', () => this.checkAgents(now)],
        ['exclusão em massa', () => this.checkMassDeletes(now)],
        ['e-mail de alertas', () => this.sendAlertEmails(now)],
        ['relatórios agendados', () => this.runDueReports(now)],
      ] as const) {
        try {
          await step();
        } catch (err) {
          this.logger.error(`${name}: ${(err as Error).message}`);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  // --- Acesso ---------------------------------------------------------------

  tenantFor(user: PortalUser, requested?: string): string {
    if (isMspRole(user.role)) {
      if (!requested) throw new BadRequestException('Informe a empresa');
      return requested;
    }
    if (!user.tenantId) throw new ForbiddenException('usuário sem empresa');
    if (requested && requested !== user.tenantId) throw new ForbiddenException('empresa de outro cliente');
    return user.tenantId;
  }

  assertCanWrite(user: PortalUser) {
    if (!WRITE_ROLES.includes(user.role)) throw new ForbiddenException('seu perfil só pode consultar os alertas e envios');
  }

  private async tenant(tenantId: string) {
    const t = await this.prisma.tenant.findUnique({ where: { id: tenantId }, include: { licenses: true, notificationSettings: true } });
    if (!t) throw new NotFoundException('empresa não encontrada');
    return { ...t, allowed: emailAllowed(evaluateLicenses(t.licenses, new Date()).licenses) };
  }

  private async assertPlan(tenantId: string) {
    const t = await this.tenant(tenantId);
    if (!t.allowed) throw new ForbiddenException(planMessage);
    return t;
  }

  // --- Portal ---------------------------------------------------------------

  async view(tenantId: string) {
    const t = await this.tenant(tenantId);
    const s = t.notificationSettings;
    const groups = s ? s.alertGroups : DEFAULT_ALERT_GROUPS;
    const [reports, deliveries] = await Promise.all([
      this.prisma.scheduledReport.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.emailDelivery.findMany({ where: { tenantId }, orderBy: { id: 'desc' }, take: 30 }),
    ]);
    return {
      tenant: { id: t.id, name: t.name },
      email_configured: await this.mailer.configured(),
      plan_allows: t.allowed,
      alerts: {
        saved: s !== null,
        recipients: s?.alertRecipients ?? [],
        groups: ALERT_GROUP_KEYS.map((k) => ({ key: k, label: ALERT_GROUPS[k].label, enabled: groups.includes(k) })),
        mass_delete_threshold: s?.massDeleteThreshold ?? MASS_DELETE_DEFAULTS.threshold,
        mass_delete_window_minutes: s?.massDeleteWindowMinutes ?? MASS_DELETE_DEFAULTS.windowMinutes,
      },
      reports: reports.map(reportJson),
      deliveries: deliveries.map((d) => ({
        id: d.id.toString(),
        kind: d.kind,
        subject: d.subject,
        recipients: d.recipients,
        status: d.status,
        error: d.error,
        created_at: d.createdAt,
      })),
    };
  }

  async saveAlerts(tenantId: string, user: PortalUser, input: AlertSettingsInput) {
    await this.assertPlan(tenantId);
    const data = {
      alertRecipients: input.recipients,
      alertGroups: input.groups,
      massDeleteThreshold: input.massDeleteThreshold,
      massDeleteWindowMinutes: input.massDeleteWindowMinutes,
      updatedById: user.id,
    };
    await this.prisma.notificationSettings.upsert({ where: { tenantId }, create: { tenantId, ...data }, update: data });
    return this.view(tenantId);
  }

  async sendTest(tenantId: string, user: PortalUser) {
    const t = await this.assertPlan(tenantId);
    const to = t.notificationSettings?.alertRecipients ?? [];
    if (to.length === 0) throw new BadRequestException('cadastre e salve pelo menos um destinatário dos alertas');
    const recent = await this.prisma.emailDelivery.findFirst({
      where: { tenantId, kind: 'test', createdAt: { gt: new Date(Date.now() - MANUAL_INTERVAL_MS) } },
    });
    if (recent) throw new BadRequestException('aguarde um minuto para enviar outro e-mail de teste');
    const m = testMail(await this.mailer.portalUrl(), { id: t.id, name: t.name }, user.name);
    const r = await this.deliver({ tenantId, kind: 'test', to, ...m });
    if (r.status !== 'sent') throw new BadRequestException(`o e-mail não foi enviado: ${r.error}`);
    return { ok: true, recipients: to };
  }

  async createReport(tenantId: string, user: PortalUser, input: ScheduleInput, now = new Date()) {
    await this.assertPlan(tenantId);
    const count = await this.prisma.scheduledReport.count({ where: { tenantId } });
    if (count >= 50) throw new BadRequestException('limite de 50 relatórios agendados por empresa');
    const row = await this.prisma.scheduledReport.create({
      data: { tenantId, ...input, nextRunAt: nextRun(input, now), createdById: user.id, createdByName: user.name },
    });
    return reportJson(row);
  }

  private async reportFor(user: PortalUser, id: string) {
    const r = await this.prisma.scheduledReport.findUnique({ where: { id } });
    if (!r || (!isMspRole(user.role) && r.tenantId !== user.tenantId)) throw new NotFoundException('relatório agendado não encontrado');
    return r;
  }

  async updateReport(user: PortalUser, id: string, input: ScheduleInput, now = new Date()) {
    const r = await this.reportFor(user, id);
    await this.assertPlan(r.tenantId);
    const row = await this.prisma.scheduledReport.update({ where: { id }, data: { ...input, nextRunAt: nextRun(input, now) } });
    return reportJson(row);
  }

  async setEnabled(user: PortalUser, id: string, enabled: boolean, now = new Date()) {
    const r = await this.reportFor(user, id);
    if (enabled) await this.assertPlan(r.tenantId);
    const row = await this.prisma.scheduledReport.update({
      where: { id },
      data: { enabled, nextRunAt: nextRun({ frequency: r.frequency as Frequency, weekday: r.weekday, hour: r.hour }, now) },
    });
    return reportJson(row);
  }

  async deleteReport(user: PortalUser, id: string) {
    const r = await this.reportFor(user, id);
    await this.prisma.scheduledReport.delete({ where: { id } });
    return r;
  }

  // "Enviar agora": manda o último período completo, sem mudar o próximo envio.
  async sendReportNow(user: PortalUser, id: string, now = new Date()) {
    const r = await this.reportFor(user, id);
    await this.assertPlan(r.tenantId);
    if (r.lastRunAt && now.getTime() - r.lastRunAt.getTime() < MANUAL_INTERVAL_MS) {
      throw new BadRequestException('aguarde um minuto para enviar este relatório de novo');
    }
    const res = await this.deliverReport(r, now);
    if (res.status !== 'sent') throw new BadRequestException(`o relatório não foi enviado: ${res.error}`);
    return reportJson(await this.prisma.scheduledReport.findUniqueOrThrow({ where: { id } }));
  }

  // --- Envio ----------------------------------------------------------------

  private async deliver(m: {
    tenantId: string;
    kind: 'alert' | 'report' | 'test';
    to: string[];
    subject: string;
    text: string;
    html: string;
    attachments?: { filename: string; content: Buffer; contentType: string }[];
    scheduledReportId?: string;
  }): Promise<{ status: 'sent' | 'failed' | 'skipped'; error: string | null }> {
    let status: 'sent' | 'failed' | 'skipped' = 'sent';
    let error: string | null = null;
    try {
      await this.mailer.send({ to: m.to, subject: m.subject, text: m.text, html: m.html, attachments: m.attachments });
    } catch (err) {
      status = err instanceof MailNotConfiguredError ? 'skipped' : 'failed';
      error = (err as Error).message.slice(0, 500);
      if (status === 'failed') this.logger.warn(`e-mail "${m.subject}" não enviado: ${error}`);
    }
    await this.prisma.emailDelivery.create({
      data: {
        tenantId: m.tenantId,
        kind: m.kind,
        scheduledReportId: m.scheduledReportId ?? null,
        subject: m.subject,
        recipients: m.to,
        status,
        error,
      },
    });
    return { status, error };
  }

  // --- Detecção -------------------------------------------------------------

  // Servidor que passou a "sem contato" (mesma regra do painel) ganha um
  // alerta; quando volta a responder, outro.
  async checkAgents(now = new Date()) {
    const agents = await this.prisma.agent.findMany({
      where: { disabledAt: null, OR: [{ lastHeartbeatAt: { not: null } }, { lastSeenAt: { not: null } }] },
      include: { tenant: { include: { licenses: true } } },
    });
    for (const a of agents) {
      const h = agentHealth(a, now);
      if (h === 'stale' && !a.offlineAlertAt) {
        // Licença vencida: o servidor para de aceitar dados; não é um problema do agente.
        if (!acceptsIngestion(evaluateLicenses(a.tenant.licenses, now))) continue;
        const last = lastContact(a);
        await this.prisma.$transaction([
          this.prisma.agent.update({ where: { id: a.id }, data: { offlineAlertAt: now } }),
          this.prisma.alert.create({
            data: {
              tenantId: a.tenantId,
              agentId: a.id,
              kind: 'agent_offline',
              severity: 'critical',
              message: `O servidor ${a.hostname} parou de enviar dados ao Tech Audit${last ? ` (último contato em ${formatDateTime(last.toISOString()).slice(0, 16)})` : ''}.`,
              details: { hostname: a.hostname, last_contact: last?.toISOString() ?? null },
            },
          }),
        ]);
      } else if (h === 'ok' && a.offlineAlertAt) {
        await this.prisma.$transaction([
          this.prisma.agent.update({ where: { id: a.id }, data: { offlineAlertAt: null } }),
          this.prisma.alert.create({
            data: {
              tenantId: a.tenantId,
              agentId: a.id,
              kind: 'agent_online',
              severity: 'info',
              message: `O servidor ${a.hostname} voltou a enviar dados ao Tech Audit.`,
              details: { hostname: a.hostname, offline_since: a.offlineAlertAt.toISOString() },
            },
          }),
        ]);
      }
    }
  }

  // Muitas exclusões (excluir ou mandar para a Lixeira) do mesmo usuário em
  // poucos minutos. Um alerta por usuário a cada janela.
  async checkMassDeletes(now = new Date()) {
    const since = new Date(now.getTime() - MASS_DELETE_MAX_WINDOW * 60_000);
    const { rows } = await this.pg.query<DeleteMinute>(
      `SELECT e.tenant_id, e.identity_id::text AS identity_id,
              CASE WHEN i.domain <> '' THEN i.domain || '\\' || i.name ELSE i.name END AS user_text,
              date_trunc('minute', e.time) AS minute,
              sum(COALESCE(e.event_count, 1))::int AS total,
              array_agg(DISTINCT a.hostname) AS servers
         FROM events.file_events e
         JOIN identities i ON i.id = e.identity_id
         JOIN agents a ON a.id = e.agent_id
        WHERE e.time > $1 AND e.time <= $2 AND e.success AND e.action IN ('deleted', 'recycled')
        GROUP BY 1, 2, 3, 4`,
      [since, now],
    );
    if (rows.length === 0) return;
    const tenantIds = [...new Set(rows.map((r) => r.tenant_id))];
    const settings = new Map(
      (await this.prisma.notificationSettings.findMany({ where: { tenantId: { in: tenantIds } } })).map((s) => [
        s.tenantId,
        { threshold: s.massDeleteThreshold, windowMinutes: s.massDeleteWindowMinutes },
      ]),
    );
    const cfg = (t: string) => settings.get(t) ?? MASS_DELETE_DEFAULTS;
    for (const m of massDeletes(rows, cfg, now)) {
      const window = cfg(m.tenantId).windowMinutes;
      const recent = await this.prisma.alert.findFirst({
        where: {
          tenantId: m.tenantId,
          kind: 'mass_delete',
          createdAt: { gt: new Date(now.getTime() - window * 60_000) },
          details: { path: ['identity_id'], equals: m.identityId },
        },
      });
      if (recent) continue;
      await this.prisma.alert.create({
        data: {
          tenantId: m.tenantId,
          kind: 'mass_delete',
          severity: 'critical',
          message: `Exclusão em massa: ${m.user} excluiu ${m.total.toLocaleString('pt-BR')} itens em até ${window} minutos (${m.servers.join(', ')}).`,
          details: {
            identity_id: m.identityId,
            user: m.user,
            total: m.total,
            servers: m.servers,
            window_minutes: window,
            from: m.from.toISOString(),
            to: m.to.toISOString(),
          } as Prisma.InputJsonValue,
        },
      });
    }
  }

  // --- Alertas por e-mail ---------------------------------------------------

  async sendAlertEmails(now = new Date()) {
    const cutoff = new Date(now.getTime() - ALERT_MAX_AGE_MS);
    await this.prisma.alert.updateMany({ where: { emailedAt: null, createdAt: { lt: cutoff } }, data: { emailedAt: now } });
    const pending = await this.prisma.alert.findMany({
      where: { emailedAt: null, createdAt: { gte: cutoff } },
      orderBy: { id: 'asc' },
      take: 1000,
    });
    const byTenant = new Map<string, typeof pending>();
    for (const a of pending) byTenant.set(a.tenantId, [...(byTenant.get(a.tenantId) ?? []), a]);

    for (const [tenantId, alerts] of byTenant) {
      const t = await this.prisma.tenant.findUnique({ where: { id: tenantId }, include: { licenses: true, notificationSettings: true } });
      const s = t?.notificationSettings;
      const kinds = kindsFor(s?.alertGroups ?? []);
      const send = alerts.filter((a) => kinds.has(a.kind));
      const ids = alerts.map((a) => a.id);
      const allowed = t ? emailAllowed(evaluateLicenses(t.licenses, now).licenses) : false;
      if (!t || !s || !allowed || s.alertRecipients.length === 0 || send.length === 0) {
        await this.prisma.alert.updateMany({ where: { id: { in: ids } }, data: { emailedAt: now } });
        continue;
      }
      const m = alertMail(await this.mailer.portalUrl(), { id: t.id, name: t.name }, send.map((a) => ({ severity: a.severity, message: a.message, createdAt: a.createdAt })));
      const r = await this.deliver({ tenantId, kind: 'alert', to: s.alertRecipients, ...m });
      if (r.status === 'failed') {
        // Tenta de novo nas próximas rodadas; depois de 3 falhas, desiste.
        await this.prisma.alert.updateMany({ where: { id: { in: ids } }, data: { emailAttempts: { increment: 1 } } });
        await this.prisma.alert.updateMany({ where: { id: { in: ids }, emailAttempts: { gte: MAX_EMAIL_ATTEMPTS } }, data: { emailedAt: now } });
      } else {
        await this.prisma.alert.updateMany({ where: { id: { in: ids } }, data: { emailedAt: now } });
      }
    }
  }

  // --- Relatórios agendados -------------------------------------------------

  async runDueReports(now = new Date()) {
    const due = await this.prisma.scheduledReport.findMany({ where: { enabled: true, nextRunAt: { lte: now } }, orderBy: { nextRunAt: 'asc' }, take: 20 });
    for (const r of due) {
      // Marca o próximo envio antes de gerar: outro processo não manda de novo.
      const claimed = await this.prisma.scheduledReport.updateMany({
        where: { id: r.id, nextRunAt: r.nextRunAt },
        data: { nextRunAt: nextRun({ frequency: r.frequency as Frequency, weekday: r.weekday, hour: r.hour }, now) },
      });
      if (claimed.count === 0) continue;
      try {
        await this.deliverReport(r, r.nextRunAt);
      } catch (err) {
        const message = (err as Error).message.slice(0, 500);
        this.logger.error(`relatório agendado ${r.id}: ${message}`);
        await this.prisma.scheduledReport.update({ where: { id: r.id }, data: { lastRunAt: now, lastStatus: 'failed', lastError: message } });
      }
    }
  }

  // Gera o relatório do período que termina no dia de `at` e manda por e-mail.
  async deliverReport(r: ScheduledRow, at: Date): Promise<{ status: string; error: string | null }> {
    const t = await this.prisma.tenant.findUniqueOrThrow({ where: { id: r.tenantId }, include: { licenses: true } });
    const done = async (status: string, error: string | null) => {
      await this.prisma.scheduledReport.update({ where: { id: r.id }, data: { lastRunAt: new Date(), lastStatus: status, lastError: error } });
      return { status, error };
    };
    if (!emailAllowed(evaluateLicenses(t.licenses, new Date()).licenses)) return done('skipped', 'o plano atual não inclui relatórios por e-mail');

    const period = reportPeriod(r.frequency as Frequency, at);
    const f: EventFilters = {
      tenantIds: [t.id],
      from: period.from,
      to: period.to,
      user: r.filterUser,
      pathPrefix: r.filterPath,
      action: r.filterAction,
    };
    const type = r.reportType as ReportType;
    const format = r.format as 'pdf' | 'xlsx';
    const limits = REPORT_LIMITS[format];
    const max = type === 'eventos' ? Math.min(limits.events, EMAIL_EVENT_ROWS) : limits.grouped;
    const table = await this.reports.report(type, f, max, { tenantName: t.name, userName: `envio agendado "${r.name}"` });
    const file = format === 'xlsx' ? reportXlsx(table) : await reportPdf(table, `Tech Audit · ${table.title} · ${table.info[0]}`);
    const attached = file.length <= MAX_ATTACHMENT_BYTES;
    const label = periodLabel(period);
    const filters = [
      r.filterUser && `usuário contém "${r.filterUser}"`,
      r.filterPath && `caminho começa com "${r.filterPath}"`,
      r.filterAction && `ação: ${actionLabel(r.filterAction)}`,
    ].filter((x): x is string => !!x);
    const m = reportMail({
      base: await this.mailer.portalUrl(),
      tenant: { id: t.id, name: t.name },
      name: r.name,
      title: table.title,
      period: label,
      schedule: scheduleLabel({ frequency: r.frequency as Frequency, weekday: r.weekday, hour: r.hour }),
      rows: table.rows.length,
      truncated: table.truncated,
      filters,
      attached,
    });
    const stamp = label.replace(/\//g, '-').replace(/ a /, '_');
    const res = await this.deliver({
      tenantId: t.id,
      kind: 'report',
      scheduledReportId: r.id,
      to: r.recipients,
      ...m,
      attachments: attached ? [{ filename: `relatorio-${type}-${stamp}.${format}`, content: file, contentType: CONTENT_TYPE[format] }] : [],
    });
    return done(res.status, res.error);
  }
}
