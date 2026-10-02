# Tech Audit

Plataforma de auditoria de servidores de arquivos (Windows, futuramente Linux) da Tech Master.

## Estrutura

| Pasta | Conteúdo |
| --- | --- |
| `server/` | API central e ingestão dos agentes (NestJS + Prisma) |
| `agent/` | Agente instalado nos servidores de arquivos (Go) |
| `web/` | Portal do cliente (Next.js) |
| `docker-compose.yml` | PostgreSQL com TimescaleDB para desenvolvimento |

## Rodando localmente

Requisitos: Node.js 22.12+, Go 1.24+, Docker.

```bash
docker compose up -d                 # banco em localhost:5432

cd server && cp .env.example .env
npm install && npx prisma migrate dev
npm run start:dev                    # http://localhost:3001/api/health

cd web && npm install && npm run dev # http://localhost:3000

cd agent && go run ./cmd/agent
```
