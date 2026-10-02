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

  const ev = (recordId: number, hours: number, user: string, path: string, actions: string[], outcome = 'success') => ({
    ...sampleEvent,
    record_id: recordId,
    time: new Date(T0 + hours * 3600_000).toISOString(),
    user: { name: user, domain: 'CORP', sid: `S-1-5-21-7-${user}` },
    path,
    actions,
    outcome,
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
        ev(1, 0, 'joao.silva', fin + 'orcamento.xlsx', ['write']),
        ev(2, 1, 'joao.silva', fin + 'orcamento.xlsx', ['read', 'write']),
        ev(3, 2, 'maria.souza', fin + 'balanco.docx', ['delete']),
        ev(4, 25, 'maria.souza', 'D:\\Shares\\RH\\folha.pdf', ['permission_change']),
        ev(5, 26, 'joao.silva', 'D:\\Shares\\RH\\folha.pdf', ['read'], 'failure'),
        // Tipo novo enviado pelo agente: aparece sem mudar o servidor.
        ev(6, 49, 'ana.lima', fin + 'velho.txt', ['moved_to_recycle_bin']),
      ],
      new Date(),
    );
    await seed(tenantA, 'FS-A2', [], null);
    await seed(tenantB, 'FS-B', [ev(1, 0, 'joao.silva', fin + 'segredo-de-B.xlsx', ['delete'])], new Date(Date.now() - 3 * 24 * 3600_000));
  });

  after(async () => {
    await app?.close();
  });

  it('painel do cliente: totais, gráfico por dia, ações, destaques e agentes', async () => {
    const d = await json('/dashboard', await tokenFor(auditorA));
    assert.equal(d.tenant.id, tenantA);
    assert.deepEqual(d.totals, { total: 6, failures: 1, users: 3, paths: 4, sensitive: 2 });
    assert.equal(d.period.bucket, 'day');
    assert.deepEqual(
      d.timeline.map((t: { key: string; total: number; sensitive: number }) => [t.key, t.total, t.sensitive]),
      [
        ['2026-07-06', 3, 1],
        ['2026-07-07', 2, 1],
        ['2026-07-08', 1, 0],
      ],
    );
    assert.deepEqual(
      d.actions.map((a: { action: string; total: number; label: string }) => [a.action, a.total, a.label]),
      [
        ['read', 2, 'Leitura'],
        ['write', 2, 'Escrita'],
        ['delete', 1, 'Exclusão'],
        ['moved_to_recycle_bin', 1, 'moved_to_recycle_bin'],
        ['permission_change', 1, 'Alteração de permissão'],
      ],
    );
    assert.deepEqual(
      d.top_users.map((u: { user_name: string; total: number }) => [u.user_name, u.total]),
      [
        ['joao.silva', 3],
        ['maria.souza', 2],
        ['ana.lima', 1],
      ],
    );
    assert.deepEqual(d.top_folders[0], { tenant_id: tenantA, tenant_name: d.tenant.name, server: 'FS-A', folder: 'D:\\Shares\\Financeiro', total: 4, users: 3 });
    assert.deepEqual(d.recent_sensitive.map((e: { record_id: string }) => e.record_id), ['4', '3']);
    assert.deepEqual(
      d.agents.map((a: { hostname: string; health: string; events: number }) => [a.hostname, a.health, a.events]),
      [
        ['FS-A', 'ok', 6],
        ['FS-A2', 'never', 0],
      ],
    );
    assert.equal(d.companies.length, 1);
    assert.deepEqual(d.companies[0].license, { ...d.companies[0].license, status: 'active', max_agents: 3, active_agents: 2 });
    assert.equal(d.companies[0].agents_attention, 1);
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
      ['Leitura', 'Escrita', 'Exclusão', 'Alteração de permissão', 'moved_to_recycle_bin'],
    );
    const joao = t.rows[0];
    assert.deepEqual(
      { user: joao.user, total: joao.total, failures: joao.failures, paths: joao.paths, read: joao['action:read'], write: joao['action:write'], del: joao['action:delete'] },
      { user: 'CORP\\joao.silva', total: 3, failures: 1, paths: 2, read: 2, write: 2, del: 0 },
    );
    assert.equal(joao.first_time, '2026-07-06T12:00:00Z');
    assert.match(t.info[0], /^Empresa: Relatórios A/);
    assert.equal(t.truncated, false);
  });

  it('relatório por pasta e por período, com filtros', async () => {
    const token = await tokenFor(auditorA);
    const pastas = await json('/reports/pastas', token);
    assert.deepEqual(
      pastas.rows.map((r: { folder: string; total: number; users: number }) => [r.folder, r.total, r.users]),
      [
        ['D:\\Shares\\Financeiro', 4, 3],
        ['D:\\Shares\\RH', 2, 2],
      ],
    );
    const rh = await json('/reports/pastas', token, { path: 'd:\\shares\\rh' });
    assert.equal(rh.rows.length, 1);
    assert.ok(rh.info.some((l: string) => l.includes('caminho começa com "d:\\shares\\rh"')));

    const periodo = await json('/reports/periodo', token);
    assert.deepEqual(
      periodo.rows.map((r: { period: string; total: number; users: number }) => [r.period, r.total, r.users]),
      [
        ['06/07/2026', 3, 2],
        ['07/07/2026', 2, 2],
        ['08/07/2026', 1, 1],
      ],
    );
    const porHora = await json('/reports/periodo', token, { from: '2026-07-06T12:00:00Z', to: '2026-07-06T15:00:00Z' });
    assert.deepEqual(porHora.rows.map((r: { period: string; total: number }) => [r.period, r.total]), [
      ['06/07 09h', 1],
      ['06/07 10h', 1],
      ['06/07 11h', 1],
    ]);
    const exclusoes = await json('/reports/usuarios', token, { action: 'delete' });
    assert.deepEqual(exclusoes.rows.map((r: { user: string }) => r.user), ['CORP\\maria.souza']);
  });

  it('Tech Master vê a coluna Empresa e os dados de todas', async () => {
    const t = await json('/reports/eventos', await tokenFor(mspEmail), { user: 'joao.silva' });
    assert.equal(t.columns[1].key, 'tenant_name');
    assert.ok(t.rows.some((r: { path: string }) => r.path.includes('segredo-de-B')));
    assert.equal(t.info[0], 'Empresa: todas');
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
