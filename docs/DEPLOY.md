# Tech Audit: subir com Docker

O `docker-compose.yml` na raiz sobe o sistema completo: banco (PostgreSQL +
TimescaleDB), API (`server/`) e portal (`web/`). O mesmo arquivo serve para
testar numa máquina e para a produção; o que muda é o `.env`.

| Serviço | Porta | Para quê |
|---|---|---|
| `web` | `PORTAL_PORT` (3000) | Portal: login, eventos, empresas, licenças, usuários |
| `server` | `API_PORT` (3001) | Agentes (`/v1/enroll`, `/v1/events`) e API do portal (`/api`) |
| `db` | só `127.0.0.1:5432` | Banco; nunca fica exposto na rede |

## Primeira subida

```sh
git clone https://github.com/mracapulco/Tech_Audit.git
cd Tech_Audit
cp .env.example .env      # edite as senhas e o e-mail do administrador
docker compose up -d --build
docker compose ps         # db, server e web "Up"; db e server "(healthy)"
```

Na subida, a API aplica as migrations do banco e, se ainda não houver
administrador, cria um com `BOOTSTRAP_ADMIN_EMAIL` e `BOOTSTRAP_ADMIN_PASSWORD`.
Depois é só abrir `http://<servidor>:3000` e entrar com esse e-mail.

## Atualizar

```sh
git pull
docker compose up -d --build
```

Os dados ficam no volume `db-data` e sobrevivem a atualizações e reinícios.

## Produção

- Coloque o portal e a API atrás do proxy reverso com HTTPS (Traefik, Nginx),
  por exemplo `audit.techmaster.inf.br` → `web:3000` e
  `ingest.audit.techmaster.inf.br` → `server:3001`.
- No `.env`: `COOKIE_SECURE=true` (o login exige HTTPS) e
  `PUBLIC_AGENT_URL=https://ingest.audit.techmaster.inf.br` (vai no
  `agent.json` gerado pelo portal).
- Senhas fortes em `POSTGRES_PASSWORD` (só letras e números) e
  `BOOTSTRAP_ADMIN_PASSWORD`. Depois do primeiro login, as linhas
  `BOOTSTRAP_ADMIN_*` podem sair do `.env`.
- Backup: `docker compose exec db pg_dump -U techaudit -Fc techaudit > techaudit-$(date +%F).dump`.

## Comandos úteis

```sh
docker compose logs -f server                       # logs da API
docker compose exec server node dist/cli.js user:password --email fulano@empresa.com.br
docker compose down                                 # para tudo (mantém os dados)
```
