# Tech Audit — portal web

Portal Next.js do cliente e da equipe Tech Master (docs/ARCHITECTURE.md, seção 7).

| Tela | O que faz |
|---|---|
| `/login` | E-mail e senha. A sessão fica em cookie `httpOnly` (`ta_session`) por 12 horas |
| `/eventos` | Pesquisa por usuário, caminho (prefixo, inclui subpastas), ação e período, 50 por página |
| `/eventos/exportar` | Baixa em CSV o resultado dos filtros atuais (até 100 mil linhas) |
| `/admin/empresas` | Administrador: empresas, com licença, servidores e usuários |
| `/admin/empresas/[id]` | Administrador: licenças, tokens de instalação do agente, servidores e nome |
| `/admin/usuarios` | Administrador: cadastrar, desativar e gerar nova senha |

Perfis: **Administrador** (equipe Tech Master, acesso a tudo) e **Cliente**
(vê só os eventos da própria empresa).

O navegador só fala com o Next.js; o Next.js chama a API (`server/`) pelo
servidor, repassando o token da sessão. Usuários de cliente veem só a própria
empresa; a equipe Tech Master escolhe o cliente ou vê todos.

```sh
cp .env.example .env   # API_URL=http://localhost:3001
npm install
npm run dev            # http://localhost:3000
npm test               # testes dos filtros (node --test)
```

`PUBLIC_AGENT_URL` é o endereço da API que vai no `agent.json` gerado junto
com o token de instalação.

Horários: os campos "De" e "Até" e a tabela usam o horário de Brasília (UTC-3).
