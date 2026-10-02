# Tech Audit: subir com Docker

O `docker-compose.yml` na raiz sobe o sistema completo: banco (PostgreSQL +
TimescaleDB), API (`server/`) e portal (`web/`). O mesmo arquivo serve para
testar numa máquina e para a produção; o que muda é o `.env`.

| Serviço | Porta | Para quê |
|---|---|---|
| `web` | `PORTAL_PORT` (3000) | Portal: login, painel, eventos, relatórios, empresas, licenças, usuários |
| `server` | `API_PORT` (3001) | Agentes (`/v1/enroll`, `/v1/events`) e API do portal (`/api`) |
| `db` | só `127.0.0.1:5432` (`DB_PORT`) | Banco; nunca fica exposto na rede |

## Homologação e produção

O código e o `docker-compose.yml` são os mesmos nos dois ambientes; só o
`.env` muda. Nada no código depende da pasta, do nome da máquina ou do
domínio: endereços e portas vêm todos do `.env`.

| `.env` | Homologação (PC com Tech_Hub) | Produção (servidor) |
|---|---|---|
| `PORTAL_PORT` | `3100` | `3000` (ou outra livre) |
| `API_PORT` | `3101` | `3001` (ou outra livre) |
| `DB_PORT` | `5433` | `5432` (ou outra livre) |
| `BIND_ADDRESS` | `0.0.0.0` | `127.0.0.1` se o proxy HTTPS roda na própria máquina |
| `PUBLIC_AGENT_URL` | `http://localhost:3101` ou `http://<IP do PC>:3101` | `https://ingest.audit.techmaster.inf.br` |
| `COOKIE_SECURE` | `false` | `true` |
| `POSTGRES_PASSWORD`, `BOOTSTRAP_ADMIN_*` | de teste | fortes e diferentes da homologação |

O que já fica garantido pelo `docker-compose.yml`:

- **Nome fixo** (`name: techaudit`): contêineres `techaudit-*` e volume do
  banco `techaudit_db-data`, seja qual for o nome da pasta do clone. Clonar
  em outra pasta não cria um banco vazio novo.
- **Versão fixa do TimescaleDB**: os dois ambientes rodam o mesmo banco.
- **Nomes internos próprios** (`techaudit-db`): não colidem com o `db` do
  Tech_Hub se as redes Docker forem compartilhadas com um proxy.
- Um `.env` de cada ambiente fica só na sua máquina (o Git ignora `.env`).

`PUBLIC_AGENT_URL` só vale para os `agent.json` gerados **depois** da troca.
Um agente aponta para um único ambiente: para levar um servidor de teste da
homologação para a produção, reinstale o agente com um token gerado no portal
de produção e apague antes `C:\ProgramData\TechAudit\credentials.json`
(senão ele continua usando as credenciais da homologação e recebe 401).

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
  por exemplo `audit.techmaster.inf.br` → portal (`PORTAL_PORT`) e
  `ingest.audit.techmaster.inf.br` → API (`API_PORT`).
- O proxy precisa repassar o `Host` original e o IP do cliente: o portal
  recusa ações (login, cadastros) cujo `Origin` não bate com o `Host`, e a
  API registra o IP de quem acessou. Exemplo com Nginx na própria máquina
  (`BIND_ADDRESS=127.0.0.1`):

  ```nginx
  server {
    listen 443 ssl;
    server_name audit.techmaster.inf.br;
    # ssl_certificate ... (Let's Encrypt, etc.)
    location / {
      proxy_pass http://127.0.0.1:3000;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto https;
    }
  }
  server {
    listen 443 ssl;
    server_name ingest.audit.techmaster.inf.br;
    client_max_body_size 25m;
    location / {
      proxy_pass http://127.0.0.1:3001;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto https;
    }
  }
  ```

  Com Traefik em contêiner, em vez de `BIND_ADDRESS`, ligue `web` e `server`
  à rede do Traefik num `docker-compose.override.yml` (fica só no servidor)
  e aponte para as portas internas 3000 e 3001.
- No `.env`: `COOKIE_SECURE=true` (o login exige HTTPS) e
  `PUBLIC_AGENT_URL=https://ingest.audit.techmaster.inf.br` (vai no
  `agent.json` gerado pelo portal).
- Senhas fortes em `POSTGRES_PASSWORD` (só letras e números) e
  `BOOTSTRAP_ADMIN_PASSWORD`. Depois do primeiro login, as linhas
  `BOOTSTRAP_ADMIN_*` podem sair do `.env`.
- Backup: `docker compose exec -T db pg_dump -U techaudit -Fc techaudit > techaudit-$(date +%F).dump`.

## Restaurar um backup

Num banco vazio (por exemplo, para levar dados de um servidor para outro):

```sh
docker compose up -d db
docker compose exec -T db psql -U techaudit -d techaudit -c "SELECT timescaledb_pre_restore();"
docker compose exec -T db pg_restore -U techaudit -d techaudit --no-owner < techaudit-AAAA-MM-DD.dump
docker compose exec -T db psql -U techaudit -d techaudit -c "SELECT timescaledb_post_restore();"
docker compose up -d
```

O TimescaleDB precisa ser da mesma versão nos dois lados (por isso a versão
fica fixa no `docker-compose.yml`).

## Atualizar o TimescaleDB

1. Faça um backup.
2. Troque a versão em `image:` do serviço `db` no `docker-compose.yml`
   (e no `.github/workflows/ci.yml`) e rode `docker compose up -d`.
3. Atualize a extensão dentro do banco:
   `docker compose exec db psql -U techaudit -d techaudit -X -c "ALTER EXTENSION timescaledb UPDATE;"`

## Comandos úteis

```sh
docker compose logs -f server                       # logs da API
docker compose exec server node dist/cli.js user:password --email fulano@empresa.com.br
docker compose down                                 # para tudo (mantém os dados)
```
