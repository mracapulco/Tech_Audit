# Tech Audit — servidor central

API NestJS que registra os agentes e recebe os eventos de auditoria
(docs/ARCHITECTURE.md, seções 5, 6 e 9).

| Rota | Quem chama | O que faz |
|---|---|---|
| `GET /api/health` | monitoramento | Status do servidor e do banco |
| `POST /v1/enroll` | agente, na primeira execução | Troca o token de registro por `agent_id` + token do agente, se a licença permitir |
| `POST /v1/events` | agente | Recebe um lote (JSON, normalmente gzip) com `Authorization: Bearer <token do agente>` |
| `POST /api/auth/login` | portal | E-mail e senha; devolve o token da sessão (12 h) |
| `POST /api/auth/logout`, `GET /api/auth/me` | portal | Encerra a sessão / usuário logado |
| `GET /api/tenants` | portal | Clientes visíveis para o usuário |
| `GET /api/events` | portal | Pesquisa de eventos (filtros abaixo), paginada por cursor |
| `GET /api/events/export.csv` | portal | Mesmos filtros, em CSV |
| `GET /api/dashboard` | portal | Painel: totais, gráfico, ações, rankings, destaques, agentes e licença (mesmos filtros) |
| `GET /api/reports/{usuarios,pastas,periodo,eventos}` | portal | Relatórios; `format=json` (padrão), `xlsx` ou `pdf` |
| `/api/admin/...` | portal, só `msp_admin` | Empresas, licenças, tokens de instalação, agentes e usuários |

As rotas do portal usam `Authorization: Bearer <token da sessão>`; o portal
Next.js guarda o token em cookie `httpOnly` e faz as chamadas pelo servidor.

## Banco

- Tabelas relacionais no schema `public`, pelo Prisma (`prisma/schema.prisma`):
  tenants, licenças, tokens de registro, agentes, ativações, lotes recebidos e
  os dicionários `paths` e `identities`.
- Eventos em `events.file_events`, hypertable do TimescaleDB criada com SQL
  nativo (`src/db/events-migrations.ts`), fora do Prisma. A gravação usa o
  driver `pg` direto, com `INSERT ... SELECT unnest(...)` em lote.

```sh
cp .env.example .env
npm install && npm run build
npm run db:migrate   # prisma migrate deploy + migrations do schema events
npm run start        # http://localhost:3001
```

## Usuários do portal pela linha de comando

```sh
# Equipe Tech Master (vê todos os clientes)
npm run -s cli -- user:create --email rafael@techmaster.inf.br --name "Rafael" --role msp_admin
# Usuário do cliente (só vê o próprio tenant)
npm run -s cli -- user:create --email ti@cliente.com.br --name "TI Cliente" --role tenant_auditor --tenant <tenant_id>
# Nova senha (encerra as sessões abertas)
npm run -s cli -- user:password --email ti@cliente.com.br
```

O normal é cadastrar pela tela Usuários do portal; a CLI fica para
emergências (ex.: `docker compose exec server node dist/cli.js user:password --email ...`).
Na subida do contêiner, `admin:bootstrap` cria o primeiro administrador com
`BOOTSTRAP_ADMIN_EMAIL` e `BOOTSTRAP_ADMIN_PASSWORD` se ainda não houver nenhum.

Sem `--password`, a CLI gera uma senha e a mostra uma única vez. Perfis:
`msp_admin`, `msp_operator` (Tech Master, sem `--tenant`), `tenant_admin`,
`tenant_auditor` (cliente, com `--tenant`). Senhas com Argon2id, mínimo de 10
caracteres; 5 senhas erradas seguidas no mesmo e-mail e IP bloqueiam por 15 minutos.

## Pesquisa de eventos

`GET /api/events?from=&to=&user=&path=&action=&tenant=&limit=&cursor=`

- `from`/`to`: ISO 8601; padrão, os últimos 7 dias.
- `user`: trecho de `DOMINIO\usuario` ou o SID exato, sem diferenciar maiúsculas.
- `path`: prefixo do caminho (inclui subpastas), sem diferenciar maiúsculas.
- `action`: `read`, `write`, `append`, `execute`, `delete`, `delete_child`,
  `write_attributes`, `permission_change`, `owner_change`, ou qualquer tipo
  novo que o agente passe a enviar (letras minúsculas, números e `_`).
- `tenant`: só para a equipe Tech Master; usuário de cliente recebe `403` se
  pedir outro tenant.
- `limit` (1 a 200, padrão 50) e `cursor` (`next_cursor` da página anterior).
  Paginação por cursor (keyset), do mais recente para o mais antigo.

O CSV usa `;`, UTF-8 com BOM e horário de Brasília, para abrir direto no Excel,
e para em 100 mil linhas (`EXPORT_MAX_ROWS`). Pesquisas (primeira página),
exportações, logins e logouts ficam em `portal_audit_log`.

## Painel e relatórios

`/api/dashboard` e `/api/reports/:tipo` aceitam os mesmos filtros da pesquisa e
o mesmo escopo por tenant. Os relatórios agrupados trazem uma coluna por tipo
de ação encontrado no resultado, então tipos novos do agente aparecem sem
mudança no servidor (com o próprio nome até ganharem rótulo em
`src/reports/table.ts` e `web/lib/filters.ts`). O período usa intervalos de
hora (até 2 dias), dia (até 120 dias) ou mês, no horário de Brasília.

Limites por formato: tela 500 linhas agrupadas ou 200 eventos; Excel 20 mil
linhas agrupadas ou `EXPORT_MAX_ROWS` eventos; PDF 5 mil linhas. O Excel é
gerado sem dependências (`src/reports/xlsx.ts`), com datas reais e filtro
automático; o PDF usa `pdfkit`, A4 paisagem. Visualizações (`reports.view`) e
exportações (`reports.export`) ficam em `portal_audit_log`.

## Registrar um agente (até o portal existir)

```sh
npm run -s cli -- tenant:create --name "Cliente X"
npm run -s cli -- license:create --tenant <tenant_id> --max-agents 3 --max-volume 2TB --valid-until 2027-09-30
npm run -s cli -- token:create --tenant <tenant_id> --ttl-hours 24 --max-uses 1
```

O último comando mostra o `token` (`ta_enr_...`) uma única vez. Coloque-o em
`enrollment_token` no `agent.json`, com `endpoint` apontando para
`http://<servidor>:3001/v1/events`. Para testar sem Windows:

```sh
cd ../agent
cat internal/event/testdata/*.xml > /tmp/export.xml
go run ./cmd/agent -config agent.json -replay /tmp/export.xml
```

`npm run -s cli -- agent:disable --agent <agent_id>` desativa um agente e libera a vaga.

## Regras implementadas

- **Registro**: token de registro válido (não vencido, não revogado, com usos
  restantes) e licença **vigente**. Cada agente ativo ocupa uma vaga; a mesma
  máquina (`machine_id`) reinstalada reaproveita a vaga e recebe um token novo
  (o antigo deixa de valer). Registros do mesmo tenant são serializados para a
  contagem de vagas não correr.
- **Ingestão**: aceita enquanto a licença estiver vigente ou na tolerância de
  1 dia após o vencimento; depois disso responde `403` e o agente segura o
  lote e tenta de novo a cada minuto. Volume contratado não bloqueia ingestão
  (seção 9.2).
- **Idempotência**: um `batch_id` repetido é confirmado sem regravar; eventos
  repetidos em outro lote são ignorados pelo índice único
  `(agent_id, source_record_id, time)`. A resposta `200` é o ACK que faz o
  agente avançar o bookmark.
- **Eventos malformados** são descartados individualmente (contados em
  `rejected`), para um evento ruim não travar o agente reenviando o mesmo lote.
- **Integridade**: cada lote recebido grava o SHA-256 do conteúdo em `ingest_batches`.

Resposta de `POST /v1/events`:

```json
{ "batch_id": "...", "duplicate_batch": false, "received": 200, "inserted": 198, "duplicates": 2, "rejected": 0 }
```

## Download do instalador do agente

`GET /api/agent/installer` (versão, tamanho, SHA-256) e
`GET /api/agent/installer/download` entregam o MSI mais novo da pasta
`AGENT_DOWNLOADS_DIR` (padrão `downloads/`). Na imagem Docker o MSI é compilado
de `agent/` durante o `docker compose build`; rodando com npm, use
`AGENT_DOWNLOADS_DIR=../agent/dist` depois de `make msi`. Só Tech Master e
administrador do cliente baixam, e cada download entra no `portal_audit_log`
(`agent.download`).

## Testes

`npm test` roda os testes unitários e, com `DATABASE_URL` definido e
`npm run db:migrate` aplicado, os testes de ponta a ponta contra PostgreSQL +
TimescaleDB (o CI usa a imagem `timescale/timescaledb:latest-pg17`).

## Ainda não implementado

mTLS (hoje o agente usa token de longa duração, guardado só como hash),
Row Level Security, inventário com o volume auditado, heartbeat, configuração
remota, MFA (TOTP) no login e exportação assíncrona de
relatórios grandes.
