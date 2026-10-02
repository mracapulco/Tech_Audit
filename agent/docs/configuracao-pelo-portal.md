# Caminhos auditados configurados pelo portal

Em vez de configurar SACLs à mão ou por GPO (veja [auditoria-gpo.md](auditoria-gpo.md)),
os caminhos auditados podem ser cadastrados no portal, em **Caminhos auditados**.
O agente aplica sozinho (docs/ARCHITECTURE.md, seção 4.6).

## O que o agente faz

A cada 2 minutos (`audit_config.interval`) o agente consulta `GET /v1/config`.
Para cada caminho com alteração pendente:

1. Lê a SACL atual da pasta e a política de **Sistema de arquivos** (`File System`)
   do `auditpol`.
2. Se a política não estiver com sucesso e falha, habilita (API
   `AuditSetSystemPolicy`, pelo GUID da subcategoria, independente do idioma do
   Windows) e guarda a política original.
3. Acrescenta à SACL a entrada de auditoria do Tech Audit, **sem remover as
   que já existiam**:

   | Opção no portal | Entrada (SDDL) |
   |---|---|
   | Com subpastas, sem leitura (padrão) | `(AU;OICISAFA;0xd0156;;;WD)` |
   | Com subpastas, com leitura | `(AU;OICISAFA;0xd0157;;;WD)` |
   | Sem subpastas | `(AU;OINPSAFA;...;;;WD)` (a pasta e os arquivos dela) |

   A máscara cobre escrita, acréscimo, atributos, exclusão, alteração de
   permissão e de dono (mais leitura, se marcada), para Todos (`WD`), sucesso e falha.
4. Lê a SACL de novo e envia o antes e o depois para `POST /v1/config/result`.
5. Grava a alteração no log local e no log **Application** do Windows
   (origem `TechAuditAgent`, ID 1000 para informação, 1001 para erro/divergência).

Na **remoção**, o agente retira só a entrada que ele adicionou. Se a mesma
entrada já existia antes do Tech Audit, ela fica. Quando não sobra nenhum
caminho auditado, a política de Sistema de arquivos volta ao que era.

A cada 30 minutos (`audit_config.verify_interval`) o agente confere se a
entrada continua na SACL e se a política continua ligada. Se não, informa
**divergente** e o portal gera alerta. O agente **não reaplica sozinho**
(evita brigar com uma GPO); use **Reaplicar** no portal depois de resolver.

## Tamanho das pastas (licença)

A cada 6 horas (`audit_config.size_interval`), e logo depois de uma
alteração, o agente soma o tamanho dos arquivos de cada caminho
(recursivamente) em baixa prioridade de disco e envia em `POST /v1/config/sizes`.
Caminhos aninhados são medidos na mesma varredura e o servidor não os conta
duas vezes. Links simbólicos e junções não são seguidos.

## Arquivos no servidor

| Arquivo | Conteúdo |
|---|---|
| `C:\ProgramData\TechAudit\audit-config-state.json` | O que o agente aplicou em cada caminho e a SACL original (para reverter à mão se preciso) |
| `C:\ProgramData\TechAudit\audit-changes.log` | Uma linha JSON por alteração, só acréscimo. Cada linha traz o hash da anterior: editar ou apagar uma linha quebra a corrente |

## Requisitos

- Rodar como **SYSTEM** ou administrador: alterar SACL e política exige o
  privilégio `SeSecurityPrivilege`.
- Se uma GPO define a política avançada de auditoria, ela prevalece na próxima
  atualização de política (90 minutos). Nesse caso, configure a GPO com
  **Audit File System: Success, Failure** ou o caminho ficará divergente.
- Para desligar a sincronização e manter a configuração manual:
  `"audit_config": { "disabled": true }` no `agent.json`.
