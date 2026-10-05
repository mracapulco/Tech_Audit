# Tech Audit: subir com Docker

O `docker-compose.yml` na raiz sobe o sistema completo: banco (PostgreSQL +
TimescaleDB), API (`server/`) e portal (`web/`). O mesmo arquivo serve para
testar numa máquina e para a produção; o que muda é o `.env`.

| Serviço | Porta | Para quê |
|---|---|---|
| `web` | `PORTAL_PORT` (3000) | Portal: login, painel, eventos, relatórios, empresas, licenças, usuários |
| `server` | `API_PORT` (3001) | Só os agentes (`/v1/*`). A API do portal (`/api`) fica na porta interna 3001 do contêiner, sem publicação |
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
| `BIND_ADDRESS` | `0.0.0.0` | `0.0.0.0` (o HAProxy está em outra VM); `127.0.0.1` só se o proxy rodar na mesma máquina |
| `PUBLIC_AGENT_URL` | `http://localhost:3101` ou `http://<IP do PC>:3101` | `https://ingest-audit.techmaster.inf.br` |
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
  `ingest-audit.techmaster.inf.br` → porta dos agentes (`API_PORT`).
- Publique para a internet só o proxy: as portas do portal e da API não devem
  ficar abertas direto, porque o IP do usuário no log de acesso vem do
  `X-Forwarded-For` que o proxy acrescenta.
- O proxy precisa repassar o `Host` original e o IP do cliente: o portal
  recusa ações (login, cadastros) cujo `Origin` não bate com o `Host`.

### HAProxy em outra VM (o caso da Tech Master)

O HAProxy faz o HTTPS e encaminha para a VM do Docker pela rede interna.
Mantenha `BIND_ADDRESS=0.0.0.0` (o HAProxy precisa alcançar as portas).
No `haproxy.cfg`, dentro do `frontend` HTTPS que já atende o Tech_Hub,
acrescente as regras e, no fim do arquivo, os dois `backend`
(troque `IP_DA_VM_DOCKER` pelo IP interno da VM onde o Tech Audit roda):

```haproxy
frontend https_in
    # ... bind :443 ssl crt ... e regras do Tech_Hub que já existem ...
    use_backend techaudit_portal if { hdr(host) -i audit.techmaster.inf.br }
    use_backend techaudit_agentes if { hdr(host) -i ingest-audit.techmaster.inf.br }

backend techaudit_portal
    # Apaga o X-Forwarded-For que vier do navegador e põe o IP real: sem
    # isso, alguém poderia falsificar o IP e driblar o bloqueio de login.
    http-request del-header X-Forwarded-For
    option forwardfor
    http-request set-header X-Forwarded-Proto https
    server portal IP_DA_VM_DOCKER:3000 check

backend techaudit_agentes
    timeout server 120s
    http-request del-header X-Forwarded-For
    option forwardfor
    http-request set-header X-Forwarded-Proto https
    server agentes IP_DA_VM_DOCKER:3001 check
```

- O HAProxy mantém o `Host` original por padrão; não troque esse cabeçalho.
- As regras de cabeçalho ficam nos `backend` do Tech Audit, sem mexer no
  que o Tech_Hub já usa.
- A API só aceita o `X-Forwarded-For` vindo de IPs internos (10.x,
  172.16-31.x, 192.168.x), o que inclui o HAProxy e o contêiner do portal.
  Por isso o firewall abaixo é obrigatório: ninguém além do HAProxy pode
  chegar nas portas.
- Feche as portas `PORTAL_PORT` e `API_PORT` (3000 e 3001) da VM do Docker
  para todos menos o HAProxy, de preferência no firewall da rede: nem a
  internet nem o resto da rede interna devem alcançá-las direto. No Linux o
  Docker passa por cima do `ufw`; para filtrar na própria VM, use a cadeia
  `DOCKER-USER` do iptables, limitada à placa de rede da VM (descubra o nome
  com `ip route | grep default`, ex.: `eth0`) para não bloquear o tráfego
  entre os contêineres:

  ```sh
  sudo iptables -I DOCKER-USER -i eth0 -p tcp -m conntrack --ctorigdstport 3000:3001 ! -s IP_DO_HAPROXY -j DROP
  ```

### Outros proxies

Com Nginx ou Traefik na mesma máquina, use `BIND_ADDRESS=127.0.0.1` e aponte
para `127.0.0.1:3000` (portal) e `127.0.0.1:3001` (agentes), repassando
`Host`, `X-Forwarded-For` e `X-Forwarded-Proto: https`.

### Configuração

- No `.env`: `COOKIE_SECURE=true` (o login exige HTTPS) e
  `PUBLIC_AGENT_URL=https://ingest-audit.techmaster.inf.br` (vai no
  `agent.json` gerado pelo portal).
- Senhas fortes em `POSTGRES_PASSWORD` (só letras e números) e
  `BOOTSTRAP_ADMIN_PASSWORD`. Depois do primeiro login, as linhas
  `BOOTSTRAP_ADMIN_*` podem sair do `.env`.
- E-mail dos alertas e relatórios agendados: gere a chave `SECRETS_KEY` uma vez
  (`openssl rand -hex 32`) e coloque no `.env`; ela criptografa no banco a
  senha do servidor de e-mail. O servidor em si (Microsoft 365 com
  autenticação moderna ou SMTP) é configurado no portal, menu Tech Master >
  Servidor de e-mail, que tem o botão de teste.
- Microsoft 365 (Exchange Online): no Entra ID, registre um aplicativo, crie
  um segredo e dê a permissão de **aplicativo** `Mail.Send` (Microsoft Graph)
  com consentimento do administrador. Para o aplicativo só poder enviar pela
  caixa do remetente, limite com uma Application Access Policy
  (`New-ApplicationAccessPolicy -AccessRight RestrictAccess`) ou com RBAC
  para aplicativos do Exchange.
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
