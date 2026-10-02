import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ago, health, labelIndexes, niceMax, userText } from '../lib/dashboard.ts';
import { actionGroups, eventActionText, newPathText, presetRange } from '../lib/filters.ts';

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
    const all = (sel: string) => actionGroups(sel).flatMap((g) => g.options);
    assert.ok(all('tipo_novo').some(([v]) => v === 'tipo_novo'));
    assert.equal(all('delete').filter(([v]) => v === 'delete').length, 1);
    assert.equal(actionGroups('').length, 2);
  });

  it('texto da ação do evento', () => {
    assert.equal(eventActionText({ action: 'recycled', actions: ['delete'] }), 'Enviado para a Lixeira');
    assert.equal(eventActionText({ action: 'created', actions: [], item_type: 'folder' }), 'Criação (pasta)');
    assert.equal(eventActionText({ action: 'permission_changed', actions: [], count: 1200 }), 'Alteração de permissão · 1.200 operações');
    assert.equal(eventActionText({ action: null, actions: ['write', 'delete'] }), 'Escrita (direito), Exclusão (direito)');
    assert.equal(eventActionText({ action: null, actions: [] }), '-');
  });

  it('destino do evento esconde o nome interno da Lixeira', () => {
    assert.equal(newPathText({ action: 'recycled', new_path: 'C:\\$Recycle.Bin\\S-1-5-21-1\\$RIUD4PU.txt' }), 'Lixeira do Windows');
    assert.equal(newPathText({ action: 'renamed', new_path: 'C:\\a\\b.txt' }), 'C:\\a\\b.txt');
    assert.equal(newPathText({ action: 'modified', new_path: null }), null);
  });
});
