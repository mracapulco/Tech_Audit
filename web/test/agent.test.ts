import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { agentServerUrl, canDownloadAgent, silentInstallCommand } from '../lib/agent.ts';

describe('instalação do agente', () => {
  it('perfis que baixam o instalador', () => {
    assert.ok(canDownloadAgent('msp_admin'));
    assert.ok(canDownloadAgent('tenant_admin'));
    assert.ok(!canDownloadAgent('tenant_auditor'));
  });

  it('endereço e comando silencioso', () => {
    assert.equal(agentServerUrl(' https://ingest.audit.techmaster.inf.br/ '), 'https://ingest.audit.techmaster.inf.br');
    assert.equal(
      silentInstallCommand('TechAuditAgent-0.3.0.msi', 'http://192.168.0.10:3101/', 'ta_enr_abc'),
      'msiexec /i TechAuditAgent-0.3.0.msi /qn ENDPOINT="http://192.168.0.10:3101" ENROLLMENT_TOKEN="ta_enr_abc"',
    );
  });
});
