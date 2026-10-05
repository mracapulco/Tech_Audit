import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';
import { createEnrollmentToken, createLicense, createTenant } from '../src/admin/admin.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { PgService } from '../src/db/pg.service.js';
import { migrateEvents } from '../src/db/events-migrations.js';
import { PrismaService } from '../src/prisma.service.js';
import { sampleEvent } from './fixtures.js';

// Teste de ponta a ponta contra PostgreSQL + TimescaleDB reais. Requer
// DATABASE_URL com as migrations do Prisma aplicadas (npm run db:migrate).
const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL não definido';
const DAY = 24 * 3600_000;

describe('API dos agentes', { skip }, () => {
  let app: NestExpressApplication;
  let base: string;
  let prisma: PrismaService;
  let pg: PgService;
  let tenantId: string;
  let licenseId: string;
  let enrollToken: string;
  let agentId: string;
  let agentToken: string;

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  // Envia como o agente: JSON gzip com Bearer.
  const sendBatch = (batch: unknown, token = agentToken) =>
    fetch(base + '/v1/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', authorization: `Bearer ${token}` },
      body: gzipSync(JSON.stringify(batch)),
    });

  const enroll = (machineId: string, token = enrollToken) =>
    post('/v1/enroll', { enrollment_token: token, hostname: 'FS01', machine_id: machineId, os: 'windows', agent_version: '0.1.0' });

  const events = (recordIds: number[], path = sampleEvent.path) =>
    recordIds.map((r) => ({ ...sampleEvent, record_id: r, path, client_ip: '10.0.0.5' }));

  before(async () => {
    app = configureApp(await NestFactory.create<NestExpressApplication>(AppModule, { logger: false }));
    await app.listen(0);
    base = await app.getUrl();
    base = base.replace('[::1]', 'localhost');
    prisma = app.get(PrismaService);
    pg = app.get(PgService);
    await migrateEvents(pg);

    tenantId = (await createTenant(prisma, `Teste ${randomUUID()}`)).id;
    licenseId = (
      await createLicense(prisma, {
        tenantId,
        maxAgents: 1,
        maxVolumeBytes: 1024n ** 4n,
        validFrom: new Date(Date.now() - DAY),
        validUntil: new Date(Date.now() + 30 * DAY),
      })
    ).id;
    enrollToken = (await createEnrollmentToken(prisma, { tenantId, maxUses: 3 })).token;
  });

  after(async () => {
    await app?.close();
  });

  it('health continua em /api e as rotas do agente em /v1', async () => {
    const r = await fetch(base + '/api/health');
    assert.equal(r.status, 200);
    assert.equal((await r.json()).database, 'up');
    assert.equal((await post('/api/v1/enroll', {})).status, 404);
  });

  it('recusa token de registro inválido', async () => {
    const r = await enroll('m-1', 'ta_enr_invalido');
    assert.equal(r.status, 401);
    assert.equal((await post('/v1/enroll', { hostname: 'x' })).status, 400);
  });

  it('registra o agente e ocupa uma vaga', async () => {
    const r = await enroll('m-1');
    assert.equal(r.status, 201);
    const body = await r.json();
    assert.equal(body.tenant_id, tenantId);
    assert.equal(body.license.status, 'active');
    assert.match(body.agent_token, /^ta_agt_/);
    agentId = body.agent_id;
    agentToken = body.agent_token;
  });

  it('reinstalação na mesma máquina reaproveita a vaga e troca o token', async () => {
    const r = await enroll('m-1');
    assert.equal(r.status, 201);
    const body = await r.json();
    assert.equal(body.agent_id, agentId);
    assert.equal((await sendBatch({ batch_id: randomUUID(), events: [] })).status, 401, 'token antigo deixa de valer');
    agentToken = body.agent_token;
  });

  it('recusa outra máquina quando as vagas acabaram', async () => {
    const r = await enroll('m-2');
    assert.equal(r.status, 403);
    assert.match((await r.json()).message, /limite de 1 servidor/);
  });

  it('recusa lote sem token', async () => {
    const r = await post('/v1/events', { batch_id: randomUUID(), events: [] });
    assert.equal(r.status, 401);
  });

  it('grava o lote gzip e confirma', async () => {
    const batchId = randomUUID();
    const r = await sendBatch({ batch_id: batchId, hostname: 'FS01', agent_version: '0.1.1', events: events([1, 2]) });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), {
      batch_id: batchId,
      duplicate_batch: false,
      received: 2,
      inserted: 2,
      duplicates: 0,
      rejected: 0,
      filtered: 0,
    });
    const { rows } = await pg.query(
      `SELECT e.source_record_id, e.actions, e.success, e.access_mask, host(e.source_ip) AS ip, p.path, i.name, i.domain
       FROM events.file_events e
       JOIN paths p ON p.id = e.path_id
       JOIN identities i ON i.id = e.identity_id
       WHERE e.agent_id = $1 ORDER BY e.source_record_id`,
      [agentId],
    );
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], {
      source_record_id: '1',
      actions: ['write'],
      success: true,
      access_mask: 2,
      ip: '10.0.0.5',
      path: sampleEvent.path,
      name: 'joao.silva',
      domain: 'CORP',
    });
    const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
    assert.equal(agent.agentVersion, '0.1.1');
    assert.ok(agent.lastSeenAt);
  });

  it('reenvio do mesmo lote é confirmado sem duplicar', async () => {
    const batchId = randomUUID();
    const batch = { batch_id: batchId, events: events([3]) };
    assert.equal((await sendBatch(batch)).status, 200);
    const r = await sendBatch(batch);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.duplicate_batch, true);
    assert.equal(body.inserted, 0);
  });

  it('eventos repetidos em outro lote são ignorados; caminho e usuário reaproveitados', async () => {
    const r = await sendBatch({
      batch_id: randomUUID(),
      events: [...events([1, 2, 3]), ...events([4], sampleEvent.path.toUpperCase()), { record_id: -1 }],
    });
    const body = await r.json();
    assert.deepEqual([body.received, body.inserted, body.duplicates, body.rejected], [4, 1, 3, 1]);
    const { rows } = await pg.query(
      `SELECT count(*)::int AS events, count(DISTINCT path_id)::int AS paths, count(DISTINCT identity_id)::int AS ids
       FROM events.file_events WHERE agent_id = $1`,
      [agentId],
    );
    assert.deepEqual(rows[0], { events: 4, paths: 1, ids: 1 });
  });

  it('grava a ação lógica do agente 0.2: destino, contagem e detalhes', async () => {
    const r = await sendBatch({
      batch_id: randomUUID(),
      events: [
        {
          ...sampleEvent,
          record_id: 50,
          actions: ['delete'],
          action: 'renamed',
          new_path: 'D:\\Shares\\Financeiro\\novo.xlsx',
          item_type: 'file',
          related_records: [51],
          details: { destination_folder: 'D:\\Shares\\Financeiro', '<script>': 'x' },
        },
        { ...sampleEvent, record_id: 52, action: 'modified', count: 3, end_time: '2026-10-01T14:04:00Z' },
      ],
    });
    assert.equal((await r.json()).inserted, 2);
    const { rows } = await pg.query(
      `SELECT e.source_record_id::int AS rid, e.action, np.path AS new_path, e.item_type, e.event_count,
              e.end_time IS NOT NULL AS has_end, e.details
       FROM events.file_events e LEFT JOIN paths np ON np.id = e.new_path_id
       WHERE e.agent_id = $1 AND e.source_record_id IN (50, 52) ORDER BY 1`,
      [agentId],
    );
    assert.deepEqual(rows[0], {
      rid: 50,
      action: 'renamed',
      new_path: 'D:\\Shares\\Financeiro\\novo.xlsx',
      item_type: 'file',
      event_count: null,
      has_end: false,
      details: {
        destination_folder: 'D:\\Shares\\Financeiro',
        related_records: ['51'],
        handle_id: '0x1a2c',
        logon_id: '0x3e7a1f',
        computer: 'FS01.corp.local',
      },
    });
    assert.deepEqual([rows[1].action, rows[1].event_count, rows[1].has_end], ['modified', 3, true]);
  });

  it('descarta leituras de caminhos com a auditoria de leitura desligada', async () => {
    const paths = [
      { path: 'D:\\Shares', recursive: true, auditRead: true },
      { path: 'D:\\Shares\\Financeiro', recursive: true, auditRead: false },
    ];
    for (const p of paths) {
      await prisma.auditedPath.create({ data: { ...p, tenantId, agentId, pathKey: p.path.toLowerCase(), status: 'applied' } });
    }
    const read = (rid: number, path: string) => ({ ...sampleEvent, record_id: rid, path, actions: ['read'], access_mask: '0x1', action: 'read' });
    const r = await sendBatch({
      batch_id: randomUUID(),
      events: [
        read(60, 'D:\\Shares\\Financeiro\\balanco.xlsx'),
        read(61, 'D:\\Shares\\RH\\ferias.xlsx'),
        read(62, 'E:\\Outro\\a.txt'),
        { ...sampleEvent, record_id: 63, action: 'modified' },
      ],
    });
    const body = await r.json();
    assert.deepEqual([body.received, body.inserted, body.filtered], [4, 2, 2]);
    const { rows } = await pg.query(
      `SELECT source_record_id::int AS rid FROM events.file_events WHERE agent_id = $1 AND source_record_id BETWEEN 60 AND 63 ORDER BY 1`,
      [agentId],
    );
    assert.deepEqual(rows.map((x) => x.rid), [61, 63]);
    await prisma.auditedPath.deleteMany({ where: { agentId } });
  });

  it('recusa lote malformado', async () => {
    const r = await sendBatch({ batch_id: 'nao-e-uuid', events: [] });
    assert.equal(r.status, 400);
  });

  it('na tolerância aceita eventos mas não novos registros', async () => {
    await prisma.license.update({ where: { id: licenseId }, data: { validUntil: new Date(Date.now() - 3600_000) } });
    assert.equal((await sendBatch({ batch_id: randomUUID(), events: events([5]) })).status, 200);
    const r = await enroll('m-1');
    assert.equal(r.status, 403);
    assert.match((await r.json()).message, /licença vencida/);
  });

  it('depois da tolerância recusa os eventos', async () => {
    await prisma.license.update({ where: { id: licenseId }, data: { validUntil: new Date(Date.now() - 2 * DAY) } });
    const r = await sendBatch({ batch_id: randomUUID(), events: events([6]) });
    assert.equal(r.status, 403);
    assert.match((await r.json()).message, /licença vencida/);
  });

  it('heartbeat registra o sinal de vida e o buffer, mesmo com a licença vencida', async () => {
    const hb = (body: unknown, token = agentToken) => post('/v1/heartbeat', body, { authorization: `Bearer ${token}` });
    assert.equal((await hb({}, 'errado')).status, 401);
    const r = await hb({ hostname: 'FS01', agent_version: '0.2.0', buffer_events: 42, buffer_bytes: 12345, lixo: true });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).ok, true);
    const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
    assert.ok(agent.lastHeartbeatAt && Date.now() - agent.lastHeartbeatAt.getTime() < 60_000);
    assert.deepEqual([agent.agentVersion, agent.bufferEvents, agent.bufferBytes], ['0.2.0', 42, 12345n]);
    // Campos inválidos são ignorados, sem recusar o heartbeat.
    assert.equal((await hb({ buffer_events: -1, agent_version: 7 })).status, 200);
    const again = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
    assert.deepEqual([again.agentVersion, again.bufferEvents], ['0.2.0', null]);
  });

  it('agente desativado é recusado', async () => {
    await prisma.license.update({ where: { id: licenseId }, data: { validUntil: new Date(Date.now() + DAY) } });
    await prisma.agent.update({ where: { id: agentId }, data: { disabledAt: new Date() } });
    const r = await sendBatch({ batch_id: randomUUID(), events: events([7]) });
    assert.equal(r.status, 403);
    assert.match((await r.json()).message, /desativado/);
    const hb = await post('/v1/heartbeat', {}, { authorization: `Bearer ${agentToken}` });
    assert.equal(hb.status, 403);
  });
});
