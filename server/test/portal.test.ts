import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { createTenant, createUser, setUserPassword } from '../src/admin/admin.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { PgService } from '../src/db/pg.service.js';
import { migrateEvents } from '../src/db/events-migrations.js';
import { parseBatch } from '../src/ingest/batch.js';
import { IngestService } from '../src/ingest/ingest.service.js';
import { PrismaService } from '../src/prisma.service.js';
import { sampleEvent } from './fixtures.js';

// Portal: login e pesquisa de eventos, contra PostgreSQL + TimescaleDB reais.
const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL não definido';
const PASSWORD = 'senha-de-teste-123';
// Período próprio, para não misturar com eventos de outros testes.
const T0 = Date.parse('2026-08-10T12:00:00Z');
const FROM = '2026-08-10T00:00:00Z';
const TO = '2026-08-11T00:00:00Z';

describe('portal: login e pesquisa de eventos', { skip }, () => {
  let app: NestExpressApplication;
  let base: string;
  let prisma: PrismaService;
  let tenantA: string;
  let tenantB: string;
  let auditorA: string;
  let mspEmail: string;

  const login = (email: string, password = PASSWORD) =>
    fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

  const tokenFor = async (email: string) => (await (await login(email)).json()).token as string;

  const get = (path: string, token: string, params: Record<string, string> = {}) =>
    fetch(`${base}/api${path}?${new URLSearchParams(params)}`, { headers: { authorization: `Bearer ${token}` } });

  const search = async (token: string, params: Record<string, string> = {}) => {
    const r = await get('/events', token, { from: FROM, to: TO, ...params });
    assert.equal(r.status, 200, await r.clone().text());
    return r.json();
  };

  // Grava eventos como se viessem do agente do tenant.
  async function seed(tenantId: string, hostname: string, events: Record<string, unknown>[]) {
    const agent = await prisma.agent.create({
      data: { tenantId, hostname, os: 'windows', machineId: randomUUID(), tokenHash: randomUUID() },
    });
    const batch = parseBatch({ batch_id: randomUUID(), events });
    assert.equal(batch.rejected.length, 0);
    await app.get(IngestService).ingest({ id: agent.id, tenantId }, batch, 'x');
  }

  const ev = (recordId: number, minutes: number, user: string, path: string, actions: string[]) => ({
    ...sampleEvent,
    record_id: recordId,
    time: new Date(T0 + minutes * 60_000).toISOString(),
    user: { name: user, domain: 'CORP', sid: `S-1-5-21-9-${user}` },
    path,
    actions,
  });

  before(async () => {
    app = configureApp(await NestFactory.create<NestExpressApplication>(AppModule, { logger: false }));
    await app.listen(0);
    base = (await app.getUrl()).replace('[::1]', 'localhost');
    prisma = app.get(PrismaService);
    await migrateEvents(app.get(PgService));

    const id = randomUUID().slice(0, 8);
    tenantA = (await createTenant(prisma, `Cliente A ${id}`)).id;
    tenantB = (await createTenant(prisma, `Cliente B ${id}`)).id;
    auditorA = `Auditor.${id}@ClienteA.com`;
    mspEmail = `suporte.${id}@techmaster.com.br`;
    await createUser(prisma, { email: auditorA, name: 'Auditor A', role: 'tenant_auditor', tenantId: tenantA, password: PASSWORD });
    await createUser(prisma, { email: mspEmail, name: 'Suporte', role: 'msp_operator', password: PASSWORD });

    const fin = 'D:\\Shares\\Financeiro\\';
    await seed(tenantA, 'FS-A', [
      ev(1, 0, 'joao.silva', fin + '2026\\orcamento.xlsx', ['write']),
      ev(2, 1, 'maria.souza', fin + 'balanco_100%.docx', ['delete']),
      ev(3, 2, 'joao.silva', 'D:\\Shares\\RH\\folha.pdf', ['read']),
      // Mesmo instante: a paginação desempata por agente e record_id.
      ...[10, 11, 12, 13, 14].map((r) => ev(r, 3, 'ana.lima', fin + `lote\\${r}.txt`, ['write'])),
      // Fora do período pesquisado.
      ev(20, 60 * 30, 'joao.silva', fin + 'depois.xlsx', ['write']),
    ]);
    await seed(tenantB, 'FS-B', [ev(1, 0, 'joao.silva', fin + 'segredo-de-B.xlsx', ['write'])]);
  });

  after(async () => {
    await app?.close();
  });

  it('login recusa senha errada e e-mail inexistente da mesma forma', async () => {
    const a = await login(auditorA, 'senha-errada-000');
    const b = await login('ninguem@x.com', 'senha-errada-000');
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.deepEqual(await a.json(), await b.json());
    assert.equal((await login('', '')).status, 400);
  });

  it('login devolve token de sessão; e-mail não diferencia maiúsculas', async () => {
    const r = await login(auditorA.toUpperCase());
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.match(body.token, /^ta_ses_/);
    assert.equal(body.user.tenant_id, tenantA);
    assert.equal(body.user.role, 'tenant_auditor');
    const me = await get('/auth/me', body.token);
    assert.equal((await me.json()).email, auditorA.toLowerCase());
  });

  it('rotas do portal exigem sessão', async () => {
    assert.equal((await fetch(base + '/api/events')).status, 401);
    assert.equal((await get('/events', 'ta_ses_invalido')).status, 401);
  });

  it('cliente só vê eventos do próprio tenant', async () => {
    const token = await tokenFor(auditorA);
    const page = await search(token, { limit: '200' });
    assert.equal(page.items.length, 8);
    assert.ok(page.items.every((e: { tenant_id: string }) => e.tenant_id === tenantA));
    assert.equal((await get('/events', token, { tenant: tenantB })).status, 403);
    const tenants = await (await get('/tenants', token)).json();
    assert.deepEqual(tenants.map((t: { id: string }) => t.id), [tenantA]);
  });

  it('Tech Master vê todos os tenants ou filtra um', async () => {
    const token = await tokenFor(mspEmail);
    const all = await search(token, { user: 'joao.silva', limit: '200' });
    const tenants = new Set(all.items.map((e: { tenant_id: string }) => e.tenant_id));
    assert.ok(tenants.has(tenantA) && tenants.has(tenantB));
    const onlyB = await search(token, { tenant: tenantB });
    assert.deepEqual(onlyB.items.map((e: { path: string }) => e.path), ['D:\\Shares\\Financeiro\\segredo-de-B.xlsx']);
    const list = await (await get('/tenants', token)).json();
    assert.ok(list.some((t: { id: string }) => t.id === tenantB));
  });

  it('resumo da empresa: o cliente só vê a própria', async () => {
    const token = await tokenFor(auditorA);
    const r = await get(`/tenants/${tenantA}`, token);
    assert.equal(r.status, 200, await r.clone().text());
    const s = await r.json();
    assert.equal(s.id, tenantA);
    assert.equal(s.license.active_agents, s.agents.ok + s.agents.late + s.agents.stale);
    assert.equal((await get(`/tenants/${tenantB}`, token)).status, 403);
    const msp = await tokenFor(mspEmail);
    assert.equal((await get(`/tenants/${tenantB}`, msp)).status, 200);
    assert.equal((await get(`/tenants/${randomUUID()}`, msp)).status, 404);
  });

  it('filtra por usuário, caminho (prefixo, sem caixa), ação e período', async () => {
    const token = await tokenFor(auditorA);
    const ids = async (p: Record<string, string>) =>
      (await search(token, { limit: '200', ...p })).items.map((e: { record_id: string }) => Number(e.record_id)).sort((a: number, b: number) => a - b);

    assert.deepEqual(await ids({ user: 'JOAO' }), [1, 3]);
    assert.deepEqual(await ids({ user: 'corp\\maria' }), [2]);
    assert.deepEqual(await ids({ user: 'S-1-5-21-9-ana.lima' }), [10, 11, 12, 13, 14]);
    assert.deepEqual(await ids({ path: 'd:\\shares\\rh' }), [3]);
    assert.deepEqual(await ids({ path: 'D:\\Shares\\Financeiro\\balanco_100%' }), [2]);
    // "_" e "%" são literais, não curingas.
    assert.deepEqual(await ids({ path: 'D:\\Shares\\Financeiro\\balanco_1%%' }), []);
    assert.deepEqual(await ids({ action: 'delete' }), [2]);
    assert.deepEqual(await ids({ action: 'write', user: 'joao' }), [1]);
    assert.deepEqual(await ids({ from: new Date(T0 + 60_000).toISOString(), to: new Date(T0 + 3 * 60_000).toISOString() }), [2, 3]);
    assert.deepEqual(await ids({ from: FROM, to: '2026-08-12T00:00:00Z', user: 'joao' }), [1, 3, 20]);
  });

  it('resultado traz servidor, usuário e caminho, do mais recente para o mais antigo', async () => {
    const page = await search(await tokenFor(auditorA), { user: 'maria' });
    assert.deepEqual(page.items[0], {
      ...page.items[0],
      server: 'FS-A',
      user_domain: 'CORP',
      user_name: 'maria.souza',
      path: 'D:\\Shares\\Financeiro\\balanco_100%.docx',
      actions: ['delete'],
      success: true,
      event_id: 4663,
      time: '2026-08-10T12:01:00.000000Z',
    });
  });

  it('pagina por cursor sem repetir nem pular eventos, inclusive no mesmo instante', async () => {
    const token = await tokenFor(auditorA);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: { items: { record_id: string }[]; next_cursor: string | null } = await search(token, {
        limit: '3',
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...page.items.map((e) => e.record_id));
      cursor = page.next_cursor;
      pages++;
    } while (cursor && pages < 10);
    assert.equal(pages, 3);
    assert.deepEqual(seen, ['14', '13', '12', '11', '10', '3', '2', '1']);
    assert.equal((await get('/events', token, { cursor: 'lixo' })).status, 400);
  });

  it('exporta CSV com os mesmos filtros, só do próprio tenant', async () => {
    const token = await tokenFor(auditorA);
    const r = await get('/events/export.csv', token, { from: FROM, to: TO, path: 'D:\\Shares\\Financeiro' });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type')!, /text\/csv/);
    assert.match(r.headers.get('content-disposition')!, /attachment; filename="eventos-/);
    const body = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await r.arrayBuffer());
    assert.ok(body.startsWith('\uFEFFData/hora (Brasília);Cliente;Servidor;Usuário'));
    const lines = body.trim().split('\r\n');
    assert.equal(lines.length, 1 + 7);
    assert.match(lines[lines.length - 1], /^2026-08-10 09:00:00;Cliente A .*;FS-A;CORP\\joao\.silva;/);
    assert.ok(!body.includes('segredo-de-B'));
    assert.equal((await get('/events/export.csv', token, { tenant: tenantB })).status, 403);
  });

  it('registra consultas e exportações no log do portal', async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email: auditorA.toLowerCase() } });
    const actions = (await prisma.portalAuditLog.findMany({ where: { userId: user.id } })).map((l) => l.action);
    assert.ok(actions.includes('login'));
    assert.ok(actions.includes('events.search'));
    assert.ok(actions.includes('events.export'));
  });

  it('logout e troca de senha invalidam a sessão', async () => {
    const t1 = await tokenFor(auditorA);
    const out = await fetch(base + '/api/auth/logout', { method: 'POST', headers: { authorization: `Bearer ${t1}` } });
    assert.equal(out.status, 204);
    assert.equal((await get('/auth/me', t1)).status, 401);

    const t2 = await tokenFor(auditorA);
    await setUserPassword(prisma, auditorA, 'outra-senha-456');
    assert.equal((await get('/auth/me', t2)).status, 401);
    assert.equal((await login(auditorA, 'outra-senha-456')).status, 200);
  });

  it('usuário desativado não entra', async () => {
    await prisma.user.update({ where: { email: mspEmail }, data: { disabledAt: new Date() } });
    assert.equal((await login(mspEmail)).status, 401);
  });

  it('bloqueia após 5 senhas erradas seguidas', async () => {
    const email = `bruto.${randomUUID().slice(0, 8)}@x.com`;
    for (let i = 0; i < 5; i++) assert.equal((await login(email, 'errada-000000')).status, 401);
    assert.equal((await login(email, 'errada-000000')).status, 429);
  });

  it('trocar o X-Forwarded-For não escapa do limite por e-mail', async () => {
    const email = `rotativo.${randomUUID().slice(0, 8)}@x.com`;
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      const r = await fetch(base + '/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.9.0.${i}` },
        body: JSON.stringify({ email, password: 'errada-000000' }),
      });
      statuses.push(r.status);
    }
    assert.deepEqual(statuses.slice(0, 20), Array(20).fill(401));
    assert.equal(statuses[20], 429);
  });

  it('CLI recusa perfil sem tenant coerente', async () => {
    await assert.rejects(createUser(prisma, { email: 'a@b.c', name: 'x', role: 'tenant_admin' }), /exige --tenant/);
    await assert.rejects(
      createUser(prisma, { email: 'a@b.c', name: 'x', role: 'msp_admin', tenantId: tenantA }),
      /não leva --tenant/,
    );
    await assert.rejects(createUser(prisma, { email: 'a@b.c', name: 'x', role: 'root' }), /perfil inválido/);
    const u = await createUser(prisma, { email: `gerada.${randomUUID().slice(0, 8)}@x.com`, name: 'x', role: 'tenant_admin', tenantId: tenantA });
    assert.ok(u.password && u.password.length >= 16);
    assert.equal((await login(u.email, u.password)).status, 200);
  });
});
