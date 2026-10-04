import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AgentInputError, parseResults, parseSizes } from '../src/auditcfg/agent-input.js';
import { dedupedVolume, isWithin, normalizePath, parseExclusions, pathKey, PathError, volumeUsage } from '../src/auditcfg/paths.js';

const ID = '0b5d6c2e-7a51-4c7e-9f0a-1d2e3f4a5b6c';

describe('normalizePath', () => {
  it('padroniza barras, letra do disco e barra final', () => {
    assert.equal(normalizePath(' d:/Dados//Financeiro\\ '), 'D:\\Dados\\Financeiro');
    assert.equal(normalizePath('e:'), 'E:\\');
    assert.equal(normalizePath('E:\\'), 'E:\\');
  });

  it('recusa compartilhamento, caminho relativo e caracteres inválidos', () => {
    for (const bad of ['\\\\srv\\Financeiro', 'Dados\\Fin', 'D:\\a\\..\\b', 'D:\\a?b', 'D:\\pasta \\x', '', 42, 'D:\\a:b']) {
      assert.throws(() => normalizePath(bad), PathError, String(bad));
    }
  });
});

describe('normalizePath em servidor Linux', () => {
  it('padroniza barras repetidas e a barra final', () => {
    assert.equal(normalizePath(' /srv//Dados/Financeiro/ ', 'linux'), '/srv/Dados/Financeiro');
    assert.equal(normalizePath('/home/compartilhado', 'linux'), '/home/compartilhado');
  });

  it('recusa caminho do Windows, relativo, raiz e pastas do sistema', () => {
    for (const bad of ['D:\\Dados', '\\\\srv\\x', 'srv/dados', '/', '/srv/../etc', '/proc/1', '/etc', '/var/log/audit', '/srv/a\nb']) {
      assert.throws(() => normalizePath(bad, 'linux'), PathError, bad);
    }
  });

  it('diferencia maiúsculas e separa pastas por /', () => {
    assert.notEqual(pathKey('/srv/Dados'), pathKey('/srv/dados'));
    assert.ok(isWithin(pathKey('/srv/dados/fin'), pathKey('/srv/dados')));
    assert.ok(!isWithin(pathKey('/srv/dadosx'), pathKey('/srv/dados')));
    assert.ok(!isWithin(pathKey('/srv/Dados/fin'), pathKey('/srv/dados')));
  });
});

describe('isWithin e dedupedVolume', () => {
  it('compara por pasta inteira, não por prefixo de texto', () => {
    assert.ok(isWithin('d:\\dados\\fin\\2026', 'd:\\dados\\fin'));
    assert.ok(isWithin('d:\\dados', 'd:\\dados'));
    assert.ok(isWithin('d:\\dados', 'd:\\'));
    assert.ok(!isWithin('d:\\dados\\financeiro', 'd:\\dados\\fin'));
  });

  it('não conta caminhos aninhados duas vezes', () => {
    const p = (path: string, size: number | null) => ({ pathKey: pathKey(normalizePath(path)), sizeBytes: size === null ? null : BigInt(size) });
    const total = dedupedVolume([p('D:\\Dados', 100), p('D:\\Dados\\Fin', 40), p('D:\\Dados\\Fin\\2026', 10), p('E:\\RH', 7), p('D:\\DadosX', null)]);
    assert.equal(total, 107n);
    assert.equal(dedupedVolume([p('D:\\A', 5), p('d:\\a', 5)]), 5n);
  });
});

describe('volumeUsage', () => {
  it('faixas de 80% e 100%', () => {
    assert.deepEqual(volumeUsage(79n, 100n), { usedBytes: 79n, maxBytes: 100n, percent: 79, level: 0 });
    assert.equal(volumeUsage(80n, 100n).level, 80);
    assert.equal(volumeUsage(100n, 100n).level, 100);
    assert.equal(volumeUsage(150n, 100n).percent, 150);
    assert.equal(volumeUsage(0n, 0n).percent, null);
  });
});

describe('parseExclusions', () => {
  it('aceita texto com uma por linha e remove repetidas', () => {
    assert.deepEqual(parseExclusions('*.tmp\n~$*, *.TMP;\n'), ['*.tmp', '~$*']);
    assert.deepEqual(parseExclusions(undefined), []);
    assert.throws(() => parseExclusions(Array(21).fill(0).map((_, i) => `*.x${i}`)), PathError);
  });
});

describe('corpos do agente', () => {
  it('lê resultados com antes e depois', () => {
    const r = parseResults({
      version: 3,
      results: [{ path_id: ID.toUpperCase(), operation: 'apply', status: 'applied', before: { sacl: 'S:', policy: 'none' }, after: { sacl: 'S:(AU;SA;0x2;;;WD)' } }],
    });
    assert.equal(r.version, 3);
    assert.equal(r.results[0].pathId, ID);
    assert.deepEqual(r.results[0].after, { sacl: 'S:(AU;SA;0x2;;;WD)' });
    assert.throws(() => parseResults({ version: 1, results: [{ path_id: ID, operation: 'x', status: 'applied' }] }), AgentInputError);
    assert.throws(() => parseResults({ results: [] }), AgentInputError);
  });

  it('lê tamanhos com erro por caminho', () => {
    assert.deepEqual(parseSizes({ paths: [{ path_id: ID, size_bytes: 10 }, { path_id: ID, error: 'acesso negado' }] }), [
      { pathId: ID, sizeBytes: 10n, error: null },
      { pathId: ID, sizeBytes: null, error: 'acesso negado' },
    ]);
    assert.throws(() => parseSizes({ paths: [{ path_id: ID, size_bytes: -1 }] }), AgentInputError);
    assert.throws(() => parseSizes({ paths: [{ path_id: ID }] }), AgentInputError);
  });
});
