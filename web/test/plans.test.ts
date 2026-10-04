import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planSummary, retentionLabel } from '../lib/plans.ts';

describe('planos', () => {
  it('resume retenção e leitura do plano', () => {
    assert.equal(planSummary('Essencial'), 'Retenção padrão de 90 dias; sem auditoria de leitura.');
    assert.equal(planSummary('Enterprise'), 'Retenção padrão de 5 anos; inclui auditoria de leitura.');
    assert.equal(planSummary('Antigo'), 'Plano fora da lista: todos os recursos liberados.');
  });

  it('retenção em anos quando fecha', () => {
    assert.deepEqual([retentionLabel(365), retentionLabel(730), retentionLabel(400)], ['1 ano', '2 anos', '400 dias']);
  });
});
