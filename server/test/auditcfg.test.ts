import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { createEnrollmentToken, createLicense, createTenant, createUser } from '../src/admin/admin.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { PrismaService } from '../src/prisma.service.js';

// Caminhos auditados: portal -> servidor -> agente -> resultado, contra o banco real.
const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL não definido';
const PASSWORD = 'senha-de-teste-123';
const DAY = 24 * 3600_000;
const GB = 1024 ** 3;

describe('configuração de caminhos auditados', { skip }, () => {
  let app: NestExpressApplication;
  let base: string;
  let prisma: PrismaService;
  let tenantA: string;
  let tenantB: string;
  let agentA: string;
  let agentToken: string;
  let agentB: string;
  let admin: string; // tenant_admin de A
  let auditor: string; // tenant_auditor de A
  let operator: string; // msp_operator
  let mspAdmin: string; // msp_admin
  let otherAdmin: string; // tenant_admin de B

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

  const login = async (email: string) => {
    const r = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    return (await json(r)).token as string;
  };

  const addPath = (token: string, path: string, extra: Record<string, unknown> = {}, agent = agentA) =>
    call('POST', `/api/config/agents/${agent}/paths`, token, { path, confirm: true, ...extra });

  const view = async (token: string, tenant = '') => json(await call('GET', `/api/config${tenant ? `?tenant=${tenant}` : ''}`, token));

  before(async () => {
    app = configureApp(await NestFactory.create<NestExpressApplication>(AppModule, { logger: false }));
    await app.listen(0);
    base = (await app.getUrl()).replace('[::1]', 'localhost');
    prisma = app.get(PrismaService);

    const id = randomUUID().slice(0, 8);
    tenantA = (await createTenant(prisma, `Config A ${id}`)).id;
    tenantB = (await createTenant(prisma, `Config B ${id}`)).id;
    for (const t of [tenantA, tenantB]) {
      await createLicense(prisma, { tenantId: t, maxAgents: 2, maxVolumeBytes: BigInt(10 * GB), validFrom: new Date(Date.now() - DAY), validUntil: new Date(Date.now() + 30 * DAY) });
    }
    const enroll = async (tenantId: string, machine: string) => {
      const token = (await createEnrollmentToken(prisma, { tenantId })).token;
      const r = await fetch(base + '/v1/enroll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enrollment_token: token, hostname: machine, machine_id: `${machine}-${id}`, os: 'windows' }),
      });
      return json(r, 201);
    };
    const a = await enroll(tenantA, 'FS-A');
    agentA = a.agent_id;
    agentToken = a.agent_token;
    agentB = (await enroll(tenantB, 'FS-B')).agent_id;

    const mk = async (role: string, tenantId?: string) => {
      const email = `${role}.${randomUUID().slice(0, 8)}@techmaster.inf.br`;
      await createUser(prisma, { email, name: role, role, tenantId, password: PASSWORD });
      return login(email);
    };
    admin = await mk('tenant_admin', tenantA);
    auditor = await mk('tenant_auditor', tenantA);
    otherAdmin = await mk('tenant_admin', tenantB);
    operator = await mk('msp_operator');
    mspAdmin = await mk('msp_admin');
  });

  after(async () => {
    await app?.close();
  });

  const agentGet = async () => json(await fetch(base + '/v1/config', { headers: { authorization: `Bearer ${agentToken}` } }));
  const agentPost = (path: string, body: unknown) =>
    fetch(base + path, { method: 'POST', headers: { authorization: `Bearer ${agentToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  let finId: string;

  it('cliente cadastra caminho com confirmação; versão do agente sobe', async () => {
    assert.equal((await call('POST', `/api/config/agents/${agentA}/paths`, admin, { path: 'D:\\Dados\\Financeiro' })).status, 400, 'sem confirmação');
    const p = await json(await addPath(admin, 'd:/Dados/Financeiro/', { exclusions: '*.tmp\n~$*' }), 201);
    finId = p.id;
    assert.equal(p.path, 'D:\\Dados\\Financeiro');
    assert.equal(p.status, 'pending');
    assert.equal(p.audit_read, false, 'leitura desligada por padrão');
    assert.equal(p.recursive, true);
    assert.deepEqual(p.exclusions, ['*.tmp', '~$*']);
    assert.equal((await addPath(admin, 'D:\\DADOS\\financeiro')).status, 400, 'repetido, sem diferenciar maiúsculas');
    assert.equal((await addPath(admin, '\\\\FS-A\\Financeiro')).status, 400, 'compartilhamento de rede');

    const cfg = await agentGet();
    assert.equal(cfg.version, 1);
    assert.deepEqual(cfg.paths, [{ id: finId, path: 'D:\\Dados\\Financeiro', state: 'active', recursive: true, audit_read: false, exclusions: ['*.tmp', '~$*'] }]);
  });

  it('auditor só consulta; outro cliente não enxerga nem altera', async () => {
    assert.equal((await addPath(auditor, 'D:\\RH')).status, 403);
    const v = await view(auditor);
    assert.equal(v.agents[0].paths[0].id, finId);
    assert.equal((await call('GET', `/api/config?tenant=${tenantA}`, otherAdmin)).status, 403);
    assert.equal((await addPath(otherAdmin, 'D:\\X', {}, agentA)).status, 404);
    assert.equal((await call('DELETE', `/api/config/paths/${finId}`, otherAdmin, { confirm: true })).status, 404);
    assert.equal((await call('GET', '/api/config', operator)).status, 400, 'Tech Master precisa escolher a empresa');
    assert.equal((await view(operator, tenantB)).agents[0].id, agentB);
  });

  it('agente aplica e devolve antes/depois; vira alerta e histórico', async () => {
    const r = await json(
      await agentPost('/v1/config/result', {
        version: 1,
        results: [
          {
            path_id: finId,
            operation: 'apply',
            status: 'applied',
            before: { sacl: 'S:AI', policy: 'File System: none' },
            after: { sacl: 'S:AI(AU;OICISAFA;0x1d0156;;;WD)', policy: 'File System: success, failure' },
          },
        ],
      }),
    );
    assert.deepEqual(r, { recorded: 1, ignored: 0 });
    const v = await view(admin);
    assert.equal(v.agents[0].paths[0].status, 'applied');
    assert.equal(v.agents[0].config_applied_version, 1);
    assert.ok(v.alerts.some((a: { kind: string; message: string }) => a.kind === 'audit_config_changed' && a.message.includes('D:\\Dados\\Financeiro')));

    const h = await json(await call('GET', '/api/config/changes', admin));
    assert.deepEqual(h.items.map((i: { kind: string }) => i.kind), ['applied', 'add']);
    assert.equal(h.items[1].user_role, 'tenant_admin');
    assert.equal(h.items[0].details.after.sacl, 'S:AI(AU;OICISAFA;0x1d0156;;;WD)');

    // Verificação sem mudança não gera registro.
    await json(await agentPost('/v1/config/result', { version: 1, results: [{ path_id: finId, operation: 'verify', status: 'applied' }] }));
    assert.equal((await json(await call('GET', '/api/config/changes', admin))).items.length, 2);
    // Caminho de outro agente é ignorado.
    const other = await prisma.auditedPath.create({ data: { tenantId: tenantB, agentId: agentB, path: 'D:\\B', pathKey: 'd:\\b' } });
    assert.deepEqual(await json(await agentPost('/v1/config/result', { version: 1, results: [{ path_id: other.id, operation: 'apply', status: 'error', message: 'x' }] })), {
      recorded: 0,
      ignored: 1,
    });
  });

  it('o histórico não pode ser alterado nem apagado no banco', async () => {
    await assert.rejects(prisma.auditConfigChange.updateMany({ where: { tenantId: tenantA }, data: { message: 'x' } }), /somente inserção/);
    await assert.rejects(prisma.auditConfigChange.deleteMany({ where: { tenantId: tenantA } }), /somente inserção/);
  });

  it('tamanhos: aninhado não conta duas vezes; alerta aos 80% e bloqueio aos 100%', async () => {
    const sub = await json(await addPath(admin, 'D:\\Dados\\Financeiro\\2026'), 201);
    const rh = await json(await addPath(operator, 'E:\\RH', {}, agentA), 201);
    await json(
      await agentPost('/v1/config/sizes', {
        paths: [
          { path_id: finId, size_bytes: 6 * GB },
          { path_id: sub.id, size_bytes: 2 * GB },
          { path_id: rh.id, size_bytes: 2.5 * GB },
        ],
      }),
    );
    let v = await view(admin);
    assert.equal(v.volume.used_bytes, String(8.5 * GB));
    assert.equal(v.volume.level, 80);
    assert.ok(v.alerts.some((a: { kind: string }) => a.kind === 'volume_80'));

    // Aninhado continua liberado (não aumenta o volume).
    await json(await addPath(admin, 'D:\\Dados\\Financeiro\\2025'), 201);

    const r = await json(await agentPost('/v1/config/sizes', { paths: [{ path_id: rh.id, size_bytes: 5 * GB }] }));
    assert.equal(r.volume.level, 100);
    v = await view(admin);
    assert.equal(v.alerts.filter((a: { kind: string }) => a.kind === 'volume_100').length, 1);
    const blocked = await addPath(admin, 'F:\\Novo');
    assert.equal(blocked.status, 400);
    assert.match((await blocked.json()).message, /volume/);
    assert.equal((await addPath(operator, 'F:\\Novo', { override_volume: true })).status, 403, 'só o msp_admin libera');
    const ok = await json(await addPath(mspAdmin, 'F:\\Novo', { override_volume: true }), 201);
    const h = await json(await call('GET', `/api/config/changes?tenant=${tenantA}&limit=1`, mspAdmin));
    assert.equal(h.items[0].audited_path_id, ok.id);
    assert.equal(h.items[0].details.volume_override, true);
    // Mesma faixa: sem alerta repetido.
    await json(await agentPost('/v1/config/sizes', { paths: [{ path_id: rh.id, size_bytes: 6 * GB }] }));
    assert.equal((await view(admin)).alerts.filter((a: { kind: string }) => a.kind === 'volume_100').length, 1);
  });

  it('alterar opções e remover: o agente recebe o pedido e confirma', async () => {
    const before = (await agentGet()).version;
    const u = await json(await call('PATCH', `/api/config/paths/${finId}`, admin, { confirm: true, audit_read: true }));
    assert.equal(u.audit_read, true);
    assert.deepEqual(u.exclusions, ['*.tmp', '~$*'], 'opções não informadas ficam como estavam');
    assert.equal(u.status, 'pending');

    const d = await json(await call('DELETE', `/api/config/paths/${finId}`, admin, { confirm: true }));
    assert.equal(d.status, 'removing', 'já foi aplicado: o agente precisa desfazer');
    let cfg = await agentGet();
    assert.equal(cfg.version, before + 2);
    assert.equal(cfg.paths.find((p: { id: string }) => p.id === finId).state, 'removed');

    await json(await agentPost('/v1/config/result', { version: cfg.version, results: [{ path_id: finId, operation: 'remove', status: 'removed', before: { sacl: 'S:(AU;OICISAFA;0x1d0157;;;WD)' }, after: { sacl: 'S:' } }] }));
    cfg = await agentGet();
    assert.equal(cfg.paths.find((p: { id: string }) => p.id === finId), undefined);
    assert.equal((await view(admin)).agents[0].paths.find((p: { id: string }) => p.id === finId), undefined);

    // Pendente nunca aplicado some na hora.
    const pend = (await view(admin)).agents[0].paths.find((p: { path: string }) => p.path === 'D:\\Dados\\Financeiro\\2025');
    assert.equal((await json(await call('DELETE', `/api/config/paths/${pend.id}`, admin, { confirm: true }))).status, 'removed');

    // Recadastrar reaproveita a linha.
    const again = await json(await addPath(mspAdmin, 'D:\\Dados\\Financeiro'), 201);
    assert.equal(again.id, finId);
    assert.equal(again.status, 'pending');
  });

  it('erro e divergência aparecem como alerta; reconhecer tira da lista', async () => {
    const v0 = (await agentGet()).version;
    await json(await agentPost('/v1/config/result', { version: v0, results: [{ path_id: finId, operation: 'apply', status: 'error', message: 'privilégio SeSecurityPrivilege ausente' }] }));
    let v = await view(admin);
    const p = v.agents[0].paths.find((x: { id: string }) => x.id === finId);
    assert.equal(p.status, 'error');
    assert.match(p.last_error, /SeSecurityPrivilege/);
    const alert = v.alerts.find((a: { kind: string }) => a.kind === 'audit_config_error');
    assert.ok(alert);
    await json(await call('POST', `/api/config/alerts/${alert.id}/ack`, auditor));
    assert.equal(await prisma.alert.count({ where: { id: BigInt(alert.id), acknowledgedAt: null } }), 0);
    assert.equal((await call('POST', `/api/config/alerts/${alert.id}/ack`, otherAdmin)).status, 404);

    await json(await call('POST', `/api/config/paths/${finId}/reapply`, admin, { confirm: true }));
    await json(await agentPost('/v1/config/result', { version: v0 + 1, results: [{ path_id: finId, operation: 'apply', status: 'applied' }] }));
    await json(await agentPost('/v1/config/result', { version: v0 + 1, results: [{ path_id: finId, operation: 'verify', status: 'divergent', message: 'ACE de auditoria removida da SACL' }] }));
    v = await view(admin);
    assert.equal(v.agents[0].paths.find((x: { id: string }) => x.id === finId).status, 'divergent');
    assert.ok(v.alerts.some((a: { kind: string }) => a.kind === 'audit_config_divergent'));
  });

  it('corpo inválido do agente dá 400; sem token, 401', async () => {
    assert.equal((await agentPost('/v1/config/result', { version: 'x', results: [] })).status, 400);
    assert.equal((await agentPost('/v1/config/sizes', { paths: [{ path_id: 'x', size_bytes: 1 }] })).status, 400);
    assert.equal((await fetch(base + '/v1/config')).status, 401);
  });
});
