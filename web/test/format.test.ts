import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { agentConfig, defaultLicenseDates, formatBytes, formatDate, formatLastDay, licenseStatus, roleLabel } from '../lib/format.ts';

describe('formatação da administração', () => {
  it('tamanhos em base 1024', () => {
    assert.equal(formatBytes(String(2 * 1024 ** 4)), '2 TB');
    assert.equal(formatBytes(1536 * 1024 ** 3), '1,5 TB');
    assert.equal(formatBytes(0), '0 B');
  });

  it('datas em Brasília e último dia da vigência', () => {
    assert.equal(formatDate('2026-10-01T02:00:00Z'), '30/09/2026');
    // valid_until de "2027-09-30" é 2027-10-01T03:00Z (24:00 em Brasília).
    assert.equal(formatLastDay('2027-10-01T03:00:00.000Z'), '30/09/2027');
    assert.equal(formatDate(null), '-');
  });

  it('nova licença: hoje até um ano menos um dia', () => {
    assert.deepEqual(defaultLicenseDates(new Date('2026-10-02T12:00:00Z')), { from: '2026-10-02', until: '2027-10-01' });
  });

  it('rótulos', () => {
    assert.equal(roleLabel('msp_admin'), 'Administrador');
    assert.equal(roleLabel('tenant_auditor'), 'Cliente');
    assert.equal(licenseStatus('grace').label, 'Em tolerância');
  });

  it('configuração do agente com o token', () => {
    const c = JSON.parse(agentConfig('https://ingest.exemplo.com.br/', 'ta_enr_x'));
    assert.equal(c.endpoint, 'https://ingest.exemplo.com.br/v1/events');
    assert.equal(c.enrollment_token, 'ta_enr_x');
  });
});
