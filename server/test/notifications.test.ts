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
import { GraphMailer } from '../src/notifications/graph.js';
import { parseMailSettings } from '../src/notifications/mail-settings.js';
import { decryptSecret, encryptSecret } from '../src/notifications/secrets.js';
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

process.env.SECRETS_KEY ??= 'chave-de-teste-com-mais-de-32-caracteres-0123456789';

describe('servidor de e-mail: regras', () => {
  it('segredo criptografado volta igual e não fica em texto', () => {
    const e = encryptSecret('s3nh@-secreta');
    assert.match(e, /^v1:/);
    assert.ok(!e.includes('s3nh@'));
    assert.notEqual(encryptSecret('s3nh@-secreta'), e, 'cada vez um IV');
    assert.equal(decryptSecret(e), 's3nh@-secreta');
    assert.throws(() => decryptSecret('v1:' + Buffer.from('x'.repeat(40)).toString('base64')), /SECRETS_KEY/);
  });

  it('formulário: Microsoft 365 e SMTP', () => {
    const tenant = '3f2a9c1e-8b7d-4c6e-9a1b-2c3d4e5f6a7b';
    const ms = parseMailSettings(
      { provider: 'microsoft365', from_address: 'Nao-Responda@TechMaster.inf.br', ms_tenant_id: tenant, ms_client_id: tenant.toUpperCase(), ms_client_secret: 'abc', portal_url: 'https://audit.techmaster.inf.br/' },
      null,
    );
    assert.equal(ms.fromAddress, 'nao-responda@techmaster.inf.br');
    assert.equal(ms.msClientId, tenant);
    assert.equal(ms.portalUrl, 'https://audit.techmaster.inf.br');
    assert.throws(() => parseMailSettings({ provider: 'microsoft365', from_address: 'a@b.com', ms_tenant_id: tenant, ms_client_id: tenant }, null), /segredo/);
    // Segredo em branco com um já salvo: mantém.
    assert.equal(parseMailSettings({ provider: 'microsoft365', from_address: 'a@b.com', ms_tenant_id: 'techmaster.inf.br', ms_client_id: tenant }, { smtpPassword: null, msClientSecret: 'v1:x' }).msClientSecret, undefined);
    const smtp = parseMailSettings({ provider: 'smtp', from_address: 'a@b.com', smtp_host: 'smtp.exemplo.com', smtp_port: '465', smtp_security: 'tls' }, null);
    assert.deepEqual([smtp.smtpHost, smtp.smtpPort, smtp.smtpSecurity, smtp.smtpUser], ['smtp.exemplo.com', 465, 'tls', null]);
    assert.throws(() => parseMailSettings({ provider: 'smtp', from_address: 'a@b.com', smtp_host: 'x y' }, null), /servidor SMTP/);
    assert.throws(() => parseMailSettings({ provider: 'smtp', from_address: 'a@b.com', smtp_host: 'smtp.x.com', smtp_user: 'u' }, null), /senha/);
    assert.throws(() => parseMailSettings({ provider: 'gmail', from_address: 'a@b.com' }, null), /Microsoft 365 ou SMTP/);
    assert.throws(() => parseMailSettings({ provider: 'smtp', from_address: 'a@b.com', smtp_host: 'smtp.x.com', portal_url: 'javascript:alert(1)' }, null), /https/);
  });

  it('Microsoft 365: token OAuth, sendMail e anexo grande por upload', async () => {
    const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
    let tokens = 0;
    const fake = async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method ?? 'GET', headers: (init.headers ?? {}) as Record<string, string>, body: init.body });
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
      if (url.includes('/oauth2/v2.0/token')) return json({ access_token: `tok${++tokens}`, expires_in: 3600 });
      if (url.endsWith('/messages')) return json({ id: 'draft1' }, 201);
      if (url.endsWith('/createUploadSession')) return json({ uploadUrl: 'https://upload.example/session' });
      if (url.startsWith('https://upload.example')) return json({}, 200);
      return new Response(null, { status: 202 });
    };
    const g = new GraphMailer({ tenantId: 'tid', clientId: 'cid', clientSecret: 'sec', from: 'nao-responda@techmaster.inf.br', fromName: 'Tech Audit' }, fake);
    await g.send({ to: ['a@b.com'], subject: 'Oi', text: 'oi', html: '<p>oi</p>', attachments: [{ filename: 'r.pdf', content: Buffer.from('pdf'), contentType: 'application/pdf' }] });
    const token = calls[0];
    assert.match(token.url, /login\.microsoftonline\.com\/tid\/oauth2\/v2\.0\/token/);
    assert.match(String(token.body), /grant_type=client_credentials/);
    assert.match(String(token.body), /scope=https%3A%2F%2Fgraph\.microsoft\.com%2F\.default/);
    const send = calls[1];
    assert.equal(send.url, 'https://graph.microsoft.com/v1.0/users/nao-responda%40techmaster.inf.br/sendMail');
    assert.equal(send.headers.authorization, 'Bearer tok1');
    const msg = JSON.parse(String(send.body)).message;
    assert.deepEqual(msg.toRecipients, [{ emailAddress: { address: 'a@b.com' } }]);
    assert.equal(msg.attachments[0].contentBytes, Buffer.from('pdf').toString('base64'));

    calls.length = 0;
    const big = Buffer.alloc(4 * 1024 * 1024, 1);
    await g.send({ to: ['a@b.com'], subject: 'Grande', text: '', html: '', attachments: [{ filename: 'r.xlsx', content: big, contentType: 'application/x' }] });
    assert.equal(tokens, 1, 'reaproveita o token');
    assert.deepEqual(
      calls.map((c) => `${c.method} ${c.url.replace('https://graph.microsoft.com/v1.0/users/nao-responda%40techmaster.inf.br', '')}`),
      ['POST /messages', 'POST /messages/draft1/attachments/createUploadSession', 'PUT https://upload.example/session', 'PUT https://upload.example/session', 'PUT https://upload.example/session', 'PUT https://upload.example/session', 'POST /messages/draft1/send'],
    );
    assert.equal(calls[2].headers.authorization, undefined, 'upload sem token');
    assert.equal(calls[5].headers['content-range'], `bytes 3932160-4194303/4194304`);
  });

  it('Microsoft 365: erro da Graph vira mensagem clara', async () => {
    const fake = async (url: string) =>
      url.includes('token')
        ? new Response(JSON.stringify({ error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.\r\nTrace ID: x' }), { status: 401 })
        : new Response(null, { status: 202 });
    const g = new GraphMailer({ tenantId: 't', clientId: 'c', clientSecret: 's', from: 'a@b.com', fromName: 'x' }, fake);
    await assert.rejects(g.send({ to: ['x@y.com'], subject: 's', text: '', html: '' }), /login no Microsoft 365 recusado \(HTTP 401\): AADSTS7000215: Invalid client secret provided\.$/);
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

  it('tela Servidor de e-mail: só o administrador, segredo não volta', async () => {
    assert.equal((await call(admin, 'GET', '/admin/mail')).status, 403);
    const body = {
      provider: 'microsoft365',
      from_address: `nao-responda.${id}@techmaster.inf.br`,
      ms_tenant_id: 'techmaster.inf.br',
      ms_client_id: '3f2a9c1e-8b7d-4c6e-9a1b-2c3d4e5f6a7b',
      ms_client_secret: 'segredo-muito-secreto',
      portal_url: 'https://audit.techmaster.inf.br',
    };
    const r = await call(msp, 'POST', '/admin/mail', body);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.has_ms_client_secret, true);
    assert.ok(!JSON.stringify(r.body).includes('segredo-muito'));
    const row = await prisma.mailSettings.findUniqueOrThrow({ where: { id: 1 } });
    assert.match(row.msClientSecret!, /^v1:/);
    // Salvar sem o segredo mantém o anterior.
    await call(msp, 'POST', '/admin/mail', { ...body, ms_client_secret: '' });
    assert.equal((await prisma.mailSettings.findUniqueOrThrow({ where: { id: 1 } })).msClientSecret, row.msClientSecret);
    const t = await call(msp, 'POST', '/admin/mail/test', { to: `rafael.${id}@techmaster.inf.br` });
    assert.equal(t.status, 200, JSON.stringify(t.body));
    assert.equal(mine().length, 0);
    assert.equal(sent.at(-1)!.subject, '[Tech Audit] Teste do servidor de e-mail');
    assert.match(String(sent.at(-1)!.text), /https:\/\/audit\.techmaster\.inf\.br\/painel/);
    // Trocar para SMTP apaga o segredo do Microsoft 365.
    const smtp = await call(msp, 'POST', '/admin/mail', { provider: 'smtp', from_address: 'a@b.com', smtp_host: 'smtp.exemplo.com', smtp_user: 'u', smtp_password: 'p' });
    assert.equal(smtp.body.has_ms_client_secret, false);
    assert.equal(smtp.body.has_smtp_password, true);
    await prisma.mailSettings.delete({ where: { id: 1 } });
    app.get(MailerService).invalidate();
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
      assert.match(d.error!, /Servidor de e-mail/);
    } finally {
      mailer.useTransport({ sendMail: async (m) => void sent.push(m) });
    }
  });
});
