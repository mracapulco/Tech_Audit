# Agente no Linux

O mesmo agente roda em servidores de arquivos Linux de 64 bits (x86-64):

| Família | Versões | Pacote |
|---|---|---|
| Ubuntu / Debian | Ubuntu 20.04, 22.04 e 24.04; Debian 11 e 12 | `.deb` |
| CentOS / Oracle Linux / Red Hat / Rocky / Alma | 7, 8 e 9 | `.rpm` |

O binário é estático (sem dependência da glibc), então o mesmo arquivo roda do
CentOS 7 ao Ubuntu 24.04. A coleta completa (auditd + Samba 4.19) foi testada
no Ubuntu 24.04; a instalação e remoção dos pacotes, no Debian 12, Ubuntu
20.04, Oracle Linux 9 e CentOS 7.

## De onde vêm os eventos

| Acesso | Fonte | O que traz |
|---|---|---|
| Direto no servidor (SSH, console, serviços com login) | **auditd** (`/var/log/audit/audit.log`) | usuário que fez login (mesmo depois de `sudo`), programa, caminho |
| Pela rede (compartilhamento Samba) | módulo **full_audit** do Samba, lido pelo journald | usuário, **IP do computador**, compartilhamento, caminho |

Os dois chegam ao portal com as mesmas ações do Windows (criou, alterou, leu,
renomeou, moveu, enviou para a Lixeira, excluiu, alterou permissão/dono, acesso
negado). No campo `kind` aparecem como `auditd` ou `samba`.

Serviços do sistema (inclusive o próprio Samba e o agente) não têm usuário de
login e ficam de fora da regra do auditd (`auid!=unset`): o acesso pela rede é
registrado só pelo full_audit, uma vez, com o usuário certo.

## O que o agente altera no servidor

Tudo é feito a partir dos **caminhos auditados** do portal, com um registro no
syslog (`journalctl -t techaudit-agent`), no log de alterações
(`/var/lib/techaudit/audit-changes.log`) e no histórico do portal:

- **auditd**: inicia o serviço se estiver parado e adiciona, para cada pasta,
  uma regra de gravação (`-k techaudit`) e, com "Auditar também leituras", uma
  de leitura (`-k techaudit-r`). As regras ficam também em
  `/etc/audit/rules.d/techaudit.rules`, para voltarem depois de reiniciar. Se o
  auditd for reiniciado e as regras sumirem, o agente recoloca na consulta
  seguinte.
- **Samba**: se a pasta está dentro de um compartilhamento, liga o
  `full_audit` nele, num bloco marcado `# >>> Tech Audit` no `smb.conf`. A
  primeira alteração guarda o original em `smb.conf.antes-techaudit`; o arquivo
  novo é conferido com `testparm` antes de gravar e o Samba relê a configuração
  (`smbcontrol smbd reload-config`). Vale para conexões novas: quem já estava
  conectado passa a ser auditado ao reconectar.
- Ao remover o caminho no portal (ou desinstalar o agente), as regras e o bloco
  do `smb.conf` são retirados e as linhas originais voltam.

Para não perder linhas em picos de acesso, o agente também cria
`/etc/systemd/system/smbd.service.d/techaudit-log.conf` (sem limite de
mensagens por segundo no journald). Isso vale a partir do próximo reinício do
Samba.

## Instalação

1. Baixe o pacote em **Instalar agente** no portal e copie para o servidor.
2. Instale (o auditd vem junto, do repositório da distribuição):

   ```
   sudo apt install ./techaudit-agent_0.4.0-1_amd64.deb
   ```

   ```
   sudo yum install ./techaudit-agent-0.4.0-1.x86_64.rpm
   ```

3. Registre o servidor com o token de instalação gerado no portal:

   ```
   sudo techaudit-agent install -endpoint https://ingest-audit.techmaster.inf.br -enrollment-token 'ta_enr_...'
   ```

   Isso grava `/etc/techaudit/agent.json` e inicia o serviço
   `techaudit-agent`. Acompanhe com `journalctl -u techaudit-agent -f`.

### Arquivos

| Caminho | Conteúdo |
|---|---|
| `/usr/bin/techaudit-agent` | o agente |
| `/usr/lib/systemd/system/techaudit-agent.service` | o serviço |
| `/etc/techaudit/agent.json` | configuração (endereço do servidor, filtros) |
| `/var/lib/techaudit/` | registro do servidor, buffer de eventos, estado e log de alterações |

### Atualizar e remover

- Atualizar: instale o pacote novo do mesmo jeito; o serviço reinicia sozinho.
- Remover: `sudo apt remove techaudit-agent` ou `sudo yum remove techaudit-agent`.
  O agente desfaz o que aplicou (auditd e Samba) e mantém configuração e
  dados. `sudo apt purge techaudit-agent` apaga também `/etc/techaudit` e
  `/var/lib/techaudit`.

## Limitações conhecidas

- **Criação de pasta** e **renomear** pelo auditd usam um mapa das pastas
  auditadas montado na partida e atualizado a cada 6 horas; com pastas muito
  grandes (milhões de subpastas) a primeira leitura demora. Caminhos que não
  puderem ser resolvidos aparecem com `details.path_unresolved`.
- Pastas com espaço no nome são auditadas, mas a regra não vai para
  `/etc/audit/rules.d/` (o formato do arquivo não aceita); depois de reiniciar o
  servidor o agente recoloca a regra na primeira consulta.
- O Samba informa o motivo de uma falha de forma imprecisa (o erro de acesso
  negado às vezes vem como "arquivo não encontrado"). O agente conta como
  "acesso negado" quando o item existe.
- Acesso por NFS não é registrado: o servidor NFS do kernel não tem usuário de
  login, e por isso fica fora da regra do auditd.
