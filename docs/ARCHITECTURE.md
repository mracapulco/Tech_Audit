# Tech Audit: Arquitetura e Stack

> Status: **proposta para revisão** (v0.3, 2026-10-02: decisões do Rafael sobre caminhos, aplicação da auditoria, independência do produto, licenciamento, retenção, hospedagem e domínios)
> Responsável: Rafael (Tech Master)

## 1. Objetivo

Tech Audit é uma plataforma de auditoria de servidores de arquivos, com funcionamento semelhante ao Zabbix:

- **Agentes** instalados nos servidores de arquivos dos clientes (Windows primeiro, Linux depois) coletam eventos e inventário.
- Um **servidor central** com **banco de dados**, hospedado na infraestrutura da Tech Master, recebe, armazena e processa os dados.
- Um **portal web multi-tenant** permite que cada cliente consulte apenas os dados da própria empresa: quem fez o quê, em qual caminho e em qual período, além de relatórios e visão geral da saúde dos servidores de arquivos.

### Perguntas que o produto precisa responder

1. Quem criou, leu, alterou, renomeou, moveu ou excluiu `\\srv01\Financeiro\2026\...` entre as datas X e Y?
2. O que o usuário `joao.silva` fez nos servidores de arquivos na última semana?
3. Quem alterou as permissões (ACL) de uma pasta?
4. Quais compartilhamentos existem, quem tem acesso a eles e quanto espaço ocupam?
5. Houve comportamento anômalo, como exclusão em massa ou renomeação em massa (indício de ransomware)?

### Fora do escopo do MVP

- Bloqueio ativo de ações (o produto audita, não impede).
- Versionamento ou backup de arquivos.
- Leitura do conteúdo dos arquivos (DLP).

## 2. Visão geral

```
        Cliente A (rede interna)                      Tech Master (datacenter / nuvem)
 ┌───────────────────────────────────┐        ┌──────────────────────────────────────────────┐
 │ Servidor de arquivos Windows      │        │  Reverse proxy (Traefik/Nginx, TLS, mTLS)    │
 │  ┌─────────────────────────────┐  │ HTTPS  │        │                     │               │
 │  │ Tech Audit Agent (Go)       │──┼──443──▶│  Ingest API            Portal Web (Next.js)  │
 │  │  - Event Log (Security)     │  │ mTLS   │  (NestJS)                   │                │
 │  │  - Inventário (shares/ACL)  │  │        │        │               Core API (NestJS)     │
 │  │  - Buffer local (SQLite)    │  │        │        ▼                     │                │
 │  └─────────────────────────────┘  │        │   Redis (filas BullMQ)       │                │
 └───────────────────────────────────┘        │        │                     │                │
                                              │        ▼                     ▼                │
        Cliente B ...                         │   Workers (normalização, relatórios, alertas) │
                                              │        │                                      │
                                              │        ▼                                      │
                                              │   PostgreSQL 16 + TimescaleDB                 │
                                              │   Object storage (relatórios gerados, S3/MinIO)│
                                              └──────────────────────────────────────────────┘
```

Princípios:

- **Somente conexões de saída a partir do cliente.** O agente fala HTTPS na porta 443 com o servidor central. Nenhuma porta precisa ser aberta na rede do cliente (diferença importante em relação ao modo passivo do Zabbix).
- **O agente é burro e resiliente; o servidor é inteligente.** O agente coleta, filtra o ruído óbvio, armazena em buffer e envia. Correlação, enriquecimento e regras ficam no servidor, onde podem evoluir sem atualizar agentes.
- **Isolamento por tenant em todas as camadas** (token/certificado do agente, API, banco com Row Level Security).

## 3. Stack proposta

| Camada | Escolha | Motivo |
|---|---|---|
| Agente | **Go**, executável único, serviço Windows | Binário estático sem runtime, baixo consumo, bom suporte a APIs Win32 (`golang.org/x/sys/windows`), compila também para Linux. |
| Ingest API | **NestJS** (Node 22, Fastify adapter) | Mesma stack do Tech_Hub; Fastify para throughput. Pode ser extraída para Go se o volume exigir. |
| Core API | **NestJS** | Autenticação, tenants, consultas, relatórios. |
| Portal | **Next.js** (App Router) + Tailwind + shadcn/ui | Mesma stack do Tech_Hub. |
| ORM | **Prisma** para dados relacionais | Mesma stack do Tech_Hub. A tabela de eventos fica fora do caminho do Prisma (ver seção 6.3). |
| Banco | **PostgreSQL 16 + TimescaleDB** | Hypertables, compressão nativa (10x a 20x), políticas de retenção e agregados contínuos sem adicionar outro banco. |
| Filas | **Redis + BullMQ** | Desacopla ingestão de processamento, jobs de relatório e alertas. |
| Arquivos gerados | **MinIO** (S3 compatível) | PDFs/CSVs de relatórios, pacotes do agente. |
| Deploy | **Docker Compose** + Traefik, na infraestrutura da Tech Master | Decisão: hospedado dentro da Tech Master, em containers Docker. Mesmo modelo do Tech_Hub. Migração para Kubernetes só quando necessário. |
| Observabilidade | Logs JSON + Prometheus/Grafana (ou o próprio Zabbix da Tech Master) | |

### Alternativas consideradas

- **ClickHouse para eventos**: excelente para volumes muito altos e consultas analíticas, mas adiciona um segundo banco para operar. TimescaleDB atende bem até centenas de milhões de eventos por cliente e mantém tudo no PostgreSQL. Reavaliar se a ingestão passar de ~50 mil eventos/s sustentados.
- **Agente em C#/.NET**: integração nativa com Windows, mas exige runtime (ou self-contained de ~70 MB) e não serve tão bem para Linux.
- **Kafka/NATS no lugar de Redis**: superdimensionado para o início.

## 4. Agente

### 4.1 Responsabilidades

1. **Eventos de arquivo** (contínuo): ler o log de Segurança do Windows em tempo real.
2. **Inventário** (periódico, ex.: a cada 6 h e sob demanda): compartilhamentos, permissões de compartilhamento e NTFS das pastas raiz e até N níveis, volumes e espaço, tamanho por pasta e **tamanho total de cada caminho auditado** (usado no licenciamento, seção 9.2).
3. **Aplicação e verificação da auditoria**: aplicar a política de auditoria e as SACLs nos caminhos definidos pelo portal, registrar cada alteração e reportar ao servidor quando a configuração estiver ausente ou divergente (o portal exibe alerta "auditoria desativada em D:\Dados"). Detalhes na seção 4.6.
4. **Heartbeat** a cada 60 s com versão, uso de CPU/memória do agente, tamanho do buffer e atraso de leitura.
5. **Autoatualização** a partir de pacotes assinados publicados pelo servidor.

### 4.2 Coleta no Windows

Fonte principal: **Security Event Log**, via `EvtSubscribe` (Windows Event Log API) com **bookmark** persistido, para retomar exatamente de onde parou após reinício.

Pré-requisitos no servidor do cliente (aplicados pelo próprio agente, com alerta e log, conforme a seção 4.6):

- Advanced Audit Policy: **Audit File System** (sucesso, opcionalmente falha), **Audit Detailed File Share** (opcional, gera muito volume), **Audit File Share**, **Audit Authorization Policy Change**.
- **SACL** nos caminhos auditados (ex.: `Everyone` com Create/Write/Delete/Change Permissions/Take Ownership; leitura opcional por caminho, pois multiplica o volume).

Eventos coletados:

| Event ID | Significado | Uso |
|---|---|---|
| 4656 | Handle solicitado para objeto | Correlacionar com 4663 pelo `HandleId` |
| 4663 | Tentativa de acesso a objeto | Ação principal (leitura, escrita, exclusão, append) via `AccessMask` |
| 4660 | Objeto excluído | Confirma exclusão (correlacionar com 4663 pelo `HandleId`) |
| 4658 | Handle fechado | Fecha a correlação |
| 4670 | Permissões do objeto alteradas | Alteração de ACL (SDDL antes/depois) |
| 5140 | Compartilhamento acessado | IP de origem e usuário por sessão SMB |
| 5145 | Verificação detalhada de acesso ao compartilhamento | Caminho relativo e IP de origem (opcional) |
| 4624 / 4634 | Logon / logoff | Contexto de sessão (opcional) |
| 1102 | Log de auditoria limpo | Alerta de segurança |

Normalização no agente (redução de ruído antes do envio):

- Correlacionar 4656/4663/4660/4658 pelo `HandleId` + `ProcessId` para produzir **uma ação lógica** (`create`, `read`, `write`, `delete`, `rename`, `move`, `acl_change`, `owner_change`).
- Detectar **rename/move** quando o mesmo handle tem `DELETE` no caminho antigo e o caminho novo aparece em seguida.
- Descartar ruído conhecido: arquivos temporários do Office (`~$*`, `*.tmp`), `desktop.ini`, `Thumbs.db`, acessos de contas de sistema/antivírus/backup (lista configurável por tenant).
- **Deduplicar leituras** repetidas do mesmo usuário no mesmo arquivo em uma janela (ex.: 5 min), mantendo contagem.

Os eventos brutos não são enviados por padrão; o agente envia o evento normalizado, preservando `record_id` e `event_id` de origem para rastreabilidade.

Evolução futura: driver minifilter ou ETW (`Microsoft-Windows-Kernel-File`) para maior precisão e menos dependência de SACL. Fica fora do MVP por exigir assinatura de driver e mais risco operacional.

### 4.3 Coleta no Linux (fase futura)

- **Samba** com módulo VFS `full_audit` (melhor opção para compartilhamentos SMB, já traz usuário e IP do cliente).
- **auditd** (regras `-w /dados -p wa`) ou **fanotify** para acessos locais e NFS.
- O mesmo binário Go, com coletores diferentes por plataforma (`collector_windows.go`, `collector_linux.go`).

### 4.4 Buffer local e envio

- Fila local em **SQLite** (modo WAL) no diretório do agente. Limite configurável (padrão 2 GB); ao atingir, descarta leituras antes de escritas/exclusões e reporta a perda.
- Envio em **lotes** (até 5.000 eventos ou 5 s), corpo **Protobuf** (ou JSON) comprimido com **zstd/gzip**.
- Cada lote tem `batch_id` (UUID) e sequência; o servidor é **idempotente** e confirma (ACK) o lote. O agente apaga do buffer somente após o ACK.
- Retry com backoff exponencial e jitter. Funciona offline por dias sem perder dados.

### 4.5 Instalação e operação

- Pacote **MSI** (WiX) ou instalador silencioso: `TechAuditAgent.msi SERVER=https://audit.techmaster.inf.br TOKEN=xxxx /qn`.
- Executa como serviço `TechAuditAgent` com conta `LocalSystem` (necessário para ler o log de Segurança). Avaliar conta virtual com o privilégio `SeSecurityPrivilege` como alternativa de menor privilégio.
- Configuração local mínima (URL do servidor e certificado); o restante é **configuração remota** puxada do servidor (caminhos auditados, filtros, intervalos).
- Binário e MSI **assinados** com certificado de code signing da Tech Master (evita bloqueio por antivírus e SmartScreen).

### 4.6 Caminhos auditados e aplicação automática da auditoria

**Decisão:** os caminhos auditados são definidos **pelo portal web**, e tanto o cliente (`tenant_admin`) quanto a Tech Master (`msp_admin`/`msp_operator`) podem adicionar, alterar ou remover caminhos a qualquer momento. O agente aplica a configuração sozinho, mas **toda aplicação gera alerta e fica registrada em log**.

Configuração por caminho (tabela `audited_paths`):

| Campo | Exemplo |
|---|---|
| Servidor (agente) | `SRV-ARQ01` |
| Caminho | `D:\Dados\Financeiro` (o portal sugere a partir do inventário de shares e pastas) |
| Recursivo | sim (herança da SACL para subpastas e arquivos) |
| Ações auditadas | criar, escrever, excluir, alterar permissão, alterar dono |
| Auditar leitura | não (padrão); habilitar só onde for necessário, por causa do volume |
| Exclusões | `*.tmp`, `~$*`, subpastas específicas |
| Status | pendente, aplicado, erro, divergente, removendo |

Fluxo de uma alteração:

1. Um usuário adiciona, altera ou remove um caminho no portal. Antes de salvar, o portal mostra um **aviso explícito**: "O agente vai alterar a política de auditoria e a SACL de `D:\Dados\Financeiro` em `SRV-ARQ01`. Isso aumenta o volume do log de Segurança do Windows." O usuário confirma.
2. O servidor grava a solicitação em `audit_config_changes` (status `pendente`) e incrementa a **versão da configuração** do agente.
3. O agente consulta a configuração a cada 2 minutos (`GET /v1/config`) e, para cada caminho com alteração pendente:
   - lê e guarda a SACL atual (SDDL "antes") e o estado atual do `auditpol`;
   - habilita as subcategorias necessárias (`auditpol /set /subcategory:"File System" /success:enable`, ou API `AuditSetSystemPolicy`);
   - adiciona a ACE de auditoria à SACL (`SetNamedSecurityInfo` com `SACL_SECURITY_INFORMATION`), **sem remover ACEs que já existiam**;
   - lê de novo e envia o resultado (SDDL "depois", sucesso ou erro) para `POST /v1/config/result`.
   - o tamanho de cada caminho vai em `POST /v1/config/sizes` (seção 9.2).
4. O agente escreve também um evento no log **Application** do Windows (origem `TechAuditAgent`), para que o administrador local veja a mudança mesmo sem acessar o portal.
5. O servidor atualiza o status, gera um **alerta** "Configuração de auditoria alterada em SRV-ARQ01" visível no portal e (quando houver envio de e-mail) avisa por **e-mail** os administradores do tenant e a Tech Master.
6. Na **remoção**, o agente retira apenas a ACE que ele adicionou e restaura a política anterior quando nenhum outro caminho precisa dela. A SDDL original guardada no passo 3 permite reverter manualmente se necessário.

Verificação contínua: a cada ciclo de inventário o agente compara a configuração real com a esperada. Se a SACL foi removida, ou se uma **GPO sobrescreve** o `auditpol`, o caminho fica com status `divergente` e o portal gera alerta. O agente **não briga com a GPO** (reaplicar a cada 90 minutos geraria ruído); ele reporta o conflito para a equipe resolver.

Log de alterações (`audit_config_changes`, somente inserção, nunca atualizado ou excluído pela aplicação):

- quem solicitou (usuário do portal, perfil, IP), quando, agente, caminho, tipo (adicionar/alterar/remover/reaplicar);
- SACL e política antes e depois, resultado e mensagem de erro;
- exibido no portal em **Configuração > Histórico de alterações** e exportável em relatório.

## 5. Comunicação e autenticação do agente

Proposta: **token de registro + mTLS**, combinando a facilidade do token com a segurança do certificado.

1. No portal, um administrador da Tech Master (ou do cliente) gera um **token de registro** vinculado ao tenant e ao site, com validade curta (ex.: 24 h) e uso limitado.
2. Na primeira execução, o agente gera um par de chaves localmente (a chave privada não sai da máquina; protegida via DPAPI) e envia um **CSR** junto com o token para `POST /v1/enroll`.
3. O servidor valida o token, registra o agente (`agent_id`) e devolve um **certificado de cliente** assinado pela CA interna do Tech Audit, com `agent_id` e `tenant_id` no certificado. Validade de 90 dias, **renovação automática** aos 2/3 da validade.
4. Todas as chamadas seguintes (`/v1/events`, `/v1/inventory`, `/v1/heartbeat`, `/v1/config`) usam **mTLS**. O reverse proxy valida o certificado e repassa a identidade ao Ingest API; o tenant é **derivado do certificado**, nunca do corpo da requisição.
5. Revogação: desativar o agente no portal invalida o certificado (lista de revogação consultada pelo Ingest API).

Alternativa mais simples para o primeiro protótipo: token de agente de longa duração (hash armazenado no banco) no header `Authorization`. O protocolo de registro é o mesmo, então a troca para mTLS não muda o agente de forma significativa.

## 6. Servidor central

### 6.1 Serviços

| Serviço | Função |
|---|---|
| `ingest-api` | Recebe lotes dos agentes, valida, grava no Redis/Postgres e responde ACK. Sem lógica de negócio pesada. |
| `core-api` | API do portal: autenticação, tenants, usuários, agentes, consultas de eventos, inventário, relatórios. |
| `worker` | Consome filas: enriquecimento (SID para nome/departamento via AD sincronizado pelo agente), detecção de anomalias, geração de relatórios, envio de e-mails. |
| `web` | Portal Next.js. |
| `postgres` | PostgreSQL + TimescaleDB. |
| `redis` | Filas e cache. |
| `minio` | Arquivos de relatórios e pacotes de atualização. |

No início, `ingest-api`, `core-api` e `worker` podem ser **um único monorepo NestJS com três entrypoints**, compartilhando módulos.

### 6.2 Multi-tenancy

- **Produto independente:** o Tech Audit tem identidade, usuários, tenants e cobrança próprios. Não compartilha login nem banco com o Tech_Hub. Integrações futuras, se existirem, serão por API.
- Hierarquia: **Tenant** (empresa cliente) → **Site** (filial/unidade) → **Agent/Server** → **Share/Volume** → **Caminho auditado**.
- Toda tabela de dados tem `tenant_id`. Toda consulta do portal passa pelo filtro de tenant na camada de serviço **e** por **Row Level Security** no PostgreSQL (`SET app.tenant_id` por transação), como defesa em profundidade.
- Perfis de acesso:
  - `msp_admin` / `msp_operator` (equipe Tech Master, acesso a todos os tenants)
  - `tenant_admin` (gerencia usuários, configurações e caminhos auditados da empresa)
  - `tenant_auditor` (consulta e relatórios, somente leitura)
  - Escopo opcional por site ou share (ex.: auditor do RH vê só `\\srv\RH`).
- Autenticação do portal: e-mail + senha com **MFA (TOTP)** no MVP; SSO (Entra ID / Google) em fase posterior.

### 6.3 Modelo de dados (resumo)

Relacional (gerenciado pelo Prisma):

- `tenants`, `sites`, `users`, `user_roles`, `agents` (status, versão, último heartbeat, certificado), `enrollment_tokens`
- `shares`, `volumes`, `acl_snapshots` (inventário com histórico)
- `identities` (SID, `DOMAIN\user`, nome, e-mail, departamento; dicionário por tenant)
- `paths` (dicionário de caminhos: `id`, `tenant_id`, `agent_id`, `path_hash`, `path`, `parent_id`), para não repetir strings longas em cada evento
- `audited_paths` (caminhos auditados por agente, com opções e status; seção 4.6)
- `audit_config_changes` (log imutável de alterações de auditoria aplicadas pelo agente; seção 4.6)
- `licenses`, `license_activations`, `license_usage`, `installer_downloads` (licenciamento e distribuição; seção 9)
- `report_definitions`, `report_runs`, `alert_rules`, `alerts`
- `portal_audit_log` (quem consultou o quê no portal; o auditor também é auditado)

Séries temporais (TimescaleDB, SQL nativo em migrations dedicadas, fora do Prisma):

```sql
CREATE TABLE file_events (
  time         timestamptz NOT NULL,
  tenant_id    uuid        NOT NULL,
  agent_id     uuid        NOT NULL,
  path_id      bigint      NOT NULL,
  new_path_id  bigint,              -- rename/move
  identity_id  bigint      NOT NULL,
  action       smallint    NOT NULL, -- create, read, write, delete, rename, move, acl_change...
  result       smallint    NOT NULL, -- success / failure
  source_ip    inet,
  process_name text,
  count        int         NOT NULL DEFAULT 1, -- leituras deduplicadas
  source_record_id bigint,
  details      jsonb               -- ex.: SDDL antes/depois em acl_change
);
SELECT create_hypertable('file_events', by_range('time', INTERVAL '1 day'));
CREATE INDEX ON file_events (tenant_id, path_id, time DESC);
CREATE INDEX ON file_events (tenant_id, identity_id, time DESC);
ALTER TABLE file_events SET (timescaledb.compress, timescaledb.compress_segmentby = 'tenant_id, agent_id');
SELECT add_compression_policy('file_events', INTERVAL '7 days');
```

- **Retenção** por licença: opções padrão de 90 dias, 1 ano e 5 anos, ou **valor personalizado** em dias informado pelo `msp_admin`. Aplicada via `drop_chunks` em job agendado por tenant, ou `add_retention_policy` global com exclusão complementar por tenant.
- **Agregados contínuos** (eventos por hora por tenant/agent/ação/usuário) para dashboards rápidos.
- **Ingestão** via `COPY`/insert em lote com o driver `pg` direto, não com o Prisma (o Prisma é lento para inserções massivas e não entende hypertables). Consultas pesadas de eventos também usam SQL direto (`$queryRaw` ou Kysely).
- Busca por caminho: prefixo (`path LIKE '\\srv\Financeiro\%'`) usando índice `text_pattern_ops` em `paths.path`, ou `ltree` se a navegação em árvore ficar central.

### 6.4 Estimativa de volume (a validar em cliente piloto)

| Perfil | Eventos/dia após filtro | Armazenamento/ano (comprimido) |
|---|---|---|
| Pequeno (20 usuários, sem auditoria de leitura) | ~50 mil | ~1 a 2 GB |
| Médio (200 usuários, com leitura) | ~2 milhões | ~30 a 60 GB |
| Grande (1.000+ usuários, com leitura) | ~20 milhões | ~300 a 600 GB |

Estimativa baseada em ~100 a 200 bytes por evento antes da compressão e taxa de compressão de 10x. Um servidor único com PostgreSQL e disco NVMe atende dezenas de clientes médios.

## 7. Portal web

Funcionalidades do MVP:

- **Dashboard** do tenant: agentes online/offline, eventos por dia, top usuários, top pastas, alertas recentes, status da configuração de auditoria.
- **Pesquisa de eventos**: filtros por período, servidor, compartilhamento, caminho (com subpastas), usuário, ação, resultado, IP. Paginação por cursor (keyset), nunca `OFFSET`.
- **Linha do tempo de um arquivo/pasta** e **linha do tempo de um usuário**.
- **Caminhos auditados**: escolher servidor e caminho (a partir do inventário), opções de auditoria, status de aplicação e histórico de alterações (seção 4.6).
- **Inventário**: compartilhamentos, permissões efetivas, espaço utilizado, histórico de mudanças de ACL.
- **Relatórios**: exportação CSV/XLSX/PDF gerada de forma assíncrona (job no worker, arquivo no MinIO, link por e-mail). Relatórios agendados (ex.: semanal de exclusões).
- **Alertas** (fase 2): exclusão em massa, renomeação em massa com extensões suspeitas, alteração de permissão em pastas sensíveis, log de segurança limpo, agente offline.
- **Área da Tech Master** (MSP): gestão de tenants, licenças, tokens de registro, downloads do instalador, versões de agente, saúde da plataforma.

## 8. Segurança e LGPD

- TLS 1.2+ em todo tráfego; mTLS para agentes.
- Segredos fora do repositório (`.env` no servidor, ou Docker secrets).
- Senhas com Argon2id; MFA obrigatório para perfis MSP.
- Logs de eventos contêm dados pessoais (nomes de usuários, nomes de arquivos, IPs): definir **base legal** (legítimo interesse/segurança), contrato de operador de dados com cada cliente, retenção por contrato e capacidade de exportar/excluir dados de um tenant.
- `portal_audit_log` registra todas as consultas e exportações feitas no portal.
- Backups diários do PostgreSQL (pgBackRest) com teste de restauração periódico; cópia fora do servidor principal.
- Integridade: hash por lote recebido gravado junto com os eventos, permitindo provar que os registros não foram alterados (útil se o relatório for usado como evidência).

## 9. Licenciamento e controle de distribuição

**Decisão:** o Tech Audit é um produto novo da Tech Master, e precisamos controlar quem instala o agente, em quantos servidores e por quanto tempo.

### 9.1 Onde o controle realmente acontece

Como o servidor central roda na Tech Master, **o servidor é o ponto de controle**. Um agente sozinho não faz nada: ele só funciona depois de registrado em um tenant com licença válida. Copiar o instalador não dá acesso a nada sem um token de registro, e o token só é aceito se houver licença disponível. Isso é mais forte do que qualquer proteção dentro do binário, que sempre pode ser contornada.

### 9.2 Licença

Cada tenant tem uma ou mais licenças (`licenses`), criadas apenas por `msp_admin`. **Decisão:** o licenciamento é baseado em **número de servidores** e **volume de dados**.

| Campo | Exemplo |
|---|---|
| Plano | Essencial / Profissional / Enterprise |
| Limite de servidores (agentes ativos) | 3 |
| Volume de dados contratado (soma do tamanho dos diretórios auditados nos servidores do cliente) | 2 TB |
| Retenção de dados | 90 dias, 1 ano, 5 anos ou personalizado (em dias) |
| Módulos | relatórios agendados, alertas, inventário de ACL |
| Validade | 2026-10-01 a 2027-09-30 |
| Período de tolerância após o vencimento | 1 dia |

Regras:

- **Registro de agente**: `POST /v1/enroll` só é aceito se o tenant tiver licença vigente e vaga disponível. Cada agente registrado ocupa uma vaga (`license_activations`, com `agent_id`, hostname, `machine_id` e data). Desativar um agente no portal libera a vaga.
- **Identificação da máquina**: o agente envia um `machine_id` estável (ex.: `MachineGuid` do Windows combinado com o UUID do SMBIOS, em hash). Um mesmo agente reinstalado na mesma máquina reaproveita a vaga; um certificado copiado para outra máquina é detectado e bloqueado.
- **Volume de dados**: é a **soma do tamanho dos diretórios auditados** em todos os servidores do tenant (arquivos e subpastas, recursivamente). O agente mede o tamanho de cada caminho auditado no ciclo de inventário (varredura com `FindFirstFileEx` em modo `FIND_FIRST_EX_LARGE_FETCH`, em baixa prioridade de I/O; nos ciclos seguintes pode usar o USN Journal do NTFS para atualizar sem varrer tudo de novo) e envia o total ao servidor. Caminhos aninhados não são contados duas vezes.
  - Ao **cadastrar um caminho** no portal, o tamanho estimado é mostrado e o portal **impede salvar** se o total passar do contratado (o `msp_admin` pode liberar manualmente).
  - Se os diretórios já auditados **crescerem** além do limite, a auditoria **continua** (para não abrir buracos na trilha de auditoria): aos 80% o portal e o e-mail avisam o cliente e a Tech Master, aos 100% gera alerta de excedente para upgrade ou cobrança adicional, e novos caminhos ficam bloqueados até ajustar a licença.
  - O bloqueio da ingestão acontece só por vencimento da licença.
- **Vencimento**: a tolerância é de **1 dia**. O portal avisa com antecedência (30, 7 e 1 dia antes) por banner e e-mail. Durante a tolerância, tudo funciona e o portal exibe aviso. Depois dela, o servidor deixa de aceitar eventos (o agente continua armazenando em buffer, dentro do limite) e o portal fica somente leitura. **Os dados não são apagados** no vencimento; a exclusão segue o contrato e a LGPD. Renovar a licença retoma a ingestão, e o agente envia o que estava no buffer.
- **Uso medido**: o servidor registra diariamente agentes ativos, volume dos diretórios auditados, eventos recebidos e espaço ocupado no banco por tenant (`license_usage`), base para faturamento e para detectar uso acima do contratado.

### 9.3 Distribuição do instalador

- Um único **MSI genérico, assinado** com o certificado de code signing da Tech Master. O instalador não contém segredos.
- O download só acontece **pelo portal autenticado** (Tech Master e administrador do cliente; o auditor do cliente não baixa), registrado no log de acesso do portal (`portal_audit_log`, ação `agent.download`: quem, quando, versão, hash, IP).
- O MSI tem um **assistente em português** que pede o endereço do servidor e o token; a mesma tela do portal mostra o endereço a digitar e o SHA-256 do arquivo.
- O **token de registro** é gerado pela Tech Master na página da empresa (validade curta, número máximo de usos). Ao gerar, o portal mostra o token, o endereço do servidor e o comando de instalação silenciosa já com o token.
- Os tokens podem ser revogados a qualquer momento, e cada uso fica registrado.
- O agente valida o certificado do servidor contra a **CA do Tech Audit embutida no binário** (pinning). Assim ele não pode ser apontado para um servidor não autorizado.
- O heartbeat envia a versão e o hash do binário. Versões não assinadas, adulteradas ou muito antigas aparecem no portal MSP e podem ser bloqueadas.

### 9.4 Sem versão on-premises

**Decisão:** não haverá versão on-premises. O servidor roda só na Tech Master, então o controle de licença fica todo no servidor central e não é necessário arquivo de licença.

### 9.5 Proteção do código

- Repositório privado com licença proprietária (`LICENSE` "Todos os direitos reservados, Tech Master").
- Contratos com clientes proibindo engenharia reversa e redistribuição do agente.
- Ofuscação do binário não é prioridade: o controle real está no servidor (9.1).

## 10. Estrutura do repositório (monorepo)

```
Tech_Audit/
├── agent/                  # Go: agente (Windows/Linux)
│   ├── cmd/techaudit-agent/
│   ├── internal/collector/ # windows/, linux/
│   ├── internal/buffer/
│   ├── internal/transport/
│   └── installer/          # WiX (MSI)
├── apps/
│   ├── api/                # NestJS: core-api, ingest-api e worker (entrypoints separados)
│   └── web/                # Next.js: portal
├── packages/
│   ├── proto/              # contrato agente ↔ servidor (Protobuf), gera Go e TS
│   └── shared/             # tipos e utilitários TS
├── prisma/                 # schema Prisma + migrations SQL do TimescaleDB
├── deploy/
│   ├── docker-compose.yml
│   └── traefik/
└── docs/
```

Ferramentas: pnpm workspaces + Turborepo para a parte TypeScript; `go` modules no `agent/`; GitHub Actions para lint, testes, build das imagens Docker e build/assinatura do agente.

## 11. Roadmap sugerido

| Fase | Entrega |
|---|---|
| **0. Fundação** | Monorepo, Docker Compose (Postgres+Timescale, Redis, MinIO), CI, autenticação do portal, cadastro de tenants, sites e licenças (limite de agentes e validade). |
| **1. Agente mínimo** | Serviço Windows em Go, registro com token validado contra a licença, heartbeat, leitura de 4663/4660/4670 com bookmark, buffer SQLite, envio em lote. |
| **2. MVP do portal** | Pesquisa de eventos, linha do tempo de arquivo/usuário, dashboard, exportação CSV, cadastro de caminhos auditados com aplicação automática de SACL, alerta e histórico de alterações. Piloto em 1 cliente para medir volume real. |
| **3. Inventário e relatórios** | Shares, ACLs, espaço em disco, relatórios PDF agendados, detecção de divergência e conflito com GPO. |
| **4. Alertas** | Regras de anomalia (exclusão/renomeação em massa), notificações por e-mail/Teams/WhatsApp. |
| **5. Produção** | mTLS completo, autoatualização assinada, MSI assinado com download controlado pelo portal, vencimento e tolerância de licença, medição de uso, retenção por plano, SSO. |
| **6. Linux** | Coletor Samba `full_audit` e auditd. |

## 12. Decisões

### Tomadas (Rafael, 2026-10-02)

1. **Caminhos auditados**: definidos pelo portal web; cliente e Tech Master podem adicionar e remover caminhos a qualquer momento. Auditoria de leitura é opção por caminho, desligada por padrão (seção 4.6).
2. **Configuração da auditoria no cliente**: o agente aplica a política e as SACLs sozinho, com aviso antes, alerta depois e log imutável de todas as alterações (seção 4.6).
3. **Tech_Hub**: o Tech Audit é um produto independente, sem login ou tenants compartilhados (seção 6.2).
4. **Licenciamento**: controle de distribuição e licença por tenant, aplicados no servidor, com limite por **número de servidores** e **volume de dados** (soma do tamanho dos diretórios auditados) e **1 dia** de tolerância após o vencimento (seção 9).
5. **Retenção**: opções padrão de 90 dias, 1 ano e 5 anos, mais valor personalizado em dias (seções 6.3 e 9.2).
6. **Hospedagem**: dentro da Tech Master, em Docker (seção 3).
7. **On-premises**: não haverá (seção 9.4).
8. **Domínios**: `audit.techmaster.inf.br` (portal) e `ingest.audit.techmaster.inf.br` (agentes).
9. **Autenticação do agente**: token de longa duração durante o desenvolvimento e o piloto; migração para mTLS (certificado por agente, seção 5) antes da venda para clientes (fase 5).

Não há decisões de arquitetura em aberto no momento.
