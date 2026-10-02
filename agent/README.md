# Tech Audit — agente Windows

Agente em Go que lê o log **Security** do Windows, transforma os eventos de
auditoria de acesso a arquivos em **ações claras** (criou, alterou, excluiu,
moveu para a Lixeira, renomeou, moveu, alterou permissões), guarda tudo num
buffer local e envia ao servidor central por HTTP(S). Roda como o serviço
**TechAuditAgent**, instalado por MSI ou pelo próprio executável.

Antes de instalar, habilite a auditoria no servidor de arquivos:
**[docs/auditoria-gpo.md](docs/auditoria-gpo.md)**, ou cadastre os caminhos no
portal e deixe o agente aplicar: **[docs/configuracao-pelo-portal.md](docs/configuracao-pelo-portal.md)**.

## Instalar

### MSI com assistente (recomendado)

Baixe o MSI no portal, em **Agente** (só com login; o download fica no log de
acesso). Com duplo clique abre o assistente em português, que pede:

- **Endereço do servidor**: o que o portal mostra na mesma tela (em produção,
  `https://ingest.audit.techmaster.inf.br`). Não precisa de `/v1/events`: o
  agente completa sozinho.
- **Token de instalação**: gerado na página da empresa, começa com `ta_enr_`.

### MSI sem telas (GPO ou script)

```powershell
msiexec /i TechAuditAgent-0.3.0.msi /qn ENDPOINT="https://ingest.audit.techmaster.inf.br" ENROLLMENT_TOKEN="ta_enr_..."
```

Sem `/qn` o assistente abre já preenchido com esses valores.

- Instala `C:\Program Files\TechAudit\techaudit-agent.exe` e o serviço
  `TechAuditAgent` (LocalSystem, início automático) e já o inicia.
- `ENDPOINT` e `ENROLLMENT_TOKEN` vão para `HKLM\SOFTWARE\TechAudit\Agent`.
  O agente apaga o `EnrollmentToken` do registro assim que se registra no
  servidor; o token próprio fica em `C:\ProgramData\TechAudit\credentials.json`.
- Atualizar: rode o MSI novo sem parâmetros. Servidor, credenciais e buffer são mantidos.
- Remover: "Aplicativos instalados" ou `msiexec /x TechAuditAgent-0.3.0.msi /qn`.
  `C:\ProgramData\TechAudit` fica (apague à mão para remover tudo).

### Sem MSI

```powershell
.\techaudit-agent.exe install -endpoint https://ingest.audit.techmaster.inf.br/v1/events -enrollment-token ta_enr_...
.\techaudit-agent.exe uninstall
```

`install` copia o executável para `C:\Program Files\TechAudit`, grava o
mesmo registro do MSI, cria o serviço com reinício automático e o inicia.
Rodar de novo atualiza o executável.

### O que o serviço faz no Windows

- Pasta de dados `C:\ProgramData\TechAudit`, acessível só por SYSTEM e
  Administradores: `agent.db` (buffer), `credentials.json`, `agent.log`
  (gira a cada 10 MB, guarda 3).
- Reinicia sozinho 1 minuto após qualquer falha.
- Escreve início, parada e erros no log **Aplicativo** (origem `TechAuditAgent`).
- Envia um heartbeat a cada minuto para `POST /v1/heartbeat` (versão e
  tamanho do buffer), mesmo sem eventos, para o portal saber que está vivo.

## Como funciona

1. Assina o canal `Security` com `EvtSubscribe` (`wevtapi.dll`), filtrando
   4656, 4663, 4660, 4670, 5140 e 5145 por XPath.
2. **Correlaciona** os eventos brutos em ações lógicas (tabela abaixo),
   consultando o disco quando o log não basta (se o caminho é pasta, datas
   do NTFS, Lixeira).
3. Grava as ações no **buffer SQLite** (`agent.db`, modo WAL) **na mesma
   transação** do bookmark do Event Log e das pendências da correlação. Após
   reinício ou queda de energia, nada é lido duas vezes nem perdido.
4. Envia lotes de até `batch_size` eventos (JSON gzip, `Authorization:
   Bearer`). Só apaga do buffer depois do `2xx`. Com o servidor fora do ar o
   buffer cresce até `max_buffer_mb`; ao encher, descarta leituras antes de
   escritas e exclusões. O `batch_id` é derivado do conteúdo do buffer, então
   um lote reenviado após reinício mantém o id e o servidor o reconhece.
5. Na primeira execução registra-se em `POST /v1/enroll` com o token de
   registro, o hostname e um `machine_id` (hash do `MachineGuid`).

### Ações

| `action` | Quando | Eventos do Windows |
|---|---|---|
| `created` | Arquivo ou pasta novo | Escrita na pasta (4663 `AddFile`/`AddSubdirectory`) + data de criação do item; ou escrita num arquivo criado agora |
| `modified` | Conteúdo alterado | 4663 `WriteData`/`AppendData`; também o "salvar" do Office, que troca o arquivo (DELETE sem 4660 e o caminho continua existindo) |
| `deleted` | Exclusão definitiva | 4663 `DELETE` + 4660 do mesmo handle, num só evento (`related_records` traz o 4660) |
| `recycled` | Enviado para a Lixeira | 4663 `DELETE` sem 4660, e o caminho aparece num `$I` da Lixeira do usuário; `new_path` é o `$R` |
| `renamed` | Novo nome na mesma pasta | 4663 `DELETE` sem 4660 + item da pasta com ChangeTime do NTFS no instante, mas criação e modificação antigas; `new_path` é o nome novo |
| `moved` | Para outra pasta | Como `renamed`, na pasta de destino que o Windows registrou; sem destino identificado, `details.destination_folder` ou nada |
| `permission_changed` / `owner_changed` | DACL ou dono | 4663 `WRITE_DAC`/`WRITE_OWNER` + 4670 (SDDL antes/depois em `details.old_sd`/`new_sd`). Dez ou mais em sequência pelo mesmo processo (ex.: `icacls /T`) viram **um** evento na pasta comum, com `count` e `details.sample` |
| `attributes_changed` | Somente leitura, oculto... | 4663 `WriteAttributes` |
| `read` | Leitura | 4663 `ReadData`, só se a SACL auditar leitura |
| `denied` | Acesso negado | Qualquer evento de falha (4656/4663/5145) |

Repetições da mesma ação, do mesmo usuário, no mesmo caminho, em
`aggregate_window` (60 s) viram um evento com `count` e `end_time`; criar e
alterar logo em seguida contam como `created`. O IP de origem vem do 5140
(sessão SMB) da mesma sessão de logon.

Descartados: travessia/execução, `DeleteChild` sozinho (a exclusão aparece
no evento do item), 4656 de sucesso (o 4663 traz a ação), 5145 de sucesso
(só usado para o IP) e eventos do próprio agente.

Limites conhecidos (heurísticas, validar em servidores reais):

- Os horários do NTFS são lidos quando a pendência vence (3 s). Se o agente
  estava parado e processa um atraso grande, o arquivo pode ter mudado desde
  então e a ação sair menos precisa (ex.: `moved` sem destino).
- Renomear logo após alterar o arquivo (menos de 3 s) não é reconhecido
  pelo nome novo: sai como `moved` sem destino.
- Mover para outro volume é cópia + exclusão: aparece como `created` no
  destino e `deleted` na origem.
- Criar uma pasta vazia não gera evento no Windows (no teste com Windows 11
  não houve 4663 na pasta-mãe nem na nova). A pasta aparece quando algo é
  gravado, copiado ou movido para dentro dela, ou quando é renomeada.

## Formato enviado

```json
{
  "batch_id": "6f1c2a9e-3b7d-5e0a-9c55-2d8f1b7a4e10",
  "agent_id": "FS01",
  "hostname": "FS01",
  "agent_version": "0.2.0",
  "sent_at": "2026-10-01T14:05:10Z",
  "events": [
    {
      "record_id": 1002,
      "event_id": 4663,
      "kind": "object_access",
      "time": "2026-10-01T14:05:00Z",
      "computer": "FS01.corp.local",
      "user": { "name": "joao.silva", "domain": "CORP", "sid": "S-1-5-21-...-1104", "logon_id": "0x3e7a1f" },
      "path": "D:\\Shares\\Financeiro\\antigo.docx",
      "object_type": "File",
      "client_ip": "10.0.0.25",
      "process_id": "0x4",
      "actions": ["delete"],
      "access_mask": "0x10000",
      "outcome": "success",
      "handle_id": "0x2b40",
      "action": "deleted",
      "count": 1,
      "related_records": [1003]
    }
  ]
}
```

Campos novos da versão 0.2 (opcionais para o servidor): `action`,
`new_path`, `item_type` (`file`/`folder`), `count`, `end_time`,
`related_records`, `details`. `actions` continua trazendo os direitos brutos
do `AccessMask` (`read`, `write`, `delete`, `permission_change`...).

## Configurar

Com o MSI não é preciso arquivo: o agente usa o registro. Para ajustes finos,
crie `C:\ProgramData\TechAudit\agent.json` (modelo em `agent.example.json`);
com o arquivo presente, o registro é ignorado.

| Campo | Padrão | Descrição |
|---|---|---|
| `endpoint` | (obrigatório) | URL que recebe o `POST` dos eventos |
| `token` | | Token fixo. Se vazio, usa o obtido no registro |
| `enrollment_token` | | Token de registro gerado no portal |
| `data_dir` | `C:\ProgramData\TechAudit` | Buffer, credenciais e log |
| `buffer_file` | `data_dir\agent.db` | Buffer SQLite |
| `max_buffer_mb` | `1024` | Tamanho máximo do buffer |
| `log_file` | `data_dir\agent.log` | Log do serviço |
| `credentials_file` | `data_dir\credentials.json` | `agent_id` e token do registro |
| `agent_id` | nome do host | Identificação do agente |
| `batch_size` | `200` | Máximo de eventos por envio |
| `flush_interval` | `10s` | Espera máxima para juntar um lote |
| `start_from` | `now` | Sem posição salva: `now` (só eventos novos) ou `oldest` (todo o log) |
| `ca_file` | | PEM da CA do servidor, se não estiver no repositório do Windows |
| `filter.exclude_machine_accounts` | `false` | Descarta contas terminadas em `$` |
| `filter.object_types` | todos | Ex.: `["File"]` |
| `filter.include_paths` | todos | Só envia caminhos com estes prefixos |
| `filter.exclude_path_contains` | | Descarta caminhos com estes trechos. Renomear/mover passa se origem **ou** destino for permitido |
| `correlation.window` | `3s` | Espera pelo 4660 e pelo destino de renomear/mover |
| `correlation.aggregate_window` | `60s` | Junta repetições |
| `correlation.bulk_threshold` | `10` | A partir de quantas alterações de permissão em sequência vira um evento só |
| `correlation.bulk_gap` | `5s` | Intervalo máximo dentro de uma sequência |
| `audit_config.disabled` | `false` | Não aplica os caminhos cadastrados no portal |
| `audit_config.interval` | `2m` | Intervalo entre consultas da configuração |
| `audit_config.verify_interval` | `30m` | Intervalo entre verificações de divergência |
| `audit_config.size_interval` | `6h` | Intervalo entre medições do tamanho das pastas |
| `audit_config.state_file` | `C:\ProgramData\TechAudit\audit-config-state.json` | O que o agente aplicou |
| `audit_config.change_log` | `C:\ProgramData\TechAudit\audit-changes.log` | Log local de alterações (só acréscimo) |

A versão 0.1 guardava a posição do log em `state_file`
(`bookmark.xml`); a 0.2 lê esse arquivo uma vez e passa a usar o buffer.

## Compilar

Requer Go 1.24+. Compila para Windows a partir de qualquer sistema:

```sh
cd agent
make test      # vet (Linux e Windows) + testes
make windows   # dist/techaudit-agent.exe
make msi       # dist/TechAuditAgent-<versão>.msi (requer wixl e msitools)
```

A versão fica em `VERSION`. As telas do assistente estão em
`installer/techaudit-agent.wxs` e as imagens em `installer/bitmaps`. A imagem
Docker do servidor compila o MSI na hora do `docker compose build` e o oferece
para download no portal; `DEFAULT_SERVER` (ou o build arg
`AGENT_DEFAULT_SERVER`) muda a sugestão do campo "Endereço do servidor".

O CI gera o `.exe` e o `.msi` a cada push (artefato
`techaudit-agent-windows`). Ainda **não são assinados**: o Windows mostra o
aviso do SmartScreen até termos o certificado de code signing da Tech Master
(depois, `signtool sign` no `.exe` antes do `make msi` e no `.msi`).

## Testar sem Windows

`-replay` lê um XML exportado em vez do Event Log (com buffer temporário e
sem consultar o disco); `-stdout` imprime os lotes em vez de enviar:

```sh
cat internal/event/testdata/*.xml > /tmp/export.xml
echo '{"endpoint": "http://localhost:8080/v1/events", "token": "teste", "data_dir": "/tmp/ta"}' > /tmp/agent.json
go run ./cmd/agent -config /tmp/agent.json -replay /tmp/export.xml -stdout
```

Para enviar a um receptor de teste: `go run ./cmd/mock-receiver -token teste`
e rode o agente sem `-stdout`. No Windows, gere um XML real com:

```powershell
wevtutil qe Security /q:"*[System[(EventID=4663 or EventID=4660 or EventID=4656 or EventID=4670 or EventID=5140 or EventID=5145)]]" /c:200 /f:xml > export.xml
```

Para ver as ações ao vivo num servidor sem instalar o serviço, num
PowerShell como administrador: `.\techaudit-agent.exe -config .\agent.json -stdout`.
