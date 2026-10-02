# Tech Audit — portal web

Portal Next.js do cliente e da equipe Tech Master (docs/ARCHITECTURE.md, seção 7).

| Tela | O que faz |
|---|---|
| `/login` | E-mail e senha. A sessão fica em cookie `httpOnly` (`ta_session`) por 12 horas |
| `/eventos` | Pesquisa por usuário, caminho (prefixo, inclui subpastas), ação e período, 50 por página |
| `/eventos/exportar` | Baixa em CSV o resultado dos filtros atuais (até 100 mil linhas) |

O navegador só fala com o Next.js; o Next.js chama a API (`server/`) pelo
servidor, repassando o token da sessão. Usuários de cliente veem só a própria
empresa; a equipe Tech Master escolhe o cliente ou vê todos.

```sh
cp .env.example .env   # API_URL=http://localhost:3001
npm install
npm run dev            # http://localhost:3000
npm test               # testes dos filtros (node --test)
```

Os usuários são criados pela CLI do servidor até existir a tela de usuários
(veja `server/README.md`).

Horários: os campos "De" e "Até" e a tabela usam o horário de Brasília (UTC-3).
