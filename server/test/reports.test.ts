import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { createLicense, createTenant, createUser } from '../src/admin/admin.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { PgService } from '../src/db/pg.service.js';
import { migrateEvents } from '../src/db/events-migrations.js';
import { parseBatch } from '../src/ingest/batch.js';
import { IngestService } from '../src/ingest/ingest.service.js';
import { PrismaService } from '../src/prisma.service.js';
import { sampleEvent, unzip } from './fixtures.js';

// Painel e relatórios, contra PostgreSQL + TimescaleDB reais.
const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL não definido';
const PASSWORD = 'senha-de-teste-123';
// Período próprio, para não misturar com eventos de outros testes.
const T0 = Date.parse('2026-07-06T12:00:00Z');
const FROM = '2026-07-06T03:00:00Z'; // 06/07 00:00 em Brasília
const TO = '2026-07-09T03:00:00Z';

describe('portal: painel e relatórios', { skip }, () => {
  let app: NestExpressApplication;
  let base: string;
  let prisma: PrismaService;
  let tenantA: string;
  let tenantB: string;
  let auditorA: string;
  let mspEmail: string;

  const tokenFor = async (email: string) =>
    (
      await (
        await fetch(base + '/api/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, password: PASSWORD }),
        })
      ).json()
    ).token as string;

  const get = (path: string, token: string, params: Record<string, string> = {}) =>
    fetch(`${base}/api${path}?${new URLSearchParams({ from: FROM, to: TO, ...params })}`, { headers: { authorization: `Bearer ${token}` } });

  const json = async (path: string, token: string, params: Record<string, string> = {}) => {
    const r = await get(path, token, params);
    assert.equal(r.status, 200, await r.clone().text());
    return r.json();
  };

  async function seed(tenantId: string, hostname: string, events: Record<string, unknown>[], lastSeenAt: Date | null = null) {
    const agent = await prisma.agent.create({
      data: { tenantId, hostname, os: 'windows', machineId: randomUUID(), tokenHash: randomUUID() },
    });
    if (events.length) {
      await app.get(IngestService).ingest({ id: agent.id, tenantId }, parseBatch({ batch_id: randomUUID(), events }), 'x');
    }
    await prisma.agent.update({ where: { id: agent.id }, data: { lastSeenAt } });
    return agent.id;
  }

  // Evento do agente 0.2+, com ação lógica.
  const ev = (recordId: number, hours: number, user: string, path: string, action: string, extra: Record<string, unknown> = {}) => ({
    ...sampleEvent,
    record_id: recordId,
    time: new Date(T0 + hours * 3600_000).toISOString(),
    user: { name: user, domain: 'CORP', sid: `S-1-5-21-7-${user}` },
    path,
    action,
    actions: ['write'],
    outcome: 'success',
    ...extra,
  });
  // Evento de agente 0.1: só os direitos brutos.
  const oldEv = (recordId: number, hours: number, user: string, path: string, actions: string[]) => ({
    ...ev(recordId, hours, user, path, ''),
    action: undefined,
    actions,
  });

  before(async () => {
    app = configureApp(await NestFactory.create<NestExpressApplication>(AppModule, { logger: false }));
    await app.listen(0);
    base = (await app.getUrl()).replace('[::1]', 'localhost');
    prisma = app.get(PrismaService);
    await migrateEvents(app.get(PgService));

    const id = randomUUID().slice(0, 8);
    tenantA = (await createTenant(prisma, `Relatórios A ${id}`)).id;
    tenantB = (await createTenant(prisma, `Relatórios B ${id}`)).id;
    await createLicense(prisma, {
      tenantId: tenantA,
      plan: 'Teste',
      maxAgents: 3,
      maxVolumeBytes: 1024n * 1024n * 1024n * 1024n,
      retentionDays: 365,
      validFrom: new Date('2026-01-01T03:00:00Z'),
      validUntil: new Date('2099-01-01T03:00:00Z'),
    });
    auditorA = `auditor.${id}@relatorios-a.com`;
    mspEmail = `rel.${id}@techmaster.com.br`;
    await createUser(prisma, { email: auditorA, name: 'Auditor A', role: 'tenant_auditor', tenantId: tenantA, password: PASSWORD });
    await createUser(prisma, { email: mspEmail, name: 'Suporte', role: 'msp_admin', password: PASSWORD });

    const fin = 'D:\\Shares\\Financeiro\\';
    await seed(
      tenantA,
      'FS-A',
      [
        ev(1, 0, 'joao.silva', fin + 'orcamento.xlsx', 'created'),
        ev(2, 1, 'joao.silva', fin + 'orcamento.xlsx', 'modified'),
        ev(3, 2, 'maria.souza', fin + 'balanco.docx', 'deleted'),
        ev(4, 25, 'maria.souza', 'D:\\Shares\\RH\\folha.pdf', 'permission_changed', { count: 12 }),
        ev(5, 26, 'joao.silva', 'D:\\Shares\\RH\\folha.pdf', 'read', { outcome: 'failure' }),
        ev(6, 49, 'ana.lima', fin + 'velho.txt', 'recycled', { new_path: 'D:\\$Recycle.Bin\\S-1-5-21-1\\$RAB12CD.txt' }),
        ev(7, 49.5, 'ana.lima', fin + 'a.txt', 'renamed', { new_path: fin + 'b.txt' }),
        // Agente antigo (0.1): conta pelos direitos brutos.
        oldEv(8, 50, 'carlos.pereira', fin + 'antigo.txt', ['delete']),
      ],
      new Date(),
    );
    await seed(tenantA, 'FS-A2', [], null);
    await seed(tenantB, 'FS-B', [ev(1, 0, 'joao.silva', fin + 'segredo-de-B.xlsx', 'deleted')], new Date(Date.now() - 3 * 24 * 3600_000));
  });

  after(async () => {
    await app?.close();
  });

  it('painel do cliente: totais, gráfico por dia, ações, destaques e agentes', async () => {
    const d = await json('/dashboard', await tokenFor(auditorA));
    assert.equal(d.tenant.id, tenantA);
    assert.deepEqual(d.totals, { total: 8, failures: 1, users: 4, paths: 6, sensitive: 4 });
    assert.equal(d.period.bucket, 'day');
    assert.deepEqual(
      d.timeline.map((t: { key: string; total: number; sensitive: number }) => [t.key, t.total, t.sensitive]),
      [
        ['2026-07-06', 3, 1],
        ['2026-07-07', 2, 1],
        ['2026-07-08', 3, 2],
      ],
    );
    // Uma ação por evento: a lógica no agente 0.2+, os direitos no 0.1.
    assert.deepEqual(
      d.actions.map((a: { action: string; total: number; label: string }) => [a.action, a.label]),
      [
        ['created', 'Criação'],
        ['delete', 'Exclusão (direito)'],
        ['deleted', 'Exclusão'],
        ['modified', 'Alteração'],
        ['permission_changed', 'Alteração de permissão'],
        ['read', 'Leitura'],
        ['recycled', 'Enviado para a Lixeira'],
        ['renamed', 'Renomeação'],
      ],
    );
    assert.ok(d.actions.every((a: { total: number }) => a.total === 1));
    const users = d.top_users.map((u: { user_name: string; total: number }) => `${u.user_name}:${u.total}`);
    assert.equal(users[0], 'joao.silva:3');
    assert.deepEqual(users.slice(1).sort(), ['ana.lima:2', 'carlos.pereira:1', 'maria.souza:2']);
    assert.deepEqual(d.top_folders[0], { tenant_id: tenantA, tenant_name: d.tenant.name, server: 'FS-A', folder: 'D:\\Shares\\Financeiro', total: 6, users: 4 });
    assert.deepEqual(d.recent_sensitive.map((e: { record_id: string }) => e.record_id), ['8', '6', '4', '3']);
    assert.deepEqual(
      d.agents.map((a: { hostname: string; health: string; events: number }) => [a.hostname, a.health, a.events]),
      [
        ['FS-A', 'ok', 8],
        ['FS-A2', 'never', 0],
      ],
    );
    assert.equal(d.companies.length, 1);
    assert.deepEqual(d.companies[0].license, { ...d.companies[0].license, status: 'active', max_agents: 3, active_agents: 2 });
    assert.equal(d.companies[0].agents_attention, 1);
  });

  it('situação do agente pelo sinal de vida, quando o agente manda', async () => {
    const id = await seed(tenantA, 'FS-HB', [], new Date(Date.now() - 3 * 24 * 3600_000));
    await prisma.agent.update({ where: { id }, data: { lastHeartbeatAt: new Date(), bufferEvents: 42 } });
    const d = await json('/dashboard', await tokenFor(auditorA));
    const a = d.agents.find((x: { id: string }) => x.id === id);
    assert.equal(a.health, 'ok');
    assert.equal(a.heartbeat, true);
    assert.equal(a.buffer_events, 42);
    assert.ok(Date.now() - Date.parse(a.last_seen_at) < 60_000, 'último contato vem do sinal de vida');
    await prisma.agent.update({ where: { id }, data: { lastHeartbeatAt: new Date(Date.now() - 20 * 60_000) } });
    const late = (await json('/dashboard', await tokenFor(auditorA))).agents.find((x: { id: string }) => x.id === id);
    assert.equal(late.health, 'late');
    await prisma.agent.update({ where: { id }, data: { disabledAt: new Date() } });
  });

  it('cliente não vê o painel de outra empresa; Tech Master vê todas', async () => {
    assert.equal((await get('/dashboard', await tokenFor(auditorA), { tenant: tenantB })).status, 403);
    const msp = await tokenFor(mspEmail);
    const all = await json('/dashboard', msp);
    assert.equal(all.tenant, null);
    const ids = all.companies.map((c: { id: string }) => c.id);
    assert.ok(ids.includes(tenantA) && ids.includes(tenantB));
    const b = all.agents.find((a: { tenant_id: string }) => a.tenant_id === tenantB);
    assert.equal(b.health, 'stale');
    const onlyB = await json('/dashboard', msp, { tenant: tenantB });
    assert.equal(onlyB.totals.total, 1);
    assert.equal(onlyB.companies[0].license.status, 'none');
  });

  it('relatório por usuário com uma coluna por ação', async () => {
    const t = await json('/reports/usuarios', await tokenFor(auditorA));
    assert.equal(t.title, 'Atividade por usuário');
    assert.ok(!t.columns.some((c: { key: string }) => c.key === 'tenant_name'), 'cliente não precisa da coluna Empresa');
    assert.deepEqual(
      t.columns.filter((c: { key: string }) => c.key.startsWith('action:')).map((c: { label: string }) => c.label),
      ['Criação', 'Alteração', 'Leitura', 'Exclusão', 'Enviado para a Lixeira', 'Renomeação', 'Alteração de permissão', 'Exclusão (direito)'],
    );
    const joao = t.rows[0];
    assert.deepEqual(
      {
        user: joao.user,
        total: joao.total,
        failures: joao.failures,
        paths: joao.paths,
        created: joao['action:created'],
        modified: joao['action:modified'],
        read: joao['action:read'],
        del: joao['action:deleted'],
      },
      { user: 'CORP\\joao.silva', total: 3, failures: 1, paths: 2, created: 1, modified: 1, read: 1, del: 0 },
    );
    assert.equal(joao.first_time, '2026-07-06T12:00:00Z');
    assert.match(t.client[0].value, /^Relatórios A/);
    assert.deepEqual(
      t.client.map((f: { label: string }) => f.label),
      ['Empresa', 'Servidores', 'Período', 'Gerado por', 'Gerado em'],
    );
    assert.equal(t.truncated, false);
  });

  it('relatório por pasta e por período, com filtros', async () => {
    const token = await tokenFor(auditorA);
    const pastas = await json('/reports/pastas', token);
    assert.deepEqual(
      pastas.rows.map((r: { folder: string; total: number; users: number }) => [r.folder, r.total, r.users]),
      [
        ['D:\\Shares\\Financeiro', 6, 4],
        ['D:\\Shares\\RH', 2, 2],
      ],
    );
    const rh = await json('/reports/pastas', token, { path: 'd:\\shares\\rh' });
    assert.equal(rh.rows.length, 1);
    assert.equal(rh.client.find((f: { label: string }) => f.label === 'Filtros').value, 'caminho começa com "d:\\shares\\rh"');

    const periodo = await json('/reports/periodo', token);
    assert.deepEqual(
      periodo.rows.map((r: { period: string; total: number; users: number }) => [r.period, r.total, r.users]),
      [
        ['06/07/2026', 3, 2],
        ['07/07/2026', 2, 2],
        ['08/07/2026', 3, 2],
      ],
    );
    const porHora = await json('/reports/periodo', token, { from: '2026-07-06T12:00:00Z', to: '2026-07-06T15:00:00Z' });
    assert.deepEqual(porHora.rows.map((r: { period: string; total: number }) => [r.period, r.total]), [
      ['06/07 09h', 1],
      ['06/07 10h', 1],
      ['06/07 11h', 1],
    ]);
    const exclusoes = await json('/reports/usuarios', token, { action: 'deleted' });
    assert.deepEqual(exclusoes.rows.map((r: { user: string }) => r.user), ['CORP\\maria.souza']);
    const antigos = await json('/reports/usuarios', token, { action: 'delete' });
    assert.deepEqual(antigos.rows.map((r: { user: string }) => r.user), ['CORP\\carlos.pereira']);
  });

  it('Tech Master vê a coluna Empresa e os dados de todas', async () => {
    const t = await json('/reports/eventos', await tokenFor(mspEmail), { user: 'joao.silva' });
    assert.equal(t.columns[1].key, 'tenant_name');
    assert.ok(t.rows.some((r: { path: string }) => r.path.includes('segredo-de-B')));
    assert.deepEqual(t.client[0], { label: 'Empresa', value: 'todas' });
    assert.ok(!t.client.some((f: { label: string }) => f.label === 'Servidores'));
  });

  it('eventos detalhados trazem ação em português, novo caminho e quantidade', async () => {
    const t = await json('/reports/eventos', await tokenFor(auditorA));
    const byId = (p: string) => t.rows.find((r: { path: string }) => r.path.endsWith(p));
    assert.deepEqual(
      [byId('a.txt').actions, byId('a.txt').new_path],
      ['Renomeação', 'D:\\Shares\\Financeiro\\b.txt'],
    );
    assert.equal(byId('velho.txt').new_path, 'Lixeira do Windows');
    const perm = t.rows.find((r: { actions: string }) => r.actions === 'Alteração de permissão');
    assert.equal(perm.count, 12);
    assert.equal(byId('antigo.txt').actions, 'Exclusão (direito)');
    assert.ok(t.columns.some((c: { key: string; label: string }) => c.key === 'new_path' && c.label === 'Novo caminho'));
  });

  it('exporta Excel e PDF só com dados do próprio cliente', async () => {
    const token = await tokenFor(auditorA);
    const x = await get('/reports/eventos', token, { format: 'xlsx' });
    assert.equal(x.status, 200);
    assert.equal(x.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.match(x.headers.get('content-disposition')!, /attachment; filename="relatorio-eventos-\d{8}-\d{4}\.xlsx"/);
    const sheet = unzip(Buffer.from(await x.arrayBuffer())).get('xl/worksheets/sheet1.xml')!;
    assert.match(sheet, /orcamento\.xlsx/);
    assert.ok(!sheet.includes('segredo-de-B'));

    const p = await get('/reports/usuarios', token, { format: 'pdf' });
    assert.equal(p.status, 200);
    assert.equal(p.headers.get('content-type'), 'application/pdf');
    assert.equal(Buffer.from(await p.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');

    assert.equal((await get('/reports/eventos', token, { format: 'xlsx', tenant: tenantB })).status, 403);
    assert.equal((await get('/reports/eventos', token, { format: 'docx' })).status, 400);
    assert.equal((await get('/reports/senhas', token)).status, 400);
    assert.equal((await fetch(`${base}/api/reports/eventos`)).status, 401);
  });

  it('registra visualizações e exportações de relatórios', async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email: auditorA } });
    const logs = await prisma.portalAuditLog.findMany({ where: { userId: user.id, action: { startsWith: 'reports.' } } });
    assert.ok(logs.some((l) => l.action === 'reports.view'));
    const exports = logs.filter((l) => l.action === 'reports.export').map((l) => (l.details as { format: string }).format);
    assert.ok(exports.includes('xlsx') && exports.includes('pdf'));
    assert.ok(logs.every((l) => l.tenantId === tenantA));
  });
});
