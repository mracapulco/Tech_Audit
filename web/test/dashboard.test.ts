import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ago, health, labelIndexes, niceMax, userText } from '../lib/dashboard.ts';
import { actionOptions, presetRange } from '../lib/filters.ts';

describe('painel', () => {
  const now = new Date('2026-10-02T12:00:00Z');

  it('tempo desde o último envio', () => {
    assert.equal(ago(null, now), 'nunca');
    assert.equal(ago('2026-10-02T11:59:50Z', now), 'agora');
    assert.equal(ago('2026-10-02T11:30:00Z', now), 'há 30 min');
    assert.equal(ago('2026-10-02T07:00:00Z', now), 'há 5 h');
    assert.equal(ago('2026-09-28T12:00:00Z', now), 'há 4 dias');
  });

  it('situação do agente', () => {
    assert.deepEqual(health('stale'), { label: 'Parado', tone: 'bad' });
    assert.equal(health('outro').tone, 'neutral');
  });

  it('escala do gráfico', () => {
    assert.equal(niceMax(0), 1);
    assert.equal(niceMax(7), 10);
    assert.equal(niceMax(13), 20);
    assert.equal(niceMax(230), 250);
    assert.equal(niceMax(4100), 5000);
  });

  it('rótulos do eixo X sem amontoar', () => {
    assert.deepEqual(labelIndexes(5), [0, 1, 2, 3, 4]);
    const idx = labelIndexes(30);
    assert.ok(idx.length <= 8);
    assert.equal(idx[0], 0);
    assert.equal(idx[idx.length - 1], 29);
  });

  it('usuário com domínio', () => {
    assert.equal(userText({ user_domain: 'CORP', user_name: 'ana' }), 'CORP\\ana');
    assert.equal(userText({ user_name: null }), '(não identificado)');
  });

  it('atalhos de período e ações novas no filtro', () => {
    assert.deepEqual(presetRange('24h', now), { de: '2026-10-01T09:00', ate: '2026-10-02T09:00' });
    assert.equal(presetRange('x', now), null);
    assert.ok(actionOptions('moved_to_recycle_bin').some(([v]) => v === 'moved_to_recycle_bin'));
    assert.equal(actionOptions('delete').filter(([v]) => v === 'delete').length, 1);
  });
});
