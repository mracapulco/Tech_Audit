import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { folderBadge, groupByFolder, permApiQuery, permFilters, permScreenQuery, scanText, type PermRow } from '../lib/permissions.ts';

const T = '3f2a9c1e-8b7d-4c6e-9a1b-2c3d4e5f6a7b';
const A = '11111111-2222-4333-8444-555555555555';

const row = (folder: string, principal: string | null, extra: Partial<PermRow> = {}): PermRow => ({
  agent_id: A,
  hostname: 'FS01',
  audited_path_id: T,
  audited_path: 'D:\\Dados',
  folder_path: folder,
  depth: 0,
  source: 'ntfs',
  share: null,
  owner: null,
  protected: false,
  reason: 'root',
  folder_error: null,
  principal,
  sid: null,
  kind: 'group',
  access: 'allow',
  rights: 'Modificar',
  raw: null,
  inherited: false,
  applies_to: null,
  is_new: false,
  ...extra,
});

describe('inventário de permissões', () => {
  it('filtros da tela viram parâmetros da API', () => {
    const f = permFilters({ servidor: A, caminho: 'x', busca: ' financeiro ', proprias: '1' });
    assert.deepEqual(f, { servidor: A, caminho: '', busca: 'financeiro', proprias: true, negacoes: false });
    assert.equal(permApiQuery(f, T), `tenant=${T}&agent=${A}&q=financeiro&explicit=1`);
    assert.equal(permScreenQuery(f, '', { formato: 'xlsx' }), `servidor=${A}&busca=financeiro&proprias=1&formato=xlsx`);
  });

  it('agrupa por pasta, separando o compartilhamento', () => {
    const g = groupByFolder([
      row('D:\\Dados', 'CORP\\Financeiro'),
      row('D:\\Dados', 'BUILTIN\\Administradores'),
      row('D:\\Dados', 'Todos', { source: 'share', share: 'Dados', reason: 'share' }),
      row('D:\\Dados\\RH', null, { reason: 'error', folder_error: 'acesso negado' }),
    ]);
    assert.equal(g.length, 3);
    assert.equal(g[0].rows.length, 2);
    assert.equal(folderBadge(g[1]).label, 'Compartilhamento Dados');
    assert.equal(g[2].rows.length, 0);
    assert.equal(g[2].error, 'acesso negado');
    assert.equal(folderBadge({ source: 'ntfs', share: null, reason: 'protected', protected: true }).label, 'Herança desligada');
  });

  it('resume a coleta', () => {
    assert.equal(scanText(null).label, 'Aguardando a primeira coleta');
    const s = { id: T, status: 'complete', started_at: '', finished_at: '', folders_scanned: 1200, folders_recorded: 15, truncated: false, error: null };
    assert.deepEqual(scanText(s), { label: 'Coletado', tone: 'ok', detail: '1.200 pasta(s) lida(s), 15 no inventário' });
    assert.equal(scanText({ ...s, truncated: true }).label, 'Coleta parcial');
    assert.equal(scanText({ ...s, status: 'error', error: 'não encontrado' }).detail, 'não encontrado');
  });
});
