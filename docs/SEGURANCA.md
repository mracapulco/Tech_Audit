# Revisão de segurança (2026-10-02)

Revisão do portal (`web/`), da API (`server/`), do banco e do agente Windows
(`agent/`), olhando principalmente: um cliente nunca ver dados de outro,
quem pode entrar no portal, o que fica exposto na internet, o caminho dos
dados do agente até o banco e o que o agente faz no servidor do cliente.

## O que já estava bem

- **Separação entre clientes.** Toda consulta de eventos, relatórios, painel e
  configuração passa por `tenantScope`/`tenantFor`: o usuário do cliente só
  enxerga a própria empresa, mesmo mudando o `?tenant=` na URL. Caminhos,
  servidores e alertas de outra empresa respondem "não encontrado".
- **Login.** Senhas com Argon2id; a resposta é a mesma para e-mail inexistente
  e senha errada, inclusive no tempo; nenhuma tela lista e-mails; bloqueio após
  5 erros por e-mail+IP e 20 por e-mail em 15 minutos.
- **Sessão.** Token aleatório de 256 bits em cookie `httpOnly` (o navegador
  não lê), `SameSite=Lax`, `Secure` em produção; no banco só o hash; vale
  12 h; desativar usuário ou trocar a senha encerra as sessões.
- **Administração.** Empresas, licenças, tokens e usuários só para
  `msp_admin`, conferido na API (não só na tela).
- **Banco.** Consultas sempre com parâmetros (sem SQL montado com texto do
  usuário); porta só em `127.0.0.1`; histórico de configuração protegido
  contra alteração por gatilho.
- **Exportações.** CSV protegido contra fórmulas do Excel (`=`, `+`, `-`, `@`).
- **Agente.** Token de registro de uso único e com validade; token do agente
  guardado só como hash no servidor; o token de registro some do registro do
  Windows depois do primeiro uso; o tenant vem sempre do token, nunca do lote.

## Corrigido neste PR

1. **A API do portal estava aberta na internet.** A porta publicada para os
   agentes (`API_PORT`) respondia também `/api` (login, administração). Agora
   o servidor tem uma porta só dos agentes (`AGENT_PORT`, 3002 no contêiner)
   que responde apenas `/v1/*`; o portal continua usando a 3001 pela rede
   interna do Docker. No `.env` nada muda.
2. **IP do usuário podia ser inventado.** O portal repassava à API o
   `X-Forwarded-For` inteiro, que o navegador pode preencher. Com isso dava
   para escapar do bloqueio de login por IP e gravar um IP falso no log de
   acesso. Agora só vale o último endereço, o que o proxy (ou o Next.js)
   acrescentou.
3. **Portal sem cabeçalhos de segurança.** Agora não pode ser aberto dentro
   de outro site (evita "clickjacking", quando um site falso esconde o portal
   atrás de botões), o navegador não adivinha tipo de arquivo e o servidor não
   anuncia a tecnologia usada (`X-Powered-By`).
4. **Pasta do agente podia ser preparada por qualquer usuário do servidor do
   cliente.** No Windows, qualquer usuário pode criar pastas em
   `C:\ProgramData`. Se alguém criasse `C:\ProgramData\TechAudit` antes da
   instalação, o serviço (que roda como SYSTEM) aceitava a pasta e um
   `agent.json` deixado ali, mandando os eventos para outro servidor ou
   gravando arquivos onde a pessoa quisesse. Agora o agente só usa a pasta se
   o dono for SYSTEM ou Administradores e ela não for um atalho, e sempre
   reaplica a permissão restrita. Na instalação normal (MSI) nada muda.
5. **Agente aceitava `http://` para qualquer endereço.** O token do agente e
   os eventos (usuários, caminhos, IPs) poderiam ir sem criptografia pela
   internet. Agora `http://` só é aceito para `localhost` e IPs da rede local
   (testes); fora disso, só `https://`.

## Decisões que dependem do Rafael

1. **Proxy reverso com HTTPS em produção.** Falta escolher qual (Traefik,
   Nginx, Caddy) e como os certificados serão emitidos. Sugestão: o mesmo que
   já roda no Tech_Hub, com certificado automático (Let's Encrypt). Só o
   proxy deve ficar aberto para a internet (portas 80 e 443).
2. **Verificação em duas etapas para a equipe Tech Master.** O administrador
   enxerga todas as empresas; uma senha vazada expõe todos os clientes.
   Sugestão: código no celular (aplicativo autenticador) obrigatório para
   `msp_admin` e `msp_operator` antes da produção.
3. **Assinatura digital do agente.** Sem um certificado de assinatura de
   código, o Windows mostra alerta ao instalar e não há como provar que o
   `.exe` não foi alterado. Exige comprar o certificado (custo anual).
4. **Backup.** Onde fica a cópia fora do servidor e se ela é criptografada.

## Próximos itens técnicos (sem decisão pendente)

- **Retenção (LGPD).** Os planos de 90 dias / 1 ano / 5 anos ainda não apagam
  eventos antigos. Os eventos têm nomes de usuários, IPs e nomes de arquivos,
  que são dados pessoais; guardar além do contratado é risco legal.
- **mTLS dos agentes** antes da venda, como já decidido.
- **Usuário próprio do banco para a API**, sem privilégio de superusuário.
- **Bloqueio de login compartilhado** (hoje fica em memória; com mais de uma
  instância da API, mover para o banco ou Redis).
- **Senha do banco obrigatória no `.env`** (hoje, sem `.env`, o padrão é
  `techaudit`; o banco só escuta em `127.0.0.1`, o que reduz o risco).
