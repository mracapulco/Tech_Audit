import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createTenant, createUser } from '../src/admin/admin.js';
import { compareVersions, latestMsi, latestPackage } from '../src/agent-installer/installer.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { PrismaService } from '../src/prisma.service.js';

describe('instalador do agente: escolha do arquivo', () => {
  it('ordena versões numericamente', () => {
    assert.ok(compareVersions('0.10.0', '0.9.1') > 0);
    assert.ok(compareVersions('0.3.0', '0.3.0') === 0);
    assert.ok(compareVersions('1.0', '0.99.99') > 0);
  });

  it('pega o MSI mais novo e ignora outros arquivos', () => {
    assert.deepEqual(latestMsi(['TechAuditAgent-0.9.0.msi', 'TechAuditAgent-0.10.0.msi', 'techaudit-agent.exe', 'x.msi']), {
      name: 'TechAuditAgent-0.10.0.msi',
      version: '0.10.0',
    });
    assert.equal(latestMsi(['agent.zip']), null);
  });

  it('pega os pacotes Linux x86-64 mais novos', () => {
    const names = [
      'techaudit-agent_0.4.0-1_amd64.deb',
      'techaudit-agent_0.10.0-1_amd64.deb',
      'techaudit-agent_0.11.0-1_arm64.deb',
      'techaudit-agent-0.4.0-1.x86_64.rpm',
      'techaudit-agent-0.4.0-1.aarch64.rpm',
      'TechAuditAgent-0.4.0.msi',
    ];
    assert.deepEqual(latestPackage(names, 'deb'), { name: 'techaudit-agent_0.10.0-1_amd64.deb', version: '0.10.0' });
    assert.deepEqual(latestPackage(names, 'rpm'), { name: 'techaudit-agent-0.4.0-1.x86_64.rpm', version: '0.4.0' });
    assert.deepEqual(latestPackage(names, 'windows'), { name: 'TechAuditAgent-0.4.0.msi', version: '0.4.0' });
  });
});

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL não definido';
const PASSWORD = 'senha-de-teste-123';

describe('instalador do agente: download pelo portal', { skip }, () => {
  let app: NestExpressApplication;
  let base: string;
  let prisma: PrismaService;
  let dir: string;
  const id = randomUUID().slice(0, 8);
  const tokens: Record<string, string> = {};
  const content = Buffer.from('MSI de teste ' + id);

  const get = (path: string, role: string) => fetch(`${base}/api${path}`, { headers: { authorization: `Bearer ${tokens[role]}` } });

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ta-installer-'));
    process.env.AGENT_DOWNLOADS_DIR = dir;
    app = configureApp(await NestFactory.create<NestExpressApplication>(AppModule, { logger: false }));
    await app.listen(0);
    base = (await app.getUrl()).replace('[::1]', 'localhost');
    prisma = app.get(PrismaService);
    const tenant = await createTenant(prisma, `Instalador ${id}`);
    for (const role of ['msp_admin', 'tenant_admin', 'tenant_auditor']) {
      const email = `${role}.${id}@exemplo.com.br`;
      await createUser(prisma, { email, name: role, role, tenantId: role.startsWith('tenant') ? tenant.id : undefined, password: PASSWORD });
      const r = await fetch(base + '/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: PASSWORD }),
      });
      tokens[role] = (await r.json()).token;
    }
  });

  after(async () => {
    await app?.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.AGENT_DOWNLOADS_DIR;
  });

  it('avisa quando não há instalador', async () => {
    const r = await get('/agent/installer', 'msp_admin');
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { available: false, linux: { deb: null, rpm: null } });
    assert.equal((await get('/agent/installer/download', 'msp_admin')).status, 404);
  });

  it('entrega o MSI mais novo com hash e registra o download', async () => {
    writeFileSync(join(dir, 'TechAuditAgent-0.2.9.msi'), 'antigo');
    writeFileSync(join(dir, 'TechAuditAgent-0.3.0.msi'), content);
    const info = await (await get('/agent/installer', 'tenant_admin')).json();
    assert.equal(info.available, true);
    assert.equal(info.file_name, 'TechAuditAgent-0.3.0.msi');
    assert.equal(info.version, '0.3.0');
    assert.equal(info.size, content.length);
    assert.equal(info.sha256, createHash('sha256').update(content).digest('hex'));
    assert.equal(info.path, undefined);

    const r = await get('/agent/installer/download', 'tenant_admin');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition') ?? '', /TechAuditAgent-0\.3\.0\.msi/);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), content);

    const user = await prisma.user.findFirstOrThrow({ where: { email: `tenant_admin.${id}@exemplo.com.br` } });
    const log = await prisma.portalAuditLog.findFirst({ where: { action: 'agent.download', userId: user.id } });
    assert.ok(log, 'download registrado no log de acesso');
  });

  it('entrega os pacotes .deb e .rpm', async () => {
    const deb = Buffer.from('deb ' + id);
    writeFileSync(join(dir, 'techaudit-agent_0.4.0-1_amd64.deb'), deb);
    const info = await (await get('/agent/installer', 'msp_admin')).json();
    assert.equal(info.linux.deb.file_name, 'techaudit-agent_0.4.0-1_amd64.deb');
    assert.equal(info.linux.deb.sha256, createHash('sha256').update(deb).digest('hex'));
    assert.equal(info.linux.rpm, null);
    assert.equal(info.file_name, 'TechAuditAgent-0.3.0.msi');

    const r = await get('/agent/installer/download?kind=deb', 'msp_admin');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/vnd.debian.binary-package');
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), deb);
    assert.equal((await get('/agent/installer/download?kind=rpm', 'msp_admin')).status, 404);
    assert.equal((await get('/agent/installer/download?kind=exe', 'msp_admin')).status, 400);
  });

  it('auditor do cliente e visitante sem login não baixam', async () => {
    assert.equal((await get('/agent/installer', 'tenant_auditor')).status, 403);
    assert.equal((await get('/agent/installer/download', 'tenant_auditor')).status, 403);
    assert.equal((await fetch(`${base}/api/agent/installer/download`)).status, 401);
  });
});
