// Textos e regras da tela de caminhos auditados. Sem dependências, para testar com node --test.

type Tone = 'ok' | 'warn' | 'bad' | 'neutral';

export const PATH_STATUS: Record<string, { label: string; tone: Tone; hint: string }> = {
  pending: { label: 'Aguardando o agente', tone: 'neutral', hint: 'O agente aplica na próxima consulta ao servidor (em até 2 minutos, se estiver online).' },
  applied: { label: 'Aplicado', tone: 'ok', hint: 'Auditoria configurada pelo agente (SACL no Windows; auditd e Samba no Linux).' },
  error: { label: 'Erro', tone: 'bad', hint: 'O agente não conseguiu aplicar. Veja a mensagem e use Reaplicar depois de corrigir.' },
  divergent: { label: 'Divergente', tone: 'warn', hint: 'A configuração real do servidor mudou (SACL removida ou GPO sobrescrevendo a política no Windows; regra do auditd ou smb.conf alterados no Linux).' },
  removing: { label: 'Removendo', tone: 'neutral', hint: 'O agente vai retirar a auditoria na próxima consulta.' },
  removed: { label: 'Removido', tone: 'neutral', hint: '' },
};
export const pathStatus = (s: string) => PATH_STATUS[s] ?? { label: s, tone: 'neutral' as const, hint: '' };

export const CHANGE_KIND: Record<string, { label: string; tone: Tone }> = {
  add: { label: 'Caminho adicionado', tone: 'neutral' },
  update: { label: 'Opções alteradas', tone: 'neutral' },
  remove: { label: 'Remoção pedida', tone: 'neutral' },
  reapply: { label: 'Reaplicação pedida', tone: 'neutral' },
  applied: { label: 'Aplicado pelo agente', tone: 'ok' },
  removed: { label: 'Removido pelo agente', tone: 'ok' },
  error: { label: 'Erro no agente', tone: 'bad' },
  divergent: { label: 'Divergência detectada', tone: 'warn' },
};
export const changeKind = (k: string) => CHANGE_KIND[k] ?? { label: k, tone: 'neutral' as const };

export const ALERT_TONE: Record<string, Tone> = { info: 'neutral', warning: 'warn', critical: 'bad' };

// Perfis que alteram a configuração; o auditor do cliente só consulta.
export const canEditConfig = (role: string) => role === 'msp_admin' || role === 'msp_operator' || role === 'tenant_admin';

// Situação do volume auditado contra o contratado.
export function volumeState(v: { percent: number | null; level: number; max_bytes: string }): { tone: Tone; label: string } {
  if (v.max_bytes === '0') return { tone: 'bad', label: 'Sem licença vigente' };
  if (v.level >= 100) return { tone: 'bad', label: 'Limite atingido: novos caminhos bloqueados' };
  if (v.level >= 80) return { tone: 'warn', label: 'Acima de 80% do contratado' };
  return { tone: 'ok', label: 'Dentro do contratado' };
}

// Largura da barra (0 a 100).
export const barWidth = (percent: number | null) => Math.max(0, Math.min(100, percent ?? 0));

// Opções do caminho em uma linha: "Subpastas · Leitura · 2 exclusões".
export function optionsSummary(p: { recursive: boolean; audit_read: boolean; exclusions: string[] }): string {
  const parts = [p.recursive ? 'Com subpastas' : 'Só a pasta', p.audit_read ? 'Inclui leitura' : 'Sem leitura'];
  if (p.exclusions.length) parts.push(`${p.exclusions.length} ${p.exclusions.length === 1 ? 'exclusão' : 'exclusões'}`);
  return parts.join(' · ');
}

// Servidor Linux pelo sistema informado pelo agente no registro.
export const isLinux = (os: string | null | undefined) => (os ?? '').toLowerCase().startsWith('linux');

// Aviso mostrado antes de qualquer alteração (docs/ARCHITECTURE.md, seção 4.6).
export const applyWarning = (path: string, host: string, os?: string | null) =>
  isLinux(os)
    ? `O agente vai adicionar regras do auditd para ${path} em ${host} e, se a pasta estiver num compartilhamento Samba, ligar o full_audit nele (o smb.conf original fica guardado). Isso aumenta o volume de log do servidor. Continuar?`
    : `O agente vai alterar a política de auditoria e a SACL de ${path} em ${host}. Isso aumenta o volume do log de Segurança do Windows. Continuar?`;

// Aviso antes de parar de auditar um caminho.
export const removeWarning = (path: string, host: string, os?: string | null) =>
  `Parar de auditar ${path} em ${host}? O agente retira ${isLinux(os) ? 'as regras do auditd e o full_audit do Samba que ele mesmo adicionou' : 'a auditoria que ele mesmo adicionou na SACL'}; os eventos já coletados continuam no histórico.`;

// Exemplo do campo de caminho e explicação do que o agente faz no servidor.
export const pathPlaceholder = (os?: string | null) => (isLinux(os) ? '/srv/dados/financeiro' : 'D:\\Dados\\Financeiro');

export const applyNotice = (os?: string | null) =>
  isLinux(os)
    ? 'O agente vai adicionar regras do auditd para esta pasta (acesso direto ao servidor) e, se ela estiver num compartilhamento Samba, ligar o módulo full_audit nesse compartilhamento (acesso pela rede, com o IP do computador). O smb.conf original fica guardado e é restaurado ao remover.'
    : 'O agente vai habilitar a auditoria de “Sistema de arquivos” no Windows e adicionar uma entrada de auditoria (SACL) nesta pasta, sem remover as que já existem. Isso aumenta o volume do log de Segurança do Windows.';
