import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { createEnrollmentToken, createLicense, createTenant, createUser } from '../src/admin/admin.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { parsePermissionUpload } from '../src/permissions/permissions-input.js';
import { versionAtLeast } from '../src/permissions/permissions.service.js';
import { PrismaService } from '../src/prisma.service.js';
import { unzip } from './fixtures.js';

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL não definido';
const PASSWORD = 'senha-de-teste-123';
const DAY = 24 * 3600_000;
const GB = 1024 ** 3;

describe('inventário: leitura do envio do agente', () => {
  it('valida e achata pastas em linhas', () => {
    const u = parsePermissionUpload({
      scan_id: randomUUID(),
      path_id: randomUUID(),
      part: 0,
      final: true,
      started_at: '2026-10-05T10:00:00Z',
      finished_at: '2026-10-05T10:01:00Z',
      scanned: 10,
      folders: [
        { path: 'D:\\Dados', depth: 0, source: 'ntfs', reason: 'root', entries: [{ principal: 'CORP\\Financeiro', kind: 'group', access: 'allow', rights: 'Modificar' }, { principal: 'BUILTIN\\Administradores', kind: 'group', access: 'allow', rights: 'Controle total', inherited: true }] },
        { path: 'D:\\Dados\\Fechada', depth: 1, source: 'ntfs', reason: 'error', error: 'acesso negado', entries: [] },
      ],
    });
    assert.equal(u.rows.length, 3);
    assert.equal(u.folders, 2);
    assert.equal(u.rows[2].principal, null);
    assert.equal(u.rows[2].folderError, 'acesso negado');
    assert.throws(() => parsePermissionUpload({ scan_id: 'x', path_id: randomUUID(), part: 0 }), /scan_id/);
  });

  it('compara versões do agente', () => {
    assert.equal(versionAtLeast('0.5.0', '0.5.0'), true);
    assert.equal(versionAtLeast('0.5.0-dev', '0.5.0'), true);
    assert.equal(versionAtLeast('0.10.1', '0.5.0'), true);
    assert.equal(versionAtLeast('0.4.1', '0.5.0'), false);
    assert.equal(versionAtLeast(null, '0.5.0'), false);
  });
});

describe('inventário de permissões', { skip }, () => {
  let app: NestExpressApplication;
  let base: string;
  let prisma: PrismaService;
  let tenantE: string; // Enterprise
  let tenantP: string; // Profissional
  let agentE: string;
  let tokenE: string;
  let tokenP: string;
  let pathE: string;
  let pathP: string;
  let auditor: string;
  let otherAdmin: string;
  let operator: string;

  const call = (method: string, path: string, token: string, body?: unknown) =>
    fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  const json = async (r: Response, status = 200) => {
    const text = await r.text();
    assert.equal(r.status, status, text);
    return JSON.parse(text);
  };
  const login = async (email: string) =>
    (await json(await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) })))
      .token as string;

  const upload = (token: string, body: Record<string, unknown>) => call('POST', '/v1/permissions', token, body);
  const scanBody = (pathId: string, scanId: string, folders: unknown[], extra: Record<string, unknown> = {}) => ({
    scan_id: scanId,
    path_id: pathId,
    part: 0,
    final: true,
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    scanned: folders.length,
    truncated: false,
    folders,
    ...extra,
  });
  const root = (entries: unknown[]) => ({ path: 'D:\\Dados', depth: 0, source: 'ntfs', owner: 'BUILTIN\\Administradores', reason: 'root', entries });
  const ent = (principal: string, rights: string, extra: Record<string, unknown> = {}) => ({
    principal,
    kind: 'group',
    access: 'allow',
    rights,
    raw: '0x1301bf',
    inherited: false,
    applies_to: 'Esta pasta, subpastas e arquivos',
    ...extra,
  });

  before(async () => {
    app = configureApp(await NestFactory.create<NestExpressApplication>(AppModule, { logger: false }));
    await app.listen(0);
    base = (await app.getUrl()).replace('[::1]', 'localhost');
    prisma = app.get(PrismaService);
    const id = randomUUID().slice(0, 8);
    tenantE = (await createTenant(prisma, `Perm E ${id}`)).id;
    tenantP = (await createTenant(prisma, `Perm P ${id}`)).id;
    for (const [t, plan] of [[tenantE, 'Enterprise'], [tenantP, 'Profissional']] as const) {
      await createLicense(prisma, { tenantId: t, plan, maxAgents: 2, maxVolumeBytes: BigInt(10 * GB), validFrom: new Date(Date.now() - DAY), validUntil: new Date(Date.now() + 30 * DAY) });
    }
    const enroll = async (tenantId: string, machine: string) => {
      const token = (await createEnrollmentToken(prisma, { tenantId })).token;
      const r = await fetch(base + '/v1/enroll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enrollment_token: token, hostname: machine, machine_id: `${machine}-${id}`, os: 'windows', agent_version: '0.5.0' }),
      });
      return json(r, 201);
    };
    const e = await enroll(tenantE, 'FS-E');
    agentE = e.agent_id;
    tokenE = e.agent_token;
    const p = await enroll(tenantP, 'FS-P');
    tokenP = p.agent_token;
    const mk = async (role: string, tenantId?: string) => {
      const email = `${role}.${randomUUID().slice(0, 8)}@techmaster.inf.br`;
      await createUser(prisma, { email, name: role, role, tenantId, password: PASSWORD });
      return login(email);
    };
    const adminE = await mk('tenant_admin', tenantE);
    auditor = await mk('tenant_auditor', tenantE);
    otherAdmin = await mk('tenant_admin', tenantP);
    operator = await mk('msp_operator');
    pathE = (await json(await call('POST', `/api/config/agents/${agentE}/paths`, adminE, { path: 'D:\\Dados', confirm: true }), 201)).id;
    pathP = (await json(await call('POST', `/api/config/agents/${p.agent_id}/paths`, otherAdmin, { path: 'D:\\Dados', confirm: true }), 201)).id;
  });

  after(async () => {
    await app?.close();
  });

  it('só o plano Enterprise liga o inventário no agente', async () => {
    const cfgE = await json(await fetch(base + '/v1/config', { headers: { authorization: `Bearer ${tokenE}` } }));
    assert.deepEqual(cfgE.permissions, { enabled: true, interval_hours: 24, requested_at: '' });
    const cfgP = await json(await fetch(base + '/v1/config', { headers: { authorization: `Bearer ${tokenP}` } }));
    assert.equal(cfgP.permissions.enabled, false);
    assert.equal((await upload(tokenP, scanBody(pathP, randomUUID(), [root([ent('Todos', 'Leitura')])]))).status, 403);
    const v = await json(await call('GET', '/api/permissions', otherAdmin));
    assert.equal(v.allowed, false);
    assert.equal((await call('POST', '/api/permissions/refresh', otherAdmin, {})).status, 403);
  });

  it('recebe a coleta em partes, ignora reenvio e recusa parte fora de ordem', async () => {
    const scan = randomUUID();
    const sub = { path: 'D:\\Dados\\RH', depth: 1, source: 'ntfs', reason: 'protected', protected: true, entries: [ent('CORP\\RH', 'Modificar'), ent('CORP\\joao', 'Especial', { kind: 'user', access: 'deny' })] };
    assert.equal((await upload(tokenE, scanBody(pathE, scan, [root([ent('CORP\\Financeiro', 'Modificar'), ent('BUILTIN\\Administradores', 'Controle total', { inherited: true })])], { final: false }))).status, 200);
    // Reenvio da parte 0 (a resposta se perdeu): não duplica.
    assert.equal((await upload(tokenE, scanBody(pathE, scan, [root([ent('X', 'Y')])], { final: false }))).status, 200);
    assert.equal((await upload(tokenE, scanBody(pathE, scan, [sub], { part: 2 }))).status, 409);
    const share = { path: 'D:\\Dados', depth: 0, source: 'share', share: 'Dados', reason: 'share', entries: [ent('Todos', 'Controle total', { applies_to: 'Compartilhamento' })] };
    await json(await upload(tokenE, scanBody(pathE, scan, [sub, share], { part: 1, scanned: 120 })));
    // Outro agente não envia para este caminho.
    assert.equal((await upload(tokenP, scanBody(pathE, randomUUID(), []))).status, 403);

    const v = await json(await call('GET', '/api/permissions', auditor));
    assert.equal(v.allowed, true);
    assert.equal(v.rows.length, 5);
    assert.ok(v.rows.every((r: { is_new: boolean }) => !r.is_new), 'primeira coleta não marca novidades');
    const s = v.agents[0].paths[0].scan;
    assert.equal(s.status, 'complete');
    assert.equal(s.folders_scanned, 120);
    assert.equal(s.folders_recorded, 3);

    const deny = await json(await call('GET', '/api/permissions?deny=1', auditor));
    assert.deepEqual(deny.rows.map((r: { principal: string }) => r.principal), ['CORP\\joao']);
    const explicit = await json(await call('GET', '/api/permissions?explicit=1&q=administradores', auditor));
    assert.equal(explicit.rows.length, 0, 'administradores só herdado');
    const q = await json(await call('GET', '/api/permissions?q=rh', auditor));
    assert.equal(q.rows.length, 2, 'busca pelo caminho da pasta');
  });

  it('compara com a coleta anterior', async () => {
    await json(
      await upload(
        tokenE,
        scanBody(pathE, randomUUID(), [root([ent('CORP\\Financeiro', 'Controle total'), ent('BUILTIN\\Administradores', 'Controle total', { inherited: true })])]),
      ),
    );
    const v = await json(await call('GET', `/api/permissions?tenant=${tenantE}`, operator));
    assert.equal(v.rows.length, 2);
    assert.deepEqual(
      v.rows.filter((r: { is_new: boolean }) => r.is_new).map((r: { principal: string; rights: string }) => `${r.principal} ${r.rights}`),
      ['CORP\\Financeiro Controle total'],
    );
    assert.deepEqual(
      v.removed.map((r: { principal: string }) => r.principal).sort(),
      ['CORP\\Financeiro', 'CORP\\RH', 'CORP\\joao', 'Todos'],
    );

    // Terceira coleta: só as duas últimas completas guardam linhas.
    await json(await upload(tokenE, scanBody(pathE, randomUUID(), [root([ent('CORP\\Financeiro', 'Controle total')])])));
    const scans = await prisma.permissionScan.findMany({ where: { auditedPathId: pathE }, include: { _count: { select: { entries: true } } }, orderBy: { receivedAt: 'asc' } });
    assert.equal(scans.length, 3);
    assert.equal(scans[0]._count.entries, 0);
    assert.ok(scans[1]._count.entries > 0 && scans[2]._count.entries > 0);

    // Erro ao ler o caminho: mostra o erro, sem listar tudo como removido.
    await json(await upload(tokenE, scanBody(pathE, randomUUID(), [], { error: 'O sistema não pode encontrar o caminho especificado.' })));
    const e = await json(await call('GET', '/api/permissions', auditor));
    assert.equal(e.agents[0].paths[0].scan.status, 'error');
    assert.equal(e.rows.length, 0);
    assert.equal(e.removed.length, 0);
  });

  it('isola empresas e registra Atualizar agora', async () => {
    assert.equal((await call('GET', `/api/permissions?tenant=${tenantE}`, otherAdmin)).status, 403);
    const r = await json(await call('POST', '/api/permissions/refresh', auditor, { agent: agentE }));
    assert.equal(r.requested, 1);
    const cfg = await json(await fetch(base + '/v1/config', { headers: { authorization: `Bearer ${tokenE}` } }));
    assert.ok(cfg.permissions.requested_at, 'agente recebe o pedido');
    const v = await json(await call('GET', '/api/permissions', auditor));
    assert.equal(v.agents[0].pending, true);
    assert.equal(v.agents[0].supported, true);
  });

  it('exporta Excel e PDF', async () => {
    await json(await upload(tokenE, scanBody(pathE, randomUUID(), [root([ent('CORP\\Financeiro', 'Controle total'), ent('CORP\\Diretoria', 'Leitura')])])));
    const x = await call('GET', '/api/permissions/export?format=xlsx', auditor);
    assert.equal(x.status, 200);
    const files = unzip(Buffer.from(await x.arrayBuffer()));
    const sheet = [...files.entries()].find(([k]) => k.includes('worksheets'))![1];
    assert.match(sheet, /CORP\\Diretoria/);
    assert.match(sheet, /Nova desde a coleta anterior/);
    const p = await call('GET', '/api/permissions/export?format=pdf', auditor);
    assert.equal(p.status, 200);
    assert.equal(Buffer.from(await p.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
    assert.equal((await call('GET', '/api/permissions/export?format=csv', auditor)).status, 400);
  });
});
