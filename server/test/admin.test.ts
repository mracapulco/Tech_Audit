import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { bootstrapAdmin, createTenant, createUser } from '../src/admin/admin.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { PrismaService } from '../src/prisma.service.js';

// Administração pelo portal: empresas, licenças, tokens, agentes e usuários.
const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL não definido';
const PASSWORD = 'senha-de-teste-123';

describe('portal: administração', { skip }, () => {
  let app: NestExpressApplication;
  let base: string;
  let prisma: PrismaService;
  let admin: string;
  let client: string;
  let clientTenant: string;
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
  const login = async (email: string, password = PASSWORD) => {
    const r = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    return { status: r.status, token: (await r.json()).token as string };
  };

  before(async () => {
    app = configureApp(await NestFactory.create<NestExpressApplication>(AppModule, { logger: false }));
    await app.listen(0);
    base = (await app.getUrl()).replace('[::1]', 'localhost');
    prisma = app.get(PrismaService);
    const adminEmail = `admin.${id}@techmaster.com.br`;
    await createUser(prisma, { email: adminEmail, name: 'Admin', role: 'msp_admin', password: PASSWORD });
    admin = (await login(adminEmail)).token;
    clientTenant = (await createTenant(prisma, `Cliente ${id}`)).id;
    await createUser(prisma, { email: `cli.${id}@cliente.com`, name: 'Cli', role: 'tenant_auditor', tenantId: clientTenant, password: PASSWORD });
    client = (await login(`cli.${id}@cliente.com`)).token;
  });

  after(async () => {
    await app?.close();
  });

  it('cliente não acessa a administração', async () => {
    for (const [m, p] of [['GET', '/admin/tenants'], ['GET', '/admin/users'], ['POST', '/admin/tenants']] as const) {
      assert.equal((await call(client, m, p, m === 'GET' ? undefined : {})).status, 403, `${m} ${p}`);
    }
    assert.equal((await fetch(base + '/api/admin/tenants')).status, 401);
  });

  it('cadastra empresa, licença, token, e mostra no resumo', async () => {
    const t = await call(admin, 'POST', '/admin/tenants', { name: `Empresa ${id}` });
    assert.equal(t.status, 201);
    const tid = t.body.id;
    assert.equal((await call(admin, 'POST', '/admin/tenants', { name: '' })).status, 400);

    const bad = await call(admin, 'POST', `/admin/tenants/${tid}/licenses`, { max_agents: 3, max_volume: 'muito', valid_until: '2027-09-30' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.message, /Volume contratado inválido/);
    const lic = await call(admin, 'POST', `/admin/tenants/${tid}/licenses`, {
      plan: 'Profissional', max_agents: '3', max_volume: '2TB', valid_from: '2026-01-01', valid_until: '2099-12-31',
    });
    assert.equal(lic.status, 201, JSON.stringify(lic.body));
    assert.equal(lic.body.status, 'active');
    assert.equal(lic.body.max_volume_bytes, String(2n * 1024n ** 4n));

    const tok = await call(admin, 'POST', `/admin/tenants/${tid}/tokens`, { max_uses: 2, ttl_hours: 48, description: 'IDATA' });
    assert.equal(tok.status, 201);
    assert.match(tok.body.token, /^ta_enr_/);

    // O token gerado no portal registra o agente.
    const enr = await fetch(base + '/v1/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enrollment_token: tok.body.token, hostname: 'IDATA', machine_id: `m-${id}`, os: 'windows' }),
    });
    assert.equal(enr.status, 201);

    const d = await call(admin, 'GET', `/admin/tenants/${tid}`);
    assert.equal(d.status, 200);
    assert.equal(d.body.license.status, 'active');
    assert.equal(d.body.license.active_agents, 1);
    assert.equal(d.body.agents[0].hostname, 'IDATA');
    assert.equal(d.body.tokens[0].uses, 1);
    assert.equal(d.body.tokens[0].usable, true);
    assert.ok(!('token_hash' in d.body.tokens[0]) && !('tokenHash' in d.body.tokens[0]));

    const list = await call(admin, 'GET', '/admin/tenants');
    const row = list.body.find((r: { id: string }) => r.id === tid);
    assert.deepEqual([row.license_status, row.active_agents, row.max_agents], ['active', 1, 3]);

    // Desativar o agente libera a vaga; revogar token e licença.
    assert.equal((await call(admin, 'POST', `/admin/agents/${d.body.agents[0].id}/disable`)).status, 200);
    assert.equal((await call(admin, 'POST', `/admin/tokens/${d.body.tokens[0].id}/revoke`)).status, 200);
    assert.equal((await call(admin, 'POST', `/admin/licenses/${lic.body.id}/revoke`)).status, 200);
    const d2 = await call(admin, 'GET', `/admin/tenants/${tid}`);
    assert.equal(d2.body.license.active_agents, 0);
    assert.equal(d2.body.tokens[0].usable, false);
    assert.equal(d2.body.licenses[0].status, 'revoked');
    assert.equal(d2.body.license.status, 'none');

    assert.equal((await call(admin, 'PATCH', `/admin/tenants/${tid}`, { name: `Renomeada ${id}` })).body.name, `Renomeada ${id}`);
    assert.equal((await call(admin, 'GET', `/admin/tenants/${randomUUID()}`)).status, 404);
  });

  it('gerencia usuários: cria, gera senha, desativa e reativa', async () => {
    const email = `novo.${id}@cliente.com`;
    const c = await call(admin, 'POST', '/admin/users', { email, name: 'Novo', role: 'tenant_auditor', tenant_id: clientTenant });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.ok(c.body.password.length >= 16, 'senha gerada aparece uma vez');
    assert.equal((await login(email, c.body.password)).status, 200);

    assert.equal((await call(admin, 'POST', '/admin/users', { email, name: 'Dup', role: 'tenant_auditor', tenant_id: clientTenant })).status, 400);
    const noTenant = await call(admin, 'POST', '/admin/users', { email: 'x@y.com', name: 'X', role: 'tenant_auditor' });
    assert.equal(noTenant.status, 400);
    assert.equal(noTenant.body.message, 'escolha a empresa do usuário cliente');
    assert.equal((await call(admin, 'POST', '/admin/users', { email: 'x@y.com', name: 'X', role: 'tenant_auditor', tenant_id: randomUUID() })).status, 404);
    assert.equal((await call(admin, 'POST', '/admin/users', { email: 'sem-arroba', name: 'X', role: 'msp_admin' })).status, 400);
    assert.equal((await call(admin, 'POST', '/admin/users', { email: `curta.${id}@x.com`, name: 'X', role: 'msp_admin', password: '123' })).status, 400);

    const session = (await login(email, c.body.password)).token;
    assert.equal((await call(admin, 'PATCH', `/admin/users/${c.body.id}`, { disabled: true })).status, 200);
    assert.equal((await call(session, 'GET', '/auth/me')).status, 401, 'desativar encerra a sessão');
    assert.equal((await login(email, c.body.password)).status, 401);
    await call(admin, 'PATCH', `/admin/users/${c.body.id}`, { disabled: false });

    const reset = await call(admin, 'POST', `/admin/users/${c.body.id}/password`, {});
    assert.equal(reset.status, 200);
    assert.equal((await login(email, c.body.password)).status, 401);
    assert.equal((await login(email, reset.body.password)).status, 200);

    const list = await call(admin, 'GET', `/admin/users?tenant=${clientTenant}`);
    assert.deepEqual(list.body.map((u: { email: string }) => u.email).sort(), [`cli.${id}@cliente.com`, email].sort());
    assert.equal(list.body[0].tenant_name, `Cliente ${id}`);
  });

  it('administrador não desativa nem exclui a si mesmo', async () => {
    const me = await call(admin, 'GET', '/auth/me');
    assert.equal((await call(admin, 'PATCH', `/admin/users/${me.body.id}`, { disabled: true })).status, 400);
    assert.equal((await call(admin, 'DELETE', `/admin/users/${me.body.id}`)).status, 400);
  });

  it('exclui usuário e encerra as sessões; o e-mail fica livre de novo', async () => {
    const email = `excluir.${id}@cliente.com`;
    const c = await call(admin, 'POST', '/admin/users', { email, name: 'Excluir', role: 'tenant_auditor', tenant_id: clientTenant });
    const session = (await login(email, c.body.password)).token;
    assert.equal((await call(client, 'DELETE', `/admin/users/${c.body.id}`)).status, 403);
    assert.equal((await call(admin, 'DELETE', `/admin/users/${c.body.id}`)).status, 204);
    assert.equal((await call(session, 'GET', '/auth/me')).status, 401);
    assert.equal((await login(email, c.body.password)).status, 401);
    assert.equal((await call(admin, 'DELETE', `/admin/users/${c.body.id}`)).status, 404);
    const again = await call(admin, 'POST', '/admin/users', { email, name: 'De novo', role: 'tenant_auditor', tenant_id: clientTenant });
    assert.equal(again.status, 201);
    const log = await prisma.portalAuditLog.findFirst({ where: { action: 'admin.user.delete', details: { path: ['user'], equals: c.body.id } } });
    assert.ok(log, 'exclusão registrada no log do portal');
  });

  it('bootstrap só cria administrador quando não há nenhum', async () => {
    const r = await bootstrapAdmin(prisma, `boot.${id}@x.com`, PASSWORD);
    assert.equal(r.created, false);
  });
});
