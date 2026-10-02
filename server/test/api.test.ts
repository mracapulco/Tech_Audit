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

  it('agente desativado é recusado', async () => {
    await prisma.license.update({ where: { id: licenseId }, data: { validUntil: new Date(Date.now() + DAY) } });
    await prisma.agent.update({ where: { id: agentId }, data: { disabledAt: new Date() } });
    const r = await sendBatch({ batch_id: randomUUID(), events: events([7]) });
    assert.equal(r.status, 403);
    assert.match((await r.json()).message, /desativado/);
  });
});
