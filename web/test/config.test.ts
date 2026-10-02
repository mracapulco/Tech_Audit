import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyWarning, barWidth, canEditConfig, optionsSummary, pathStatus, volumeState } from '../lib/config.ts';

describe('tela de caminhos auditados', () => {
  it('situação do volume', () => {
    assert.equal(volumeState({ percent: 50, level: 0, max_bytes: '100' }).tone, 'ok');
    assert.equal(volumeState({ percent: 85, level: 80, max_bytes: '100' }).tone, 'warn');
    assert.match(volumeState({ percent: 120, level: 100, max_bytes: '100' }).label, /bloqueados/);
    assert.equal(volumeState({ percent: null, level: 0, max_bytes: '0' }).label, 'Sem licença vigente');
    assert.equal(barWidth(150), 100);
    assert.equal(barWidth(null), 0);
  });

  it('perfis e textos', () => {
    assert.ok(canEditConfig('tenant_admin'));
    assert.ok(!canEditConfig('tenant_auditor'));
    assert.equal(pathStatus('applied').label, 'Aplicado');
    assert.equal(pathStatus('xyz').label, 'xyz');
    assert.equal(optionsSummary({ recursive: true, audit_read: false, exclusions: ['*.tmp'] }), 'Com subpastas · Sem leitura · 1 exclusão');
    assert.match(applyWarning('D:\\Dados', 'SRV01'), /SACL de D:\\Dados em SRV01/);
  });
});
