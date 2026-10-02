import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clientIp } from '../lib/client-ip.ts';

describe('IP do usuário', () => {
  it('usa só o endereço acrescentado pelo proxy', () => {
    assert.equal(clientIp('203.0.113.9'), '203.0.113.9');
    // O navegador mandou "1.2.3.4"; o proxy acrescentou o IP real.
    assert.equal(clientIp('1.2.3.4, 203.0.113.9'), '203.0.113.9');
    assert.equal(clientIp(' 1.2.3.4 ,  ::1 '), '::1');
  });

  it('sem header, sem IP', () => {
    assert.equal(clientIp(null), undefined);
    assert.equal(clientIp(''), undefined);
  });
});
