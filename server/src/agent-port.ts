import type { NextFunction, Request, Response } from 'express';

// Porta só dos agentes (AGENT_PORT). É a única publicada para a internet: nela
// a API responde apenas /v1/*; o portal (/api) fica na porta interna (PORT),
// acessada só pelo contêiner do Next.js.
export function agentPortOnly(agentPort: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.socket.localPort === agentPort && !req.path.startsWith('/v1/')) {
      res.status(404).json({ statusCode: 404, message: 'Not Found' });
      return;
    }
    next();
  };
}

export function agentPortFromEnv(): number | undefined {
  const v = process.env.AGENT_PORT;
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`AGENT_PORT inválida: ${v}`);
  return n;
}
