import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LoginThrottle } from '../src/auth/login-throttle.js';
import { csvCell, eventCsvLine, formatBrasilia } from '../src/events/csv.js';
import {
  buildEventQuery,
  decodeCursor,
  encodeCursor,
  FilterError,
  likeEscape,
  parseFilters,
  parseLimit,
} from '../src/events/event-query.js';
import { tenantScope } from '../src/events/events.service.js';

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const now = new Date('2026-10-02T12:00:00Z');

describe('filtros da pesquisa de eventos', () => {
  it('período padrão: últimos 7 dias', () => {
    const f = parseFilters({}, [T1], now);
    assert.equal(f.to.toISOString(), now.toISOString());
    assert.equal(f.from.toISOString(), '2026-09-25T12:00:00.000Z');
    assert.deepEqual([f.user, f.pathPrefix, f.action], [null, null, null]);
  });

  it('valida datas, ação e campos repetidos', () => {
    assert.throws(() => parseFilters({ from: 'ontem' }, null, now), FilterError);
    assert.throws(() => parseFilters({ from: '2026-10-02', to: '2026-10-01' }, null, now), /antes do fim/);
    assert.throws(() => parseFilters({ action: 'drop table' }, null, now), /ação inválida/);
    // Tipos novos do agente passam sem mudar o servidor.
    assert.equal(parseFilters({ action: 'moved_to_recycle_bin' }, null, now).action, 'moved_to_recycle_bin');
    assert.throws(() => parseFilters({ user: ['a', 'b'] }, null, now), /uma vez/);
    const f = parseFilters({ user: '  joao ', path: 'D:\\Dados\\', action: 'delete' }, null, now);
    assert.deepEqual([f.user, f.pathPrefix, f.action], ['joao', 'D:\\Dados\\', 'delete']);
    assert.equal(parseFilters({ action: 'recycled' }, null, now).action, 'recycled');
  });

  it('limite de página', () => {
    assert.equal(parseLimit(undefined), 50);
    assert.equal(parseLimit('200'), 200);
    assert.throws(() => parseLimit('201'), FilterError);
    assert.throws(() => parseLimit('1e2'), FilterError);
  });

  it('cursor ida e volta; cursor adulterado é recusado', () => {
    const c = { time: '2026-10-01T14:03:22.123456Z', agentId: T1, recordId: '42' };
    assert.deepEqual(decodeCursor(encodeCursor(c)), c);
    assert.equal(decodeCursor(undefined), null);
    assert.throws(() => decodeCursor('abc'), /cursor inválido/);
    const bad = Buffer.from(JSON.stringify(['2026-10-01', T1, '42'])).toString('base64url');
    assert.throws(() => decodeCursor(bad), /cursor inválido/);
  });

  it('escapa curingas do LIKE sem mexer na barra invertida', () => {
    assert.equal(likeEscape('D:\\100%_ok!'), 'D:\\100!%!_ok!!');
  });

  it('SQL só usa parâmetros e filtra os dicionários por tenant', () => {
    const f = parseFilters({ user: "x' OR 1=1 --", path: 'D:\\A', action: 'write' }, [T1], now);
    const q = buildEventQuery(f, { time: '2026-10-01T14:03:22.123456Z', agentId: T1, recordId: '9' }, 51);
    assert.ok(!q.text.includes('OR 1=1'));
    assert.match(q.text, /\(e\.action = \$7 OR \$7 = ANY\(e\.actions\)\)/);
    assert.match(q.text, /FROM identities WHERE tenant_id = ANY\(\$3::uuid\[\]\)/);
    assert.match(q.text, /FROM paths WHERE tenant_id = ANY\(\$3::uuid\[\]\)/);
    assert.deepEqual(q.values.slice(2), [[T1], "%x' or 1=1 --%", "x' or 1=1 --", 'd:\\a%', 'write', '2026-10-01T14:03:22.123456Z', T1, '9', 51]);
  });
});

describe('escopo de tenant', () => {
  const msp = { role: 'msp_operator' as const, tenantId: null };
  const cli = { role: 'tenant_auditor' as const, tenantId: T1 };

  it('Tech Master vê todos ou o tenant escolhido', () => {
    assert.equal(tenantScope(msp, undefined), null);
    assert.deepEqual(tenantScope(msp, T2), [T2]);
  });

  it('cliente só vê o próprio tenant', () => {
    assert.deepEqual(tenantScope(cli, undefined), [T1]);
    assert.deepEqual(tenantScope(cli, T1), [T1]);
    assert.throws(() => tenantScope(cli, T2), /sem acesso/);
    assert.throws(() => tenantScope(cli, 'x'), /tenant inválido/);
  });
});

describe('CSV', () => {
  it('protege contra fórmula e escapa separador', () => {
    assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
    assert.equal(csvCell('a;b'), '"a;b"');
    assert.equal(csvCell(null), '');
    assert.equal(csvCell('D:\\Dados\\a.txt'), 'D:\\Dados\\a.txt');
  });

  it('linha de evento em horário de Brasília', () => {
    assert.equal(formatBrasilia('2026-10-01T14:03:22.123456Z'), '2026-10-01 11:03:22');
    const line = eventCsvLine({
      time: '2026-10-01T14:03:22.123456Z',
      tenant_id: T1,
      tenant_name: 'Cliente',
      agent_id: T1,
      server: 'FS01',
      record_id: '7',
      event_id: 4663,
      kind: 'object_access',
      path: 'D:\\A\\b.txt',
      user_domain: 'CORP',
      user_name: 'joao',
      user_sid: 'S-1-5-21-1',
      actions: ['delete', 'write'],
      success: false,
      share_name: null,
      source_ip: '10.0.0.5',
      process_name: null,
      action: 'renamed',
      new_path: 'D:\\A\\c.txt',
      item_type: 'file',
      count: 1,
      end_time: null,
    });
    assert.equal(
      line,
      '2026-10-01 11:03:22;Cliente;FS01;CORP\\joao;S-1-5-21-1;Renomeou;D:\\A\\b.txt;D:\\A\\c.txt;1;delete, write;falha;;10.0.0.5;;4663;7\r\n',
    );
  });
});

describe('limite de tentativas de login', () => {
  it('bloqueia após 5 falhas na janela e libera depois', () => {
    const t = new LoginThrottle(5, 1000);
    for (let i = 0; i < 5; i++) t.fail('k', 100 + i);
    assert.equal(t.blocked('k', 200), true);
    assert.equal(t.blocked('outro', 200), false);
    assert.equal(t.blocked('k', 1200), false);
    t.fail('k', 1200);
    t.reset('k');
    assert.equal(t.blocked('k', 1201), false);
  });
});
