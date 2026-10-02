# Tech Audit — agente Windows (prova de conceito)

Agente em Go que lê o log **Security** do Windows, filtra os eventos de
auditoria de acesso a arquivos, normaliza em JSON e envia ao servidor central
por HTTP(S).

| ID | Evento | `kind` no JSON |
|---|---|---|
| 4663 | Tentativa de acesso a objeto | `object_access` |
| 4656 | Handle solicitado (inclui acessos negados) | `handle_request` |
| 4660 | Objeto excluído | `object_deleted` |
| 5145 | Acesso via compartilhamento de rede (SMB) | `share_access` |

Antes de instalar, habilite a auditoria no servidor de arquivos:
**[docs/auditoria-gpo.md](docs/auditoria-gpo.md)**.

## Como funciona

1. Assina o canal `Security` com `EvtSubscribe` (API `wevtapi.dll`), filtrando
   os IDs acima por XPath.
2. Converte cada evento (XML) em um registro normalizado: usuário, caminho,
   ações, resultado, horário (UTC), IP do cliente quando houver.
3. Agrupa até `batch_size` eventos ou `flush_interval` e faz `POST` em
   `endpoint` com JSON comprimido (gzip) e `Authorization: Bearer <token>`.
4. Só depois de uma resposta `2xx` grava o bookmark em `state_file`. Se o
   agente reiniciar ou o servidor ficar fora do ar, ele retoma do último evento
   confirmado (entrega *pelo menos uma vez*: o servidor deve deduplicar por
   `agent_id` + `record_id`; `batch_id` se repete nas novas tentativas do mesmo lote).

O `AccessMask` é traduzido para ações legíveis:

| Bit | Ação |
|---|---|
| `0x1` ReadData | `read` |
| `0x2` WriteData | `write` |
| `0x4` AppendData | `append` |
| `0x20` Execute | `execute` |
| `0x40` DeleteChild | `delete_child` |
| `0x10`/`0x100` WriteEA/WriteAttributes | `write_attributes` |
| `0x10000` DELETE | `delete` |
| `0x40000` WRITE_DAC | `permission_change` |
| `0x80000` WRITE_OWNER | `owner_change` |

Leitura de atributos, `READ_CONTROL` e `SYNCHRONIZE` são ignorados por serem ruído.

## Formato enviado

```json
{
  "batch_id": "6f1c2a9e-3b7d-4e0a-9c55-2d8f1b7a4e10",
  "agent_id": "FS01",
  "hostname": "FS01",
  "agent_version": "0.1.0",
  "sent_at": "2026-10-01T14:05:10Z",
  "events": [
    {
      "record_id": 1001,
      "event_id": 4663,
      "kind": "object_access",
      "time": "2026-10-01T14:03:22.1234567Z",
      "computer": "FS01.corp.local",
      "user": { "name": "joao.silva", "domain": "CORP", "sid": "S-1-5-21-...-1104", "logon_id": "0x3e7a1f" },
      "path": "D:\\Shares\\Financeiro\\Relatorios\\2026-09.xlsx",
      "object_type": "File",
      "actions": ["write"],
      "access_mask": "0x2",
      "outcome": "success",
      "handle_id": "0x1a2c"
    }
  ]
}
```

Eventos `share_access` trazem também `share_name` e `client_ip`. `outcome` é
`failure` quando o acesso foi negado.

## Compilar

Requer Go 1.24+. Compila para Windows a partir de qualquer sistema:

```sh
cd agent
make test      # vet (Linux e Windows) + testes
make windows   # gera dist/techaudit-agent.exe
```

## Configurar

Copie `agent.example.json` para `agent.json` e ajuste:

| Campo | Padrão | Descrição |
|---|---|---|
| `endpoint` | (obrigatório) | URL que recebe o `POST` |
| `token` | | Enviado como `Authorization: Bearer` |
| `agent_id` | nome do host | Identificação do agente/cliente |
| `batch_size` | `200` | Máximo de eventos por envio |
| `flush_interval` | `10s` | Espera máxima antes de enviar um lote parcial |
| `state_file` | `C:\ProgramData\TechAudit\bookmark.xml` | Onde o bookmark é salvo |
| `start_from` | `now` | Sem bookmark: `now` (só eventos novos) ou `oldest` (todo o log) |
| `ca_file` | | PEM da CA do servidor, se não estiver no repositório do Windows |
| `filter.exclude_machine_accounts` | `false` | Descarta contas terminadas em `$` |
| `filter.object_types` | todos | Ex.: `["File"]` |
| `filter.include_paths` | todos | Só envia caminhos com estes prefixos |
| `filter.exclude_path_contains` | | Descarta caminhos com estes trechos (ex.: arquivos temporários do Office `~$`) |

## Testar sem Windows

O agente lê um XML exportado em vez do Event Log com `-replay`, e há um
receptor de teste que imprime o que chega:

```sh
go run ./cmd/mock-receiver -token troque-este-token          # terminal 1
cat internal/event/testdata/*.xml > /tmp/export.xml
go run ./cmd/agent -config agent.example.json -replay /tmp/export.xml   # terminal 2
```

`-stdout` imprime os lotes em vez de enviar. No Windows, gere um XML real com:

```powershell
wevtutil qe Security /q:"*[System[(EventID=4663 or EventID=4660 or EventID=4656 or EventID=5145)]]" /c:200 /f:xml > export.xml
```

## Instalar no servidor de arquivos (PoC)

Ler o log Security exige SYSTEM ou administrador. Para a prova de conceito, o
agente roda como tarefa agendada no boot (como serviço, numa próxima etapa):

```powershell
$dir = 'C:\Program Files\TechAudit'
New-Item -ItemType Directory -Force $dir | Out-Null
Copy-Item .\techaudit-agent.exe, .\agent.json $dir
# agent.json contém o token: apenas SYSTEM e Administradores podem ler
icacls "$dir\agent.json" /inheritance:r /grant:r "*S-1-5-18:F" "*S-1-5-32-544:F"

schtasks /create /tn "TechAudit Agent" /sc onstart /ru SYSTEM /rl HIGHEST /f `
  /tr "`"$dir\techaudit-agent.exe`" -config `"$dir\agent.json`" -logfile `"C:\ProgramData\TechAudit\agent.log`""
schtasks /run /tn "TechAudit Agent"
```

Para testar interativamente, abra um PowerShell como administrador e rode
`.\techaudit-agent.exe -config .\agent.json -stdout`.

## Limitações conhecidas

- Testado com eventos de exemplo e `-replay`; a leitura direta do Event Log
  (`internal/source/eventlog_windows.go`) compila, mas precisa ser validada num
  Windows Server com a auditoria habilitada.
- Roda como tarefa agendada, não como serviço do Windows.
- O caminho do 4660 é resolvido por um cache em memória dos últimos handles;
  após reiniciar, um 4660 cujo 4663 veio antes do reinício chega sem `path`.
- Renomear ou mover aparece como `delete` no caminho antigo (o Windows não
  registra o novo nome no 4663); identificar isso como "renomeou" fica para
  uma etapa futura.
