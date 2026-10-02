# Habilitando a auditoria de arquivos via GPO

O agente só envia o que o Windows registra. Para que os eventos 4656, 4660,
4663 e 5145 apareçam no log **Security** do servidor de arquivos, são
necessárias três coisas:

1. **Política de auditoria** ligando as subcategorias de acesso a objetos.
2. **SACL** (lista de auditoria) nas pastas que serão monitoradas.
3. **Log Security grande o bastante** para não sobrescrever eventos antes do envio.

Os passos abaixo usam uma GPO vinculada à OU dos servidores de arquivos. Em
servidor fora de domínio, os mesmos itens existem em `gpedit.msc` / `secpol.msc`.

> Os nomes dos menus estão em inglês com a tradução do Windows em português
> entre parênteses; a tradução pode variar um pouco entre versões.

## 1. Política de auditoria avançada

Crie uma GPO (ex.: `Tech Audit - Servidores de Arquivos`) e edite:

`Computer Configuration > Policies > Windows Settings > Security Settings > Advanced Audit Policy Configuration > Audit Policies > Object Access`
(`Configuração do Computador > Políticas > Configurações do Windows > Configurações de Segurança > Configuração Avançada de Política de Auditoria > Políticas de Auditoria > Acesso a Objetos`)

| Subcategoria | Configurar | Gera |
|---|---|---|
| Audit File System (Auditoria do Sistema de Arquivos) | Success, Failure | 4656, 4660, 4663 |
| Audit Detailed File Share (Auditoria Detalhada de Compartilhamento de Arquivos) | Success, Failure | 5145 |

Depois, garanta que a política avançada prevaleça sobre a política básica:

`Computer Configuration > Policies > Windows Settings > Security Settings > Local Policies > Security Options`
→ **Audit: Force audit policy subcategory settings (Windows Vista or later) to override audit policy category settings** = **Enabled**
(`Auditoria: forçar configurações de subcategoria de política de auditoria...` = `Habilitado`)

> O 5145 é registrado a cada verificação de acesso via SMB e costuma ser o
> evento mais volumoso. Se o volume pesar, ele pode ficar só com **Failure**
> (tentativas negadas), mantendo **Audit File System** com sucesso e falha.

## 2. SACL nas pastas monitoradas

A política acima só registra acessos a objetos que tenham uma entrada de
auditoria (SACL). Configure nas pastas raiz dos compartilhamentos, com herança.

### Opção A: PowerShell no servidor (recomendado para a PoC)

Execute como administrador, trocando o caminho:

```powershell
$path   = 'D:\Shares'
$todos  = New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')  # "Todos"/"Everyone" em qualquer idioma
$rights = 'CreateFiles,AppendData,WriteAttributes,WriteExtendedAttributes,Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership'
$rule   = New-Object System.Security.AccessControl.FileSystemAuditRule(
            $todos, $rights, 'ContainerInherit,ObjectInherit', 'None', 'Success,Failure')
$acl = Get-Acl -Path $path -Audit
$acl.AddAuditRule($rule)
Set-Acl -Path $path -AclObject $acl
(Get-Acl -Path $path -Audit).Audit | Format-Table IdentityReference, FileSystemRights, AuditFlags
```

Isso audita **gravação, exclusão e mudança de permissão/dono**. Para auditar
também **leituras**, acrescente `ReadData` a `$rights`; o volume de eventos
cresce bastante, então comece por pastas sensíveis (ex.: Financeiro, RH).

### Opção B: pela própria GPO

`Computer Configuration > Policies > Windows Settings > Security Settings > File System`
(`... > Configurações de Segurança > Sistema de Arquivos`) → botão direito →
**Add File...** → escolha a pasta → **Advanced > Auditing (Auditoria) > Add**:

- Principal: **Everyone** (Todos)
- Type: **All** (Todos), Applies to: **This folder, subfolders and files**
- Permissões avançadas: *Create files / write data*, *Create folders / append data*,
  *Write attributes*, *Write extended attributes*, *Delete subfolders and files*,
  *Delete*, *Change permissions*, *Take ownership* (e *List folder / read data* se quiser leituras)

Na janela seguinte, escolha **Configure this file or folder then: Propagate
inheritable permissions** para não sobrescrever as permissões NTFS existentes.

> Existe também **Global Object Access Auditing > File system**, que audita
> o volume inteiro sem mexer em cada pasta. É prático, mas gera muito mais
> eventos; prefira SACLs nas pastas dos compartilhamentos.

## 3. Tamanho e retenção do log Security

O agente guarda um bookmark e só avança depois que o servidor confirma o
recebimento; enquanto o servidor central estiver fora do ar, o próprio log
Security funciona como fila. Se o log encher e sobrescrever eventos antes do
envio, eles se perdem.

`Computer Configuration > Policies > Windows Settings > Security Settings > Event Log`
(`... > Configurações de Segurança > Log de Eventos`)

- **Maximum security log size** (Tamanho máximo do log de segurança): **1048576 KB** (1 GB) ou mais
- **Retention method for security log**: **Overwrite events as needed**

## 4. Aplicar e conferir

No servidor de arquivos:

```powershell
gpupdate /force

# Subcategorias (GUIDs funcionam em qualquer idioma do Windows)
auditpol /get /subcategory:"{0CCE921D-69AE-11D9-BED3-505054503030}"   # File System
auditpol /get /subcategory:"{0CCE9244-69AE-11D9-BED3-505054503030}"   # Detailed File Share

# Crie/altere/apague um arquivo de teste numa pasta auditada e confira:
wevtutil qe Security /q:"*[System[(EventID=4663 or EventID=4660 or EventID=5145)]]" /c:5 /rd:true /f:text
```

Se `auditpol` mostrar *No Auditing* (Sem Auditoria), a GPO não foi aplicada:
confira com `gpresult /r /scope:computer` se ela aparece em *Applied Group Policy Objects*.

## Referência rápida dos eventos

| ID | Quando | Observação |
|---|---|---|
| 4656 | Um handle para o objeto foi solicitado | Com **Failure**, registra tentativas negadas (acesso sem permissão) |
| 4663 | Houve tentativa de acesso ao objeto | Traz caminho, usuário e `AccessMask` com a ação |
| 4660 | Um objeto foi excluído | Não traz caminho; o agente o resolve pelo `HandleId` do 4656/4663 anterior |
| 5145 | Acesso a arquivo via compartilhamento de rede | Traz IP do cliente e nome do compartilhamento |
