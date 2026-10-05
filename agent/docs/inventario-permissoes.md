# Inventário de permissões

Recurso do plano **Enterprise**: mostra no portal (aba **Permissões**) quem tem
acesso a cada pasta auditada. O agente só **lê** permissões; nunca altera nada.

## Quando o agente coleta

- Uma vez a cada 24 horas, por caminho auditado ativo.
- Logo depois que um caminho novo é cadastrado.
- Quando alguém clica em **Atualizar agora** no portal (o agente atende na
  próxima consulta da configuração, em até 2 minutos).

A última coleta fica salva em `permissions-state.json`, na pasta de dados do
agente, para não refazer tudo a cada reinício do serviço.

## O que é coletado

| | Windows | Linux |
|---|---|---|
| Pasta | Dono e DACL (NTFS): quem, permitir/negar, permissão, herdada ou não, onde vale | Dono, grupo, modo (rwx) e ACL POSIX (`setfacl`), inclusive a ACL padrão |
| Compartilhamento | Permissões de compartilhamento (sem os administrativos, como `C$`) | Parâmetros do Samba: `valid users`, `read only`, `write list`, `read list`, `admin users`, `invalid users`, `guest ok` |
| Nomes | SID traduzido para `DOMINIO\nome` | uid/gid traduzidos (inclui contas do domínio via `getent`) |

Para não repetir a mesma permissão em milhares de subpastas, entram a pasta
auditada e só as subpastas com permissão própria:

- **Windows**: herança desligada ou alguma entrada explícita.
- **Linux**: dono, grupo, modo ou ACL diferentes da pasta de cima.

Limites: até 5.000 pastas por caminho (o portal avisa "Coleta parcial");
links simbólicos e junções não são seguidos. A leitura roda em baixa
prioridade de disco e CPU no Windows.

## Servidor

- `GET /v1/config` traz `permissions: { enabled, interval_hours, requested_at }`.
- `POST /v1/permissions` recebe a coleta em partes de até 500 pastas
  (`scan_id`, `part`, `final`).
- O servidor guarda as linhas das duas últimas coletas completas de cada
  caminho, para marcar o que é **novo** e o que foi **removido**.
