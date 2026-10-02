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
import { compareVersions, latestMsi } from '../src/agent-installer/installer.js';
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
    assert.deepEqual(await r.json(), { available: false });
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

  it('auditor do cliente e visitante sem login não baixam', async () => {
    assert.equal((await get('/agent/installer', 'tenant_auditor')).status, 403);
    assert.equal((await get('/agent/installer/download', 'tenant_auditor')).status, 403);
    assert.equal((await fetch(`${base}/api/agent/installer/download`)).status, 401);
  });
});
