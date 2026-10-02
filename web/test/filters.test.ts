import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { apiParams, formatDateTime, isoToLocal, localToIso, screenFilters, screenQuery } from '../lib/filters.ts';

describe('filtros da tela de eventos', () => {
  const now = new Date('2026-10-02T12:00:00Z');

  it('converte horário de Brasília para UTC e de volta', () => {
    assert.equal(localToIso('2026-10-01T08:00'), '2026-10-01T11:00:00.000Z');
    assert.equal(localToIso('ontem'), null);
    assert.equal(isoToLocal(new Date('2026-10-01T11:00:00Z')), '2026-10-01T08:00');
    assert.equal(formatDateTime('2026-10-01T02:03:22.123456Z'), '30/09/2026 23:03:22');
  });

  it('período padrão: últimos 7 dias', () => {
    const f = screenFilters({}, now);
    assert.equal(f.de, '2026-09-25T09:00');
    assert.equal(f.ate, '2026-10-02T09:00');
  });

  it('monta os parâmetros da API', () => {
    const f = screenFilters(
      { usuario: ' joao ', caminho: 'D:\\Dados', acao: 'delete', de: '2026-10-01T00:00', ate: '2026-10-02T00:00', cliente: ['t1', 't2'] },
      now,
    );
    assert.deepEqual(Object.fromEntries(apiParams(f, { cursor: 'abc', limit: '' })), {
      tenant: 't1',
      user: 'joao',
      path: 'D:\\Dados',
      action: 'delete',
      from: '2026-10-01T03:00:00.000Z',
      to: '2026-10-02T03:00:00.000Z',
      cursor: 'abc',
    });
    assert.equal(
      screenQuery({ ...f, cliente: '', usuario: '' }, { cursor: 'x' }),
      'caminho=D%3A%5CDados&acao=delete&de=2026-10-01T00%3A00&ate=2026-10-02T00%3A00&cursor=x',
    );
  });
});
