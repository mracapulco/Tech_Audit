import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { acceptsIngestion, evaluateLicenses, LicenseTerms } from '../src/licensing/license.js';

const lic = (o: Partial<LicenseTerms> = {}): LicenseTerms => ({
  id: 'l1',
  maxAgents: 3,
  maxVolumeBytes: 2n * 1024n ** 4n,
  validFrom: new Date('2026-10-01T03:00:00Z'),
  validUntil: new Date('2027-10-01T03:00:00Z'),
  graceDays: 1,
  revokedAt: null,
  ...o,
});

describe('evaluateLicenses', () => {
  it('licença vigente', () => {
    const s = evaluateLicenses([lic()], new Date('2027-01-01T00:00:00Z'));
    assert.equal(s.status, 'active');
    assert.equal(s.maxAgents, 3);
    assert.ok(acceptsIngestion(s));
  });

  it('tolerância de 1 dia após o vencimento', () => {
    const s = evaluateLicenses([lic()], new Date('2027-10-02T02:59:59Z'));
    assert.equal(s.status, 'grace');
    assert.ok(acceptsIngestion(s));
    assert.equal(s.graceUntil?.toISOString(), '2027-10-02T03:00:00.000Z');
  });

  it('vencida depois da tolerância', () => {
    const s = evaluateLicenses([lic()], new Date('2027-10-02T03:00:00Z'));
    assert.equal(s.status, 'expired');
    assert.equal(s.maxAgents, 0);
    assert.ok(!acceptsIngestion(s));
  });

  it('sem licença, licença futura ou revogada não contam', () => {
    const now = new Date('2027-01-01T00:00:00Z');
    assert.equal(evaluateLicenses([], now).status, 'none');
    assert.equal(evaluateLicenses([lic({ validFrom: new Date('2027-06-01T00:00:00Z') })], now).status, 'none');
    assert.equal(evaluateLicenses([lic({ revokedAt: now })], now).status, 'none');
  });

  it('soma os limites das licenças vigentes', () => {
    const s = evaluateLicenses(
      [lic(), lic({ id: 'l2', maxAgents: 2, maxVolumeBytes: 1024n, validUntil: new Date('2028-01-01T00:00:00Z') })],
      new Date('2027-01-01T00:00:00Z'),
    );
    assert.equal(s.maxAgents, 5);
    assert.equal(s.maxVolumeBytes, 2n * 1024n ** 4n + 1024n);
    assert.equal(s.validUntil?.toISOString(), '2028-01-01T00:00:00.000Z');
  });

  it('uma licença vigente prevalece sobre outra em tolerância', () => {
    const s = evaluateLicenses(
      [lic({ validUntil: new Date('2026-12-31T12:00:00Z') }), lic({ id: 'l2' })],
      new Date('2027-01-01T00:00:00Z'),
    );
    assert.equal(s.status, 'active');
    assert.equal(s.maxAgents, 6);
  });
});
