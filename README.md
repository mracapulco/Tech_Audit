# Tech Audit

Plataforma de auditoria de servidores de arquivos (Windows, futuramente Linux) da Tech Master.

## Estrutura

| Pasta | Conteúdo |
| --- | --- |
| `server/` | API central e ingestão dos agentes (NestJS + Prisma) |
| `agent/` | Agente instalado nos servidores de arquivos (Go) |
| `web/` | Portal do cliente (Next.js) |
| `docker-compose.yml` | Sistema completo (banco, API e portal); veja [docs/DEPLOY.md](docs/DEPLOY.md) |

## Subir tudo com Docker

```bash
cp .env.example .env    # senhas e e-mail do primeiro administrador
docker compose up -d --build
# portal em http://localhost:3000, API dos agentes em http://localhost:3001
```

Detalhes e produção em [docs/DEPLOY.md](docs/DEPLOY.md).

## Desenvolvendo

Requisitos: Node.js 22.12+, Go 1.24+, Docker.

```bash
docker compose up -d db              # só o banco, em localhost:5432

cd server && cp .env.example .env
npm install && npm run build && npm run db:migrate
npm run start:dev                    # http://localhost:3001/api/health

cd web && npm install && npm run dev # http://localhost:3000

cd agent && go run ./cmd/agent
```

Para registrar um agente e enviar eventos de ponta a ponta, veja
[server/README.md](server/README.md).
