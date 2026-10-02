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
