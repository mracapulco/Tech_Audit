import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createLicense, createTenant, createUser } from '../src/admin/admin.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { migrateEvents } from '../src/db/events-migrations.js';
import { PgService } from '../src/db/pg.service.js';
import { parseBatch } from '../src/ingest/batch.js';
import { IngestService } from '../src/ingest/ingest.service.js';
import { MailerService } from '../src/notifications/mailer.service.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';
import { kindsFor, massDeletes, nextRun, parseRecipients, periodLabel, reportPeriod, scheduleLabel } from '../src/notifications/rules.js';
import { PrismaService } from '../src/prisma.service.js';
import { sampleEvent } from './fixtures.js';

describe('e-mails: regras', () => {
  it('próximo envio diário, semanal e mensal no horário de Brasília', () => {
    // 05/10/2026 (segunda) 10:00 em Brasília = 13:00 UTC.
    const at = new Date('2026-10-05T13:00:00Z');
    assert.equal(nextRun({ frequency: 'daily', weekday: null, hour: 7 }, at).toISOString(), '2026-10-06T10:00:00.000Z');
    assert.equal(nextRun({ frequency: 'daily', weekday: null, hour: 11 }, at).toISOString(), '2026-10-05T14:00:00.000Z');
    // 23:30 de domingo em Brasília já é segunda em UTC.
    assert.equal(nextRun({ frequency: 'daily', weekday: null, hour: 7 }, new Date('2026-10-05T02:30:00Z')).toISOString(), '2026-10-05T10:00:00.000Z');
    assert.equal(nextRun({ frequency: 'weekly', weekday: 1, hour: 7 }, at).toISOString(), '2026-10-12T10:00:00.000Z');
    assert.equal(nextRun({ frequency: 'weekly', weekday: 1, hour: 11 }, at).toISOString(), '2026-10-05T14:00:00.000Z');
    assert.equal(nextRun({ frequency: 'weekly', weekday: 7, hour: 0 }, at).toISOString(), '2026-10-11T03:00:00.000Z');
    assert.equal(nextRun({ frequency: 'monthly', weekday: null, hour: 7 }, at).toISOString(), '2026-11-01T10:00:00.000Z');
    assert.equal(nextRun({ frequency: 'monthly', weekday: null, hour: 7 }, new Date('2026-12-15T12:00:00Z')).toISOString(), '2027-01-01T10:00:00.000Z');
  });

  it('período coberto: ontem, 7 dias anteriores, mês anterior', () => {
    const at = new Date('2026-10-05T10:00:00Z');
    const iso = (p: { from: Date; to: Date }) => [p.from.toISOString(), p.to.toISOString()];
    assert.deepEqual(iso(reportPeriod('daily', at)), ['2026-10-04T03:00:00.000Z', '2026-10-05T03:00:00.000Z']);
    assert.deepEqual(iso(reportPeriod('weekly', at)), ['2026-09-28T03:00:00.000Z', '2026-10-05T03:00:00.000Z']);
    assert.deepEqual(iso(reportPeriod('monthly', at)), ['2026-09-01T03:00:00.000Z', '2026-10-01T03:00:00.000Z']);
    assert.deepEqual(iso(reportPeriod('monthly', new Date('2027-01-01T10:00:00Z'))), ['2026-12-01T03:00:00.000Z', '2027-01-01T03:00:00.000Z']);
    assert.equal(periodLabel(reportPeriod('daily', at)), '04/10/2026');
    assert.equal(periodLabel(reportPeriod('weekly', at)), '28/09/2026 a 04/10/2026');
    assert.equal(scheduleLabel({ frequency: 'weekly', weekday: 1, hour: 7 }), 'Toda segunda-feira, às 07:00 (7 dias anteriores)');
  });

  it('destinatários: separa, normaliza e valida', () => {
    assert.deepEqual(parseRecipients(' TI@Cliente.com.br; rafael@techmaster.inf.br,\nti@cliente.com.br ', true), ['ti@cliente.com.br', 'rafael@techmaster.inf.br']);
    assert.throws(() => parseRecipients('nao-e-email', true), /inválido/);
    assert.throws(() => parseRecipients('a@b.com <c@d.com>', true), /inválido/);
    assert.throws(() => parseRecipients('', true), /pelo menos um/);
    assert.deepEqual(parseRecipients('', false), []);
    assert.throws(() => parseRecipients(Array.from({ length: 11 }, (_, i) => `u${i}@x.com`), true), /no máximo 10/);
  });

  it('exclusão em massa: soma a janela de cada empresa', () => {
    const now = new Date('2026-10-05T13:00:00Z');
    const min = (m: number) => new Date(now.getTime() - m * 60_000);
    const rows = [
      { tenant_id: 'A', identity_id: '1', user_text: 'CORP\\joao', minute: min(2), total: 60, servers: ['FS1'] },
      { tenant_id: 'A', identity_id: '1', user_text: 'CORP\\joao', minute: min(5), total: 50, servers: ['FS2'] },
      { tenant_id: 'A', identity_id: '1', user_text: 'CORP\\joao', minute: min(30), total: 500, servers: ['FS1'] },
      { tenant_id: 'A', identity_id: '2', user_text: 'CORP\\maria', minute: min(1), total: 99, servers: ['FS1'] },
      { tenant_id: 'B', identity_id: '3', user_text: 'B\\ana', minute: min(30), total: 20, servers: ['X'] },
    ];
    const cfg = (t: string) => (t === 'A' ? { threshold: 100, windowMinutes: 10 } : { threshold: 20, windowMinutes: 60 });
    const r = massDeletes(rows, cfg, now);
    assert.deepEqual(
      r.map((m) => [m.tenantId, m.user, m.total, m.servers]),
      [
        ['A', 'CORP\\joao', 110, ['FS1', 'FS2']],
        ['B', 'B\\ana', 20, ['X']],
      ],
    );
  });

  it('grupos de alerta viram tipos', () => {
    assert.deepEqual([...kindsFor(['volume', 'agent_offline', 'xyz'])].sort(), ['agent_offline', 'agent_online', 'volume_100', 'volume_80']);
  });
});

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL não definido';
const PASSWORD = 'senha-de-teste-123';

describe('alertas e relatórios por e-mail', { skip }, () => {
  let app: NestExpressApplication;
  let base: string;
  let prisma: PrismaService;
  let svc: NotificationsService;
  let mailer: MailerService;
  let tenantPro: string;
  let tenantEss: string;
  let admin: string;
  let auditor: string;
  let essAdmin: string;
  let msp: string;
  const sent: Record<string, unknown>[] = [];
  let fail = false;
  const id = randomUUID().slice(0, 8);

  const login = async (email: string) => {
    const r = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    return (await r.json()).token as string;
  };
  const call = async (token: string, method: string, path: string, body?: unknown) => {
    const r = await fetch(`${base}/api${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  };
  const mine = () => sent.filter((m) => String(m.subject).includes(id));

  before(async () => {
    app = configureApp(await NestFactory.create<NestExpressApplication>(AppModule, { logger: false }));
    await app.listen(0);
    base = (await app.getUrl()).replace('[::1]', 'localhost');
    prisma = app.get(PrismaService);
    svc = app.get(NotificationsService);
    mailer = app.get(MailerService);
    await migrateEvents(app.get(PgService));
    mailer.useTransport({
      sendMail: async (m) => {
        if (fail) throw new Error('SMTP fora do ar');
        sent.push(m);
        return {};
      },
    });

    tenantPro = (await createTenant(prisma, `Alertas Pro ${id}`)).id;
    tenantEss = (await createTenant(prisma, `Alertas Ess ${id}`)).id;
    for (const [tenantId, plan] of [
      [tenantPro, 'Profissional'],
      [tenantEss, 'Essencial'],
    ]) {
      await createLicense(prisma, {
        tenantId,
        plan,
        maxAgents: 5,
        maxVolumeBytes: 1n << 40n,
        validFrom: new Date('2026-01-01T03:00:00Z'),
        validUntil: new Date('2099-01-01T03:00:00Z'),
      });
    }
    await createUser(prisma, { email: `adm.${id}@pro.com`, name: 'Admin Pro', role: 'tenant_admin', tenantId: tenantPro, password: PASSWORD });
    await createUser(prisma, { email: `aud.${id}@pro.com`, name: 'Auditor Pro', role: 'tenant_auditor', tenantId: tenantPro, password: PASSWORD });
    await createUser(prisma, { email: `adm.${id}@ess.com`, name: 'Admin Ess', role: 'tenant_admin', tenantId: tenantEss, password: PASSWORD });
    await createUser(prisma, { email: `msp.${id}@techmaster.inf.br`, name: 'Suporte', role: 'msp_admin', password: PASSWORD });
    admin = await login(`adm.${id}@pro.com`);
    auditor = await login(`aud.${id}@pro.com`);
    essAdmin = await login(`adm.${id}@ess.com`);
    msp = await login(`msp.${id}@techmaster.inf.br`);
  });

  after(async () => {
    await app?.close();
  });

  beforeEach(() => {
    sent.length = 0;
    fail = false;
  });

  it('tela: plano, padrões e permissões', async () => {
    const v = await call(auditor, 'GET', '/notifications');
    assert.equal(v.status, 200);
    assert.equal(v.body.plan_allows, true);
    assert.equal(v.body.email_configured, true);
    assert.equal(v.body.alerts.saved, false);
    assert.deepEqual(
      v.body.alerts.groups.filter((g: { enabled: boolean }) => g.enabled).map((g: { key: string }) => g.key),
      ['agent_offline', 'mass_delete', 'volume', 'audit_error'],
    );
    assert.equal((await call(auditor, 'POST', '/notifications/alerts', { recipients: 'a@b.com' })).status, 403);
    assert.equal((await call(admin, 'GET', `/notifications?tenant=${tenantEss}`)).status, 403);
    const ess = await call(essAdmin, 'GET', '/notifications');
    assert.equal(ess.body.plan_allows, false);
    const blocked = await call(essAdmin, 'POST', '/notifications/alerts', { recipients: 'a@b.com', groups: ['volume'] });
    assert.equal(blocked.status, 403);
    assert.match(blocked.body.message, /Profissional e Enterprise/);
    assert.equal((await call(msp, 'GET', `/notifications?tenant=${tenantEss}`)).status, 200);
  });

  it('salva destinatários e manda o e-mail de teste', async () => {
    const r = await call(admin, 'POST', '/notifications/alerts', {
      recipients: `ti.${id}@pro.com, Gestor.${id}@pro.com`,
      groups: ['agent_offline', 'mass_delete', 'volume'],
      mass_delete_threshold: '20',
      mass_delete_window_minutes: 5,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body.alerts.recipients, [`ti.${id}@pro.com`, `gestor.${id}@pro.com`]);
    assert.equal(r.body.alerts.mass_delete_threshold, 20);
    assert.equal((await call(admin, 'POST', '/notifications/alerts', { groups: ['nada'] })).status, 400);

    const t = await call(admin, 'POST', '/notifications/test');
    assert.equal(t.status, 200, JSON.stringify(t.body));
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].to, [`ti.${id}@pro.com`, `gestor.${id}@pro.com`]);
    assert.match(String(sent[0].subject), /e-mail de teste/);
    assert.equal((await call(admin, 'POST', '/notifications/test')).status, 400, 'um teste por minuto');
    const v = await call(admin, 'GET', '/notifications');
    assert.equal(v.body.deliveries[0].kind, 'test');
    assert.equal(v.body.deliveries[0].status, 'sent');
  });

  it('alertas novos vão num e-mail só; tipos desligados e outros planos não', async () => {
    const mk = (tenantId: string, kind: string, message: string) =>
      prisma.alert.create({ data: { tenantId, kind, severity: 'warning', message: `${message} ${id}` } });
    await mk(tenantPro, 'volume_80', 'Volume em 80%');
    await mk(tenantPro, 'audit_config_changed', 'Auditoria aplicada');
    await mk(tenantPro, 'volume_100', 'Volume em 100%');
    await mk(tenantEss, 'volume_80', 'Essencial');
    await svc.sendAlertEmails();
    const m = mine();
    assert.equal(m.length, 1);
    assert.match(String(m[0].subject), /2 alertas/);
    assert.match(String(m[0].text), /Volume em 80%/);
    assert.match(String(m[0].text), /Volume em 100%/);
    assert.doesNotMatch(String(m[0].text), /Auditoria aplicada/);
    assert.equal(await prisma.alert.count({ where: { tenantId: { in: [tenantPro, tenantEss] }, emailedAt: null } }), 0);
    sent.length = 0;
    await svc.sendAlertEmails();
    assert.equal(mine().length, 0, 'não manda de novo');
  });

  it('falha no SMTP: tenta 3 vezes e registra', async () => {
    await prisma.alert.create({ data: { tenantId: tenantPro, kind: 'volume_80', severity: 'warning', message: `Falha ${id}` } });
    fail = true;
    for (let i = 0; i < 3; i++) await svc.sendAlertEmails();
    const a = await prisma.alert.findFirstOrThrow({ where: { tenantId: tenantPro, message: `Falha ${id}` } });
    assert.equal(a.emailAttempts, 3);
    assert.ok(a.emailedAt);
    const d = await prisma.emailDelivery.findMany({ where: { tenantId: tenantPro, kind: 'alert', status: 'failed' } });
    assert.equal(d.length, 3);
    assert.match(d[0].error!, /SMTP fora do ar/);
  });

  it('servidor parado e de volta', async () => {
    const agent = await prisma.agent.create({
      data: { tenantId: tenantPro, hostname: `FS-OFF-${id}`, os: 'windows', machineId: randomUUID(), tokenHash: randomUUID(), lastHeartbeatAt: new Date(Date.now() - 2 * 3600_000) },
    });
    await svc.checkAgents();
    await svc.checkAgents();
    let alerts = await prisma.alert.findMany({ where: { agentId: agent.id }, orderBy: { id: 'asc' } });
    assert.deepEqual(alerts.map((a) => a.kind), ['agent_offline'], 'um alerta só');
    assert.match(alerts[0].message, /parou de enviar dados/);
    await prisma.agent.update({ where: { id: agent.id }, data: { lastHeartbeatAt: new Date() } });
    await svc.checkAgents();
    alerts = await prisma.alert.findMany({ where: { agentId: agent.id }, orderBy: { id: 'asc' } });
    assert.deepEqual(alerts.map((a) => a.kind), ['agent_offline', 'agent_online']);
    await svc.sendAlertEmails();
    const m = mine();
    assert.equal(m.length, 1);
    assert.match(String(m[0].text), /parou de enviar dados/);
    assert.match(String(m[0].text), /voltou a enviar/);
    await prisma.agent.update({ where: { id: agent.id }, data: { disabledAt: new Date() } });
  });

  it('exclusão em massa de um usuário', async () => {
    const agent = await prisma.agent.create({
      data: { tenantId: tenantPro, hostname: `FS-DEL-${id}`, os: 'windows', machineId: randomUUID(), tokenHash: randomUUID() },
    });
    const now = Date.now();
    const ev = (n: number, user: string, action: string, count?: number) => ({
      ...sampleEvent,
      record_id: n,
      time: new Date(now - 60_000 + n).toISOString(),
      user: { name: user, domain: 'CORP', sid: `S-1-5-21-9-${user}-${id}` },
      path: `D:\\Dados\\arquivo-${n}.txt`,
      action,
      actions: ['delete'],
      outcome: 'success',
      ...(count ? { count } : {}),
    });
    const events = [
      ...Array.from({ length: 12 }, (_, i) => ev(i + 1, `apagador${id}`, 'deleted')),
      ev(100, `apagador${id}`, 'recycled', 10),
      ...Array.from({ length: 5 }, (_, i) => ev(200 + i, `normal${id}`, 'deleted')),
      ...Array.from({ length: 30 }, (_, i) => ev(300 + i, `leitor${id}`, 'read')),
    ];
    await app.get(IngestService).ingest({ id: agent.id, tenantId: tenantPro }, parseBatch({ batch_id: randomUUID(), events }), 'x');
    await svc.checkMassDeletes();
    await svc.checkMassDeletes();
    const alerts = await prisma.alert.findMany({ where: { tenantId: tenantPro, kind: 'mass_delete' } });
    assert.equal(alerts.length, 1, 'um alerta por janela');
    assert.match(alerts[0].message, new RegExp(`CORP\\\\apagador${id} excluiu 22 itens em até 5 minutos \\(FS-DEL-${id}\\)`));
    assert.equal(alerts[0].severity, 'critical');
    await svc.sendAlertEmails();
    assert.match(String(mine()[0].text), /Exclusão em massa/);
    await prisma.agent.update({ where: { id: agent.id }, data: { disabledAt: new Date() } });
  });

  it('relatório agendado: cadastro, envio no horário e enviar agora', async () => {
    const bad = await call(admin, 'POST', '/notifications/reports', { name: 'x', report_type: 'usuarios', format: 'pdf', frequency: 'daily', recipients: '' });
    assert.equal(bad.status, 400);
    const r = await call(admin, 'POST', '/notifications/reports', {
      name: `Resumo semanal ${id}`,
      report_type: 'usuarios',
      format: 'xlsx',
      frequency: 'weekly',
      weekday: 1,
      hour: 7,
      recipients: `diretoria.${id}@pro.com`,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.schedule_label, 'Toda segunda-feira, às 07:00 (7 dias anteriores)');
    const next = new Date(r.body.next_run_at);
    assert.equal(next.getUTCDay(), 1);
    assert.equal(next.getUTCHours(), 10);

    // Ainda não é hora.
    await svc.runDueReports(new Date(next.getTime() - 60_000));
    assert.equal(mine().length, 0);
    await svc.runDueReports(next);
    await svc.runDueReports(next);
    const m = mine();
    assert.equal(m.length, 1, 'envia uma vez');
    assert.deepEqual(m[0].to, [`diretoria.${id}@pro.com`]);
    const att = (m[0].attachments as { filename: string; content: Buffer }[])[0];
    assert.match(att.filename, /^relatorio-usuarios-.*\.xlsx$/);
    assert.equal(att.content.subarray(0, 2).toString(), 'PK');
    let row = await prisma.scheduledReport.findUniqueOrThrow({ where: { id: r.body.id } });
    assert.equal(row.lastStatus, 'sent');
    assert.equal(row.nextRunAt.getTime() - next.getTime(), 7 * 24 * 3600_000);

    sent.length = 0;
    await prisma.scheduledReport.update({ where: { id: r.body.id }, data: { lastRunAt: new Date(Date.now() - 120_000) } });
    const now = await call(admin, 'POST', `/notifications/reports/${r.body.id}/send`);
    assert.equal(now.status, 200, JSON.stringify(now.body));
    assert.equal(mine().length, 1);
    assert.equal((await call(admin, 'POST', `/notifications/reports/${r.body.id}/send`)).status, 400, 'um por minuto');

    const paused = await call(admin, 'PATCH', `/notifications/reports/${r.body.id}`, { enabled: false });
    assert.equal(paused.body.enabled, false);
    const edited = await call(admin, 'PATCH', `/notifications/reports/${r.body.id}`, {
      name: `Mensal ${id}`,
      report_type: 'eventos',
      format: 'pdf',
      frequency: 'monthly',
      hour: 6,
      filter_action: 'deleted',
      recipients: [`diretoria.${id}@pro.com`],
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.schedule_label, 'Todo dia 1º, às 06:00 (mês anterior)');
    assert.equal(edited.body.enabled, true);

    // Outra empresa e auditor não mexem.
    assert.equal((await call(essAdmin, 'DELETE', `/notifications/reports/${r.body.id}`)).status, 404);
    assert.equal((await call(auditor, 'DELETE', `/notifications/reports/${r.body.id}`)).status, 403);

    // Plano rebaixado: o envio é pulado e fica registrado.
    await prisma.license.updateMany({ where: { tenantId: tenantPro }, data: { plan: 'Essencial' } });
    row = await prisma.scheduledReport.findUniqueOrThrow({ where: { id: r.body.id } });
    sent.length = 0;
    await svc.runDueReports(row.nextRunAt);
    assert.equal(mine().length, 0);
    row = await prisma.scheduledReport.findUniqueOrThrow({ where: { id: r.body.id } });
    assert.equal(row.lastStatus, 'skipped');
    await prisma.license.updateMany({ where: { tenantId: tenantPro }, data: { plan: 'Profissional' } });

    assert.equal((await call(admin, 'DELETE', `/notifications/reports/${r.body.id}`)).status, 200);
    assert.equal((await call(admin, 'GET', '/notifications')).body.reports.length, 0);
  });

  it('sem SMTP configurado: registra e não trava', async () => {
    mailer.useTransport(null);
    try {
      const v = await call(admin, 'GET', '/notifications');
      assert.equal(v.body.email_configured, false);
      await prisma.alert.create({ data: { tenantId: tenantPro, kind: 'volume_100', severity: 'critical', message: `Sem SMTP ${id}` } });
      await svc.sendAlertEmails();
      const a = await prisma.alert.findFirstOrThrow({ where: { message: `Sem SMTP ${id}` } });
      assert.ok(a.emailedAt);
      const d = await prisma.emailDelivery.findFirstOrThrow({ where: { tenantId: tenantPro, kind: 'alert' }, orderBy: { id: 'desc' } });
      assert.equal(d.status, 'skipped');
      assert.match(d.error!, /SMTP_HOST/);
    } finally {
      mailer.useTransport({ sendMail: async (m) => void sent.push(m) });
    }
  });
});
