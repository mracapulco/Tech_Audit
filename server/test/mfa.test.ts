import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { createTenant, createUser } from '../src/admin/admin.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { codeAt, stepAt } from '../src/auth/totp.js';
import { PrismaService } from '../src/prisma.service.js';

// Verificação em duas etapas (Google Authenticator), contra o banco real.
const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL não definido';
const PASSWORD = 'senha-de-teste-123';

describe('verificação em duas etapas', { skip }, () => {
  let app: NestExpressApplication;
  let base: string;
  let prisma: PrismaService;
  let mspEmail: string;
  let adminEmail: string;
  let clientEmail: string;
  let mspSecret: string;
  const previous = process.env.MFA_REQUIRED_ROLES;

  const post = (path: string, body: unknown, token?: string) =>
    fetch(base + '/api' + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  const login = (email: string, password = PASSWORD) => post('/auth/login', { email, password });
  // Código de agora, ou de um passo ao lado (o mesmo código não vale duas vezes).
  const code = (secret: string, offset = 0) => codeAt(secret, stepAt(Date.now()) + offset);

  // Login completo de quem já tem o autenticador.
  async function loginWithCode(email: string, secret: string, offset: number) {
    const first = await (await login(email)).json();
    assert.equal(first.mfa, 'verify');
    const r = await post('/auth/login/mfa', { challenge: first.challenge, code: code(secret, offset) });
    assert.equal(r.status, 200, await r.clone().text());
    return (await r.json()).token as string;
  }

  before(async () => {
    delete process.env.MFA_REQUIRED_ROLES; // padrão: equipe Tech Master
    app = configureApp(await NestFactory.create<NestExpressApplication>(AppModule, { logger: false }));
    await app.listen(0);
    base = (await app.getUrl()).replace('[::1]', 'localhost');
    prisma = app.get(PrismaService);
    const id = randomUUID().slice(0, 8);
    const tenant = (await createTenant(prisma, `Cliente MFA ${id}`)).id;
    mspEmail = `operador.${id}@techmaster.inf.br`;
    adminEmail = `admin.${id}@techmaster.inf.br`;
    clientEmail = `cliente.${id}@cliente.com`;
    await createUser(prisma, { email: mspEmail, name: 'Operador', role: 'msp_operator', password: PASSWORD });
    await createUser(prisma, { email: adminEmail, name: 'Admin', role: 'msp_admin', password: PASSWORD });
    await createUser(prisma, { email: clientEmail, name: 'Cliente', role: 'tenant_admin', tenantId: tenant, password: PASSWORD });
  });

  after(async () => {
    if (previous === undefined) delete process.env.MFA_REQUIRED_ROLES;
    else process.env.MFA_REQUIRED_ROLES = previous;
    await app?.close();
  });

  it('equipe Tech Master sem autenticador: o login pede o cadastro, sem sessão', async () => {
    const r = await login(mspEmail);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.mfa, 'setup');
    assert.equal(body.token, undefined);
    assert.match(body.challenge, /^ta_mfa_/);
    assert.match(body.otpauth_url, /^otpauth:\/\/totp\/Tech%20Audit%3A/);
    mspSecret = body.secret;

    const wrong = await post('/auth/login/mfa', { challenge: body.challenge, code: '000000' });
    assert.equal(wrong.status, 401);
    assert.equal((await wrong.json()).message, 'código incorreto');

    const ok = await post('/auth/login/mfa', { challenge: body.challenge, code: code(mspSecret) });
    assert.equal(ok.status, 200);
    const s = await ok.json();
    assert.match(s.token, /^ta_ses_/);
    assert.equal(s.user.role, 'msp_operator');
    // O desafio só vale uma vez.
    assert.equal((await post('/auth/login/mfa', { challenge: body.challenge, code: code(mspSecret, 1) })).status, 401);
    const status = await (await fetch(base + '/api/auth/mfa', { headers: { authorization: `Bearer ${s.token}` } })).json();
    assert.equal(status.enabled, true);
    assert.equal(status.required, true);
  });

  it('depois do cadastro, o login pede o código e não aceita o mesmo código de novo', async () => {
    const first = await (await login(mspEmail)).json();
    assert.equal(first.mfa, 'verify');
    assert.equal(first.secret, undefined);
    // Código já usado no cadastro.
    const used = (await prisma.user.findUniqueOrThrow({ where: { email: mspEmail } })).totpLastStep!;
    assert.equal((await post('/auth/login/mfa', { challenge: first.challenge, code: codeAt(mspSecret, Number(used)) })).status, 401);
    await loginWithCode(mspEmail, mspSecret, 1);
  });

  it('desafio morre depois de 5 códigos errados', async () => {
    const first = await (await login(mspEmail)).json();
    for (let i = 0; i < 5; i++) assert.equal((await post('/auth/login/mfa', { challenge: first.challenge, code: '000000' })).status, 401);
    const r = await post('/auth/login/mfa', { challenge: first.challenge, code: code(mspSecret, -1) });
    assert.equal(r.status, 401);
    assert.match((await r.json()).message, /entre de novo/);
  });

  it('bloqueia o usuário depois de 10 códigos errados, mesmo abrindo logins novos', async () => {
    await prisma.loginChallenge.deleteMany({ where: { user: { email: mspEmail } } });
    for (let round = 0; round < 2; round++) {
      const c = await (await login(mspEmail)).json();
      for (let i = 0; i < 5; i++) assert.equal((await post('/auth/login/mfa', { challenge: c.challenge, code: '000000' })).status, 401);
    }
    const next = await (await login(mspEmail)).json();
    const r = await post('/auth/login/mfa', { challenge: next.challenge, code: code(mspSecret, 1) });
    assert.equal(r.status, 429);
    // Libera para os testes seguintes.
    await prisma.loginChallenge.deleteMany({ where: { user: { email: mspEmail } } });
  });

  it('senha errada nunca chega à etapa do código', async () => {
    const r = await login(mspEmail, 'senha-errada-000');
    assert.equal(r.status, 401);
    assert.equal((await r.json()).challenge, undefined);
  });

  it('cliente entra só com a senha e pode ativar e desativar em Minha conta', async () => {
    const r = await (await login(clientEmail)).json();
    assert.match(r.token, /^ta_ses_/);
    const setup = await (await post('/auth/mfa/setup', {}, r.token)).json();
    assert.match(setup.otpauth_url, /secret=/);
    assert.equal((await post('/auth/mfa/enable', { code: '000000' }, r.token)).status, 400);
    assert.equal((await post('/auth/mfa/enable', { code: code(setup.secret) }, r.token)).status, 200);

    // Agora o login dele também pede o código.
    const token = await loginWithCode(clientEmail, setup.secret, 1);
    assert.equal((await post('/auth/mfa/disable', { password: 'errada-123456' }, token)).status, 400);
    assert.equal((await post('/auth/mfa/disable', { password: PASSWORD }, token)).status, 200);
    assert.match((await (await login(clientEmail)).json()).token, /^ta_ses_/);
  });

  it('Minha conta: troca o próprio nome e a senha (pede a atual, derruba as outras sessões)', async () => {
    const other = (await (await login(clientEmail)).json()).token as string;
    const token = (await (await login(clientEmail)).json()).token as string;
    const patch = (body: unknown) =>
      fetch(base + '/api/auth/me', { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    assert.equal((await patch({ name: '  ' })).status, 400);
    assert.equal((await (await patch({ name: 'Cliente Renomeado' })).json()).name, 'Cliente Renomeado');

    assert.equal((await post('/auth/password', { current: 'errada-123456', password: 'nova-senha-12345' }, token)).status, 400);
    assert.equal((await post('/auth/password', { current: PASSWORD, password: 'curta' }, token)).status, 400);
    assert.equal((await post('/auth/password', { current: PASSWORD, password: 'nova-senha-12345' }, token)).status, 200);
    const me = (t: string) => fetch(base + '/api/auth/me', { headers: { authorization: `Bearer ${t}` } });
    assert.equal((await me(token)).status, 200);
    assert.equal((await me(other)).status, 401);
    assert.equal((await login(clientEmail)).status, 401);
    assert.match((await (await login(clientEmail, 'nova-senha-12345')).json()).token, /^ta_ses_/);
  });

  it('equipe Tech Master não pode desativar', async () => {
    // Os três códigos aceitos agora já foram usados; libera para o teste.
    await prisma.user.update({ where: { email: mspEmail }, data: { totpLastStep: null } });
    const token = await loginWithCode(mspEmail, mspSecret, 0);
    assert.equal((await post('/auth/mfa/disable', { password: PASSWORD }, token)).status, 403);
  });

  it('administrador redefine o autenticador de quem perdeu o celular', async () => {
    const setup = await (await login(adminEmail)).json();
    const admin = await (await post('/auth/login/mfa', { challenge: setup.challenge, code: code(setup.secret) })).json();
    const users = await (await fetch(base + '/api/admin/users', { headers: { authorization: `Bearer ${admin.token}` } })).json();
    const op = users.find((u: { email: string }) => u.email === mspEmail);
    assert.equal(op.mfa_enabled, true);

    const opToken = (await prisma.userSession.findFirst({ where: { userId: op.id, revokedAt: null } }))!;
    assert.ok(opToken);
    assert.equal((await post(`/admin/users/${op.id}/mfa/reset`, {}, admin.token)).status, 200);
    assert.equal(await prisma.userSession.count({ where: { userId: op.id, revokedAt: null } }), 0);
    // Próximo login volta a pedir o cadastro.
    assert.equal((await (await login(mspEmail)).json()).mfa, 'setup');
  });
});
