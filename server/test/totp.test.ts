import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { base32Decode, base32Encode, codeAt, generateSecret, otpauthUrl, stepAt, verifyCode } from '../src/auth/totp.js';

// Segredo do apêndice B da RFC 6238 ("12345678901234567890").
const RFC = base32Encode(Buffer.from('12345678901234567890'));

describe('TOTP', () => {
  it('confere com os vetores da RFC 6238 (SHA-1, 6 últimos dígitos)', () => {
    assert.equal(RFC, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    assert.equal(codeAt(RFC, stepAt(59_000)), '287082');
    assert.equal(codeAt(RFC, stepAt(1111111109_000)), '081804');
    assert.equal(codeAt(RFC, stepAt(1234567890_000)), '005924');
    assert.equal(codeAt(RFC, stepAt(2000000000_000)), '279037');
  });

  it('base32 ida e volta', () => {
    const s = generateSecret();
    assert.equal(s.length, 32);
    assert.equal(base32Encode(base32Decode(s)), s);
  });

  it('aceita o código atual e o vizinho, recusa os outros', () => {
    const now = 1_800_000_000_000;
    const step = stepAt(now);
    assert.equal(verifyCode(RFC, codeAt(RFC, step), null, now), step);
    assert.equal(verifyCode(RFC, codeAt(RFC, step - 1), null, now), step - 1);
    assert.equal(verifyCode(RFC, codeAt(RFC, step + 1), null, now), step + 1);
    assert.equal(verifyCode(RFC, codeAt(RFC, step - 2), null, now), null);
    assert.equal(verifyCode(RFC, '12345', null, now), null);
    assert.equal(verifyCode(RFC, 'abcdef', null, now), null);
  });

  it('não aceita o mesmo código duas vezes', () => {
    const now = 1_800_000_000_000;
    const step = stepAt(now);
    assert.equal(verifyCode(RFC, codeAt(RFC, step), step, now), null);
    assert.equal(verifyCode(RFC, codeAt(RFC, step - 1), step, now), null);
  });

  it('link do QR code', () => {
    const u = otpauthUrl('ABC', 'rafael@techmaster.inf.br');
    assert.equal(u, 'otpauth://totp/Tech%20Audit%3Arafael%40techmaster.inf.br?secret=ABC&issuer=Tech+Audit&algorithm=SHA1&digits=6&period=30');
  });
});
