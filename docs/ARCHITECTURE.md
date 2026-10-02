# Tech Audit: Arquitetura e Stack

> Status: **proposta para revisão** (rascunho v0.1, 2026-10-02)
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
| Deploy | **Docker Compose** + Traefik | Mesmo modelo do Tech_Hub. Migração para Kubernetes só quando necessário. |
| Observabilidade | Logs JSON + Prometheus/Grafana (ou o próprio Zabbix da Tech Master) | |

### Alternativas consideradas

- **ClickHouse para eventos**: excelente para volumes muito altos e consultas analíticas, mas adiciona um segundo banco para operar. TimescaleDB atende bem até centenas de milhões de eventos por cliente e mantém tudo no PostgreSQL. Reavaliar se a ingestão passar de ~50 mil eventos/s sustentados.
- **Agente em C#/.NET**: integração nativa com Windows, mas exige runtime (ou self-contained de ~70 MB) e não serve tão bem para Linux.
- **Kafka/NATS no lugar de Redis**: superdimensionado para o início.

## 4. Agente

### 4.1 Responsabilidades

1. **Eventos de arquivo** (contínuo): ler o log de Segurança do Windows em tempo real.
2. **Inventário** (periódico, ex.: a cada 6 h e sob demanda): compartilhamentos, permissões de compartilhamento e NTFS das pastas raiz e até N níveis, volumes e espaço, tamanho por pasta.
3. **Verificação de configuração de auditoria**: confirmar que a política de auditoria e as SACLs estão aplicadas e reportar ao servidor quando não estiverem (o portal exibe alerta "auditoria desativada em D:\Dados").
4. **Heartbeat** a cada 60 s com versão, uso de CPU/memória do agente, tamanho do buffer e atraso de leitura.
5. **Autoatualização** a partir de pacotes assinados publicados pelo servidor.

### 4.2 Coleta no Windows

Fonte principal: **Security Event Log**, via `EvtSubscribe` (Windows Event Log API) com **bookmark** persistido, para retomar exatamente de onde parou após reinício.

Pré-requisitos no servidor do cliente (o agente pode aplicar ou apenas validar, decisão em aberto):

- Advanced Audit Policy: **Audit File System** (sucesso, opcionalmente falha), **Audit Detailed File Share** (opcional, gera muito volume), **Audit File Share**, **Audit Authorization Policy Change**.
- **SACL** nas pastas auditadas (ex.: `Everyone` com Create/Write/Delete/Change Permissions/Take Ownership; leitura opcional por pasta, pois multiplica o volume).

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

- Pacote **MSI** (WiX) ou instalador silencioso: `TechAuditAgent.msi SERVER=https://audit.techmaster.com.br TOKEN=xxxx /qn`.
- Executa como serviço `TechAuditAgent` com conta `LocalSystem` (necessário para ler o log de Segurança). Avaliar conta virtual com o privilégio `SeSecurityPrivilege` como alternativa de menor privilégio.
- Configuração local mínima (URL do servidor e certificado); o restante é **configuração remota** puxada do servidor (pastas monitoradas, filtros, intervalos).
- Binário e MSI **assinados** com certificado de code signing da Tech Master (evita bloqueio por antivírus e SmartScreen).

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

- Hierarquia: **Tenant** (empresa cliente) → **Site** (filial/unidade) → **Agent/Server** → **Share/Volume**.
- Toda tabela de dados tem `tenant_id`. Toda consulta do portal passa pelo filtro de tenant na camada de serviço **e** por **Row Level Security** no PostgreSQL (`SET app.tenant_id` por transação), como defesa em profundidade.
- Perfis de acesso:
  - `msp_admin` / `msp_operator` (equipe Tech Master, acesso a todos os tenants)
  - `tenant_admin` (gerencia usuários e configurações da empresa)
  - `tenant_auditor` (consulta e relatórios, somente leitura)
  - Escopo opcional por site ou share (ex.: auditor do RH vê só `\\srv\RH`).
- Autenticação do portal: e-mail + senha com **MFA (TOTP)** no MVP; SSO (Entra ID / Google) em fase posterior.

### 6.3 Modelo de dados (resumo)

Relacional (gerenciado pelo Prisma):

- `tenants`, `sites`, `users`, `user_roles`, `agents` (status, versão, último heartbeat, certificado), `enrollment_tokens`
- `shares`, `volumes`, `acl_snapshots` (inventário com histórico)
- `identities` (SID, `DOMAIN\user`, nome, e-mail, departamento; dicionário por tenant)
- `paths` (dicionário de caminhos: `id`, `tenant_id`, `agent_id`, `path_hash`, `path`, `parent_id`), para não repetir strings longas em cada evento
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

- **Retenção** por plano do cliente (ex.: 90 dias, 1 ano, 5 anos) via `drop_chunks` em job agendado por tenant, ou `add_retention_policy` global com exclusão complementar por tenant.
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
- **Inventário**: compartilhamentos, permissões efetivas, espaço utilizado, histórico de mudanças de ACL.
- **Relatórios**: exportação CSV/XLSX/PDF gerada de forma assíncrona (job no worker, arquivo no MinIO, link por e-mail). Relatórios agendados (ex.: semanal de exclusões).
- **Alertas** (fase 2): exclusão em massa, renomeação em massa com extensões suspeitas, alteração de permissão em pastas sensíveis, log de segurança limpo, agente offline.
- **Área da Tech Master** (MSP): gestão de tenants, tokens de registro, versões de agente, saúde da plataforma.

## 8. Segurança e LGPD

- TLS 1.2+ em todo tráfego; mTLS para agentes.
- Segredos fora do repositório (`.env` no servidor, ou Docker secrets).
- Senhas com Argon2id; MFA obrigatório para perfis MSP.
- Logs de eventos contêm dados pessoais (nomes de usuários, nomes de arquivos, IPs): definir **base legal** (legítimo interesse/segurança), contrato de operador de dados com cada cliente, retenção por contrato e capacidade de exportar/excluir dados de um tenant.
- `portal_audit_log` registra todas as consultas e exportações feitas no portal.
- Backups diários do PostgreSQL (pgBackRest) com teste de restauração periódico; cópia fora do servidor principal.
- Integridade: hash por lote recebido gravado junto com os eventos, permitindo provar que os registros não foram alterados (útil se o relatório for usado como evidência).

## 9. Estrutura do repositório (monorepo)

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

## 10. Roadmap sugerido

| Fase | Entrega |
|---|---|
| **0. Fundação** | Monorepo, Docker Compose (Postgres+Timescale, Redis, MinIO), CI, autenticação do portal, cadastro de tenants e sites. |
| **1. Agente mínimo** | Serviço Windows em Go, registro com token, heartbeat, leitura de 4663/4660/4670 com bookmark, buffer SQLite, envio em lote. |
| **2. MVP do portal** | Pesquisa de eventos, linha do tempo de arquivo/usuário, dashboard, exportação CSV. Piloto em 1 cliente para medir volume real. |
| **3. Inventário e relatórios** | Shares, ACLs, espaço em disco, relatórios PDF agendados, validação da política de auditoria. |
| **4. Alertas** | Regras de anomalia (exclusão/renomeação em massa), notificações por e-mail/Teams/WhatsApp. |
| **5. Produção** | mTLS completo, autoatualização assinada, MSI assinado, retenção por plano, SSO. |
| **6. Linux** | Coletor Samba `full_audit` e auditd. |

## 11. Decisões em aberto (para o Rafael)

1. **Auditoria de leitura**: habilitar por padrão ou só em pastas escolhidas? (impacto grande no volume)
2. **Configuração da auditoria no cliente**: o agente aplica a política e as SACLs automaticamente, ou apenas valida e a equipe aplica via GPO?
3. **Autenticação do agente no protótipo**: começar direto com mTLS ou com token de longa duração e migrar na fase 5?
4. **Retenção padrão** e planos comerciais (90 dias / 1 ano / 5 anos?).
5. **Hospedagem**: servidor físico/VM na Tech Master ou nuvem? Afeta backup e escalabilidade.
6. **Integração com Tech_Hub**: compartilhar login/tenants com o Tech_Hub ou manter o Tech Audit independente?
7. **Domínio** do portal e da API dos agentes (ex.: `audit.techmaster.com.br` e `ingest.audit.techmaster.com.br`).
