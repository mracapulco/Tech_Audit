import { inflateRawSync } from 'node:zlib';

// Exemplo do agent/README.md.
export const sampleEvent = {
  record_id: 1001,
  event_id: 4663,
  kind: 'object_access',
  time: '2026-10-01T14:03:22.1234567Z',
  computer: 'FS01.corp.local',
  user: { name: 'joao.silva', domain: 'CORP', sid: 'S-1-5-21-1-2-3-1104', logon_id: '0x3e7a1f' },
  path: 'D:\\Shares\\Financeiro\\Relatorios\\2026-09.xlsx',
  object_type: 'File',
  actions: ['write'],
  access_mask: '0x2',
  outcome: 'success',
  handle_id: '0x1a2c',
};

// Lê as entradas de um ZIP pelo diretório central (o bastante para o teste).
export function unzip(buf: Buffer): Map<string, string> {
  const files = new Map<string, string>();
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    files.set(name, inflateRawSync(buf.subarray(start, start + size)).toString('utf8'));
    p += 46 + nameLen + extra + comment;
  }
  return files;
}
