import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { agentServerUrl, canDownloadAgent, linuxPackageCommand, linuxRegisterCommand, silentInstallCommand } from '../lib/agent.ts';

describe('instalação do agente', () => {
  it('perfis que baixam o instalador', () => {
    assert.ok(canDownloadAgent('msp_admin'));
    assert.ok(canDownloadAgent('tenant_admin'));
    assert.ok(!canDownloadAgent('tenant_auditor'));
  });

  it('endereço e comando silencioso', () => {
    assert.equal(agentServerUrl(' https://ingest-audit.techmaster.inf.br/ '), 'https://ingest-audit.techmaster.inf.br');
    assert.equal(
      silentInstallCommand('TechAuditAgent-0.3.0.msi', 'http://192.168.0.10:3101/', 'ta_enr_abc'),
      'msiexec /i TechAuditAgent-0.3.0.msi /qn ENDPOINT="http://192.168.0.10:3101" ENROLLMENT_TOKEN="ta_enr_abc"',
    );
  });

  it('comandos do Linux', () => {
    assert.equal(
      linuxRegisterCommand('https://ingest-audit.techmaster.inf.br/', 'ta_enr_abc'),
      "sudo techaudit-agent install -endpoint https://ingest-audit.techmaster.inf.br -enrollment-token 'ta_enr_abc'",
    );
    assert.equal(linuxPackageCommand('deb', 'techaudit-agent_0.4.0-1_amd64.deb'), 'sudo apt install ./techaudit-agent_0.4.0-1_amd64.deb');
    assert.equal(linuxPackageCommand('rpm', 'techaudit-agent-0.4.0-1.x86_64.rpm'), 'sudo yum install ./techaudit-agent-0.4.0-1.x86_64.rpm');
  });
});
