import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { createLicense, createTenant, createUser } from '../src/admin/admin.js';
import { dayWindows, parsePurgeRequest, retentionCutoff } from '../src/admin/purge.js';
import { PurgeService } from '../src/admin/purge.service.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { PgService } from '../src/db/pg.service.js';
import { PrismaService } from '../src/prisma.service.js';

describe('limpeza: regras', () => {
  it('período manual em dias de Brasília, data final obrigatória', () => {
    const r = parsePurgeRequest({ tenant_id: randomUUID(), from: '2025-03-01', to: '2025-03-02' });
    assert.equal(r.from!.toISOString(), '2025-03-01T03:00:00.000Z');
    assert.equal(r.to!.toISOString(), '2025-03-03T03:00:00.000Z');
    assert.throws(() => parsePurgeRequest({ tenant_id: randomUUID(), from: '2025-03-01' }), /data final/);
    assert.throws(() => parsePurgeRequest({ tenant_id: randomUUID(), from: '2025-03-05', to: '2025-03-01' }), /antes da final/);
    assert.throws(() => parsePurgeRequest({ to: '2025-03-01' }), /empresa/);
    assert.throws(() => parsePurgeRequest({ tenant_id: randomUUID(), to: '01/03/2025' }), /AAAA-MM-DD/);
  });

  it('retenção mantém os últimos N dias inteiros', () => {
    // 04/10 às 01:00 UTC ainda é 03/10 em Brasília.
    assert.equal(retentionCutoff(90, new Date('2026-10-04T01:00:00Z')).toISOString(), '2026-07-05T03:00:00.000Z');
    assert.equal(retentionCutoff(1, new Date('2026-10-04T15:00:00Z')).toISOString(), '2026-10-03T03:00:00.000Z');
  });

  it('divide o período em janelas de um dia', () => {
    const w = dayWindows(
      { from: new Date('2025-03-01T03:00:00Z'), to: new Date('2025-03-03T03:00:00Z') },
      new Date('2025-03-01T10:00:00Z'),
      new Date('2025-03-02T20:00:00Z'),
    );
    assert.deepEqual(
      w.map((x) => [x.from!.toISOString(), x.to.toISOString()]),
      [
        ['2025-03-01T10:00:00.000Z', '2025-03-02T00:00:00.000Z'],
        ['2025-03-02T00:00:00.000Z', '2025-03-02T20:00:00.001Z'],
      ],
    );
  });
});

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL não definido';
const PASSWORD = 'senha-de-teste-123';

describe('limpeza de eventos no portal', { skip }, () => {
  let app: NestExpressApplication;
  let base: string;
  let prisma: PrismaService;
  let pg: PgService;
  let admin: string;
  let client: string;
  let tenantA: string;
  let tenantB: string;
  let agentA1: string;
  let agentA2: string;
  let agentB: string;
  const id = randomUUID().slice(0, 8);

  const call = async (token: string, method: string, path: string, body?: unknown) => {
    const r = await fetch(`${base}/api${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  };
  const login = async (email: string) => {
    const r = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    return (await r.json()).token as string;
  };
  const agent = async (tenantId: string, hostname: string) =>
    (await prisma.agent.create({ data: { tenantId, hostname, os: 'windows', machineId: randomUUID(), tokenHash: randomUUID() } })).id;

  let rec = 0;
  const insert = async (tenantId: string, agentId: string, times: string[]) => {
    for (const t of times) {
      await pg.query(
        `INSERT INTO events.file_events (time, tenant_id, agent_id, batch_id, source_record_id, source_event_id, kind, actions, success)
         VALUES ($1, $2, $3, $4, $5, 4663, 'object_access', '{read}', true)`,
        [t, tenantId, agentId, randomUUID(), ++rec],
      );
    }
  };
  const count = async (tenantId: string, agentId?: string) => {
    const { rows } = await pg.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM events.file_events WHERE tenant_id = $1 AND ($2::uuid IS NULL OR agent_id = $2)`,
      [tenantId, agentId ?? null],
    );
    return Number(rows[0].n);
  };
  const finish = () => Promise.all(app.get(PurgeService).running.values());

  before(async () => {
    app = configureApp(await NestFactory.create<NestExpressApplication>(AppModule, { logger: false }));
    await app.listen(0);
    base = (await app.getUrl()).replace('[::1]', 'localhost');
    prisma = app.get(PrismaService);
    pg = app.get(PgService);
    await createUser(prisma, { email: `adm.purge.${id}@techmaster.com.br`, name: 'Admin Limpeza', role: 'msp_admin', password: PASSWORD });
    admin = await login(`adm.purge.${id}@techmaster.com.br`);
    tenantA = (await createTenant(prisma, `Limpeza A ${id}`)).id;
    tenantB = (await createTenant(prisma, `Limpeza B ${id}`)).id;
    await createUser(prisma, { email: `cli.purge.${id}@cliente.com`, name: 'Cli', role: 'tenant_admin', tenantId: tenantA, password: PASSWORD });
    client = await login(`cli.purge.${id}@cliente.com`);
    await createLicense(prisma, {
      tenantId: tenantA,
      maxAgents: 5,
      maxVolumeBytes: 1n << 40n,
      retentionDays: 90,
      validFrom: new Date(Date.now() - 86400_000),
      validUntil: new Date(Date.now() + 30 * 86400_000),
    });
    agentA1 = await agent(tenantA, 'FS-A1');
    agentA2 = await agent(tenantA, 'FS-A2');
    agentB = await agent(tenantB, 'FS-B');
    await insert(tenantA, agentA1, ['2025-03-01T10:00:00Z', '2025-03-02T10:00:00Z', '2025-03-03T10:00:00Z', '2025-03-05T10:00:00Z']);
    await insert(tenantA, agentA2, ['2025-03-02T11:00:00Z', '2025-03-02T12:00:00Z']);
    await insert(tenantB, agentB, ['2025-03-02T10:00:00Z']);
    // Eventos antigos ficam comprimidos (política de 7 dias); a limpeza precisa funcionar neles.
    await pg.query(
      `SELECT compress_chunk(c, if_not_compressed => true) FROM show_chunks('events.file_events', older_than => '2025-03-10'::timestamptz, newer_than => '2025-02-25'::timestamptz) c`,
    );
  });

  after(async () => {
    await app?.close();
  });

  it('cliente não acessa a limpeza', async () => {
    assert.equal((await call(client, 'GET', '/admin/purges/options')).status, 403);
    assert.equal((await call(client, 'POST', '/admin/purges', { tenant_id: tenantA, to: '2025-03-02' })).status, 403);
  });

  it('prévia conta sem apagar e respeita empresa, servidor e período', async () => {
    const q = (p: Record<string, string>) => call(admin, 'GET', `/admin/purges/preview?${new URLSearchParams(p)}`);
    let r = await q({ tenant_id: tenantA, from: '2025-03-02', to: '2025-03-02' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.count, '3');
    assert.equal(r.body.tenant.name, `Limpeza A ${id}`);
    r = await q({ tenant_id: tenantA, agent_id: agentA2, from: '2025-03-02', to: '2025-03-02' });
    assert.equal(r.body.count, '2');
    r = await q({ tenant_id: tenantA, agent_id: agentB, to: '2025-03-02' });
    assert.equal(r.status, 400);
    assert.equal(await count(tenantA), 6);
  });

  it('apaga só o pedido e registra quem fez', async () => {
    const r = await call(admin, 'POST', '/admin/purges', { tenant_id: tenantA, agent_id: agentA1, from: '2025-03-02', to: '2025-03-03' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.expected_count, '2');
    await finish();
    assert.equal(await count(tenantA, agentA1), 2);
    assert.equal(await count(tenantA, agentA2), 2);
    assert.equal(await count(tenantB), 1);

    const list = await call(admin, 'GET', `/admin/purges?tenant_id=${tenantA}`);
    assert.equal(list.body[0].status, 'done');
    assert.equal(list.body[0].deleted_count, '2');
    assert.equal(list.body[0].hostname, 'FS-A1');
    assert.equal(list.body[0].user_name, 'Admin Limpeza');
    const log = await prisma.portalAuditLog.findFirst({ where: { tenantId: tenantA, action: 'admin.events.purge' } });
    assert.equal((log?.details as { expected: string }).expected, '2');
  });

  it('pela retenção apaga o que passou do prazo da licença', async () => {
    const p = await call(admin, 'GET', `/admin/purges/preview?tenant_id=${tenantA}&mode=retention`);
    assert.equal(p.body.retention_days, 90);
    assert.equal(p.body.count, '4');
    const r = await call(admin, 'POST', '/admin/purges', { tenant_id: tenantA, mode: 'retention' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await finish();
    assert.equal(await count(tenantA), 0);
    assert.equal(await count(tenantB), 1);
    // Sem licença vigente não há retenção para aplicar.
    assert.equal((await call(admin, 'POST', '/admin/purges', { tenant_id: tenantB, mode: 'retention' })).status, 400);
  });

  it('não começa limpeza vazia', async () => {
    const r = await call(admin, 'POST', '/admin/purges', { tenant_id: tenantA, to: '2025-03-31' });
    assert.equal(r.status, 400);
  });
});
