import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseDay, parseVolume } from '../src/admin/admin.js';
import { BatchError, identityKey, parseBatch } from '../src/ingest/batch.js';
import { sampleEvent } from './fixtures.js';

const batch = (events: unknown[]) => ({
  batch_id: '6F1C2A9E-3B7D-4E0A-9C55-2D8F1B7A4E10',
  agent_id: 'FS01',
  hostname: 'FS01',
  agent_version: '0.1.0',
  sent_at: '2026-10-01T14:05:10Z',
  events,
});

describe('parseBatch', () => {
  it('lê o formato enviado pelo agente', () => {
    const b = parseBatch(batch([sampleEvent]));
    assert.equal(b.batchId, '6f1c2a9e-3b7d-4e0a-9c55-2d8f1b7a4e10');
    assert.equal(b.hostname, 'FS01');
    assert.equal(b.events.length, 1);
    const e = b.events[0];
    assert.equal(e.recordId, '1001');
    assert.equal(e.accessMask, 2);
    assert.equal(e.success, true);
    assert.equal(e.time.toISOString(), '2026-10-01T14:03:22.123Z');
    assert.deepEqual(e.user, { name: 'joao.silva', domain: 'CORP', sid: 'S-1-5-21-1-2-3-1104', logonId: '0x3e7a1f' });
  });

  it('recusa lote sem batch_id ou sem events', () => {
    assert.throws(() => parseBatch({ events: [] }), BatchError);
    assert.throws(() => parseBatch({ batch_id: 'x', events: [] }), BatchError);
    assert.throws(() => parseBatch({ batch_id: '6f1c2a9e-3b7d-4e0a-9c55-2d8f1b7a4e10' }), BatchError);
    assert.throws(() => parseBatch([]), BatchError);
  });

  it('descarta só o evento malformado', () => {
    const b = parseBatch(batch([sampleEvent, { ...sampleEvent, time: 'ontem' }, { ...sampleEvent, outcome: 'ok' }]));
    assert.equal(b.events.length, 1);
    assert.deepEqual(
      b.rejected.map((r) => r.index),
      [1, 2],
    );
  });

  it('normaliza IP e máscara', () => {
    const [a, b, c, d] = parseBatch(
      batch([
        { ...sampleEvent, client_ip: '10.0.0.5' },
        { ...sampleEvent, client_ip: '::ffff:10.0.0.5' },
        { ...sampleEvent, client_ip: '-', access_mask: 'lixo' },
        { ...sampleEvent, client_ip: 'fe80::1%eth0', access_mask: '0x10000' },
      ]),
    ).events;
    assert.equal(a.clientIp, '10.0.0.5');
    assert.equal(b.clientIp, '::ffff:10.0.0.5');
    assert.equal(c.clientIp, null);
    assert.equal(c.accessMask, null);
    assert.equal(d.clientIp, null);
    assert.equal(d.accessMask, 0x10000);
  });

  it('identidade por SID ou DOMINIO\\usuario', () => {
    assert.equal(identityKey({ name: 'A', domain: 'D', sid: 'S-1-5-X', logonId: null }), 's-1-5-x');
    assert.equal(identityKey({ name: 'Joao', domain: 'CORP', sid: null, logonId: null }), 'corp\\joao');
  });
});

describe('admin', () => {
  it('parseVolume', () => {
    assert.equal(parseVolume('2TB'), 2n * 1024n ** 4n);
    assert.equal(parseVolume('500 gb'), 500n * 1024n ** 3n);
    assert.equal(parseVolume('1024'), 1024n);
    assert.throws(() => parseVolume('muito'));
  });

  it('parseDay usa o dia inteiro no horário de Brasília', () => {
    assert.equal(parseDay('2027-09-30', true).toISOString(), '2027-10-01T03:00:00.000Z');
    assert.equal(parseDay('2026-10-01', false).toISOString(), '2026-10-01T03:00:00.000Z');
  });
});
