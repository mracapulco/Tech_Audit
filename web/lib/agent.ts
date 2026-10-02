// Textos e regras da instalação do agente. Sem dependências, para testar com node --test.

// Quem pode baixar o instalador (mesma regra da API): a Tech Master e o
// administrador do cliente. O auditor do cliente só consulta.
export const canDownloadAgent = (role: string) => role === 'msp_admin' || role === 'msp_operator' || role === 'tenant_admin';

// Endereço que vai no campo "Endereço do servidor" do instalador.
export const agentServerUrl = (url: string) => url.trim().replace(/\/+$/, '');

// Instalação sem telas, para GPO ou script. O token vai entre aspas para o
// Prompt de Comando e o PowerShell não quebrarem caracteres como "-".
export function silentInstallCommand(fileName: string, serverUrl: string, token = 'ta_enr_...'): string {
  return `msiexec /i ${fileName} /qn ENDPOINT="${agentServerUrl(serverUrl)}" ENROLLMENT_TOKEN="${token}"`;
}
