import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { switchTarget, tenantParam, withTenant, workspaceTabs } from '../lib/workspace.ts';

const T = '3f2a9c1e-8b7d-4c6e-9a1b-2c3d4e5f6a7b';

describe('espaço da empresa', () => {
  it('abas por perfil', () => {
    const keys = (role: string, t: boolean) => workspaceTabs(role, t).map((x) => x.key);
    assert.deepEqual(keys('msp_admin', true), ['painel', 'eventos', 'relatorios', 'servidores', 'alertas', 'usuarios', 'licenca']);
    assert.deepEqual(keys('msp_operator', true), ['painel', 'eventos', 'relatorios', 'servidores', 'alertas']);
    assert.deepEqual(keys('tenant_admin', true), ['painel', 'eventos', 'relatorios', 'servidores', 'alertas']);
    assert.deepEqual(keys('msp_admin', false), ['painel', 'eventos', 'relatorios']);
  });

  it('empresa da URL, aceitando o nome antigo', () => {
    assert.equal(tenantParam({ cliente: T }), T);
    assert.equal(tenantParam({ empresa: T }), T);
    assert.equal(tenantParam({ cliente: 'x' }), '');
    assert.equal(tenantParam({}), '');
  });

  it('links com a empresa', () => {
    assert.equal(withTenant('/servidores', T), `/servidores?cliente=${T}`);
    assert.equal(withTenant('/painel', ''), '/painel');
    assert.equal(withTenant('/eventos', T, { caminho: 'D:\\x', usuario: '' }), `/eventos?cliente=${T}&caminho=D%3A%5Cx`);
  });

  it('trocar de empresa mantém a aba quando dá', () => {
    assert.equal(switchTarget('/servidores', 'msp_admin', T), `/servidores?cliente=${T}`);
    assert.equal(switchTarget('/servidores/historico', 'msp_admin', T), `/servidores?cliente=${T}`);
    assert.equal(switchTarget('/servidores', 'msp_admin', ''), '/painel');
    assert.equal(switchTarget('/eventos', 'msp_admin', ''), '/eventos');
    assert.equal(switchTarget('/admin/limpeza', 'msp_admin', T), `/painel?cliente=${T}`);
  });
});
