import { BadRequestException } from '@nestjs/common';
import { parseDay } from './admin.js';

// Regras da limpeza de eventos (tela Limpeza do portal), sem acesso a banco.

const DAY_MS = 24 * 3600_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export type PurgeMode = 'manual' | 'retention';

// O que foi pedido, antes de consultar licença e servidores.
export interface PurgeRequest {
  tenantId: string;
  agentId: string | null;
  mode: PurgeMode;
  // Só no modo manual. Dias inteiros no horário de Brasília; from vazio = desde o início.
  from: Date | null;
  to: Date | null;
}

// Período efetivo: eventos com from <= time < to.
export interface PurgeRange {
  from: Date | null;
  to: Date;
}

type Input = Record<string, unknown>;

const str = (b: Input, name: string): string | null => {
  const v = b[name];
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw new BadRequestException(`${name} inválido`);
  return v.trim() || null;
};

const uuid = (b: Input, name: string, label: string, required: boolean): string | null => {
  const v = str(b, name);
  if (!v) {
    if (required) throw new BadRequestException(`${label} é obrigatória`);
    return null;
  }
  if (!UUID.test(v)) throw new BadRequestException(`${label} inválido`);
  return v.toLowerCase();
};

const day = (b: Input, name: string, label: string, end: boolean): Date | null => {
  const v = str(b, name);
  if (!v) return null;
  if (!DAY.test(v)) throw new BadRequestException(`${label} deve estar no formato AAAA-MM-DD`);
  const d = parseDay(v, end);
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`${label} inválida`);
  return d;
};

// Lê o pedido vindo da query (prévia) ou do corpo (execução).
export function parsePurgeRequest(b: Input): PurgeRequest {
  const mode = str(b, 'mode') ?? 'manual';
  if (mode !== 'manual' && mode !== 'retention') throw new BadRequestException('modo inválido');
  const req: PurgeRequest = {
    tenantId: uuid(b, 'tenant_id', 'A empresa', true)!,
    agentId: uuid(b, 'agent_id', 'Servidor', false),
    mode,
    from: null,
    to: null,
  };
  if (mode === 'manual') {
    req.from = day(b, 'from', 'Data inicial', false);
    req.to = day(b, 'to', 'Data final', true);
    // Sem data final seria "apagar tudo" por engano; para isso, informe hoje.
    if (!req.to) throw new BadRequestException('informe a data final do período');
    if (req.from && req.from >= req.to) throw new BadRequestException('a data inicial deve ser antes da final');
  }
  return req;
}

// Início do dia de hoje em Brasília (UTC-3, sem horário de verão).
export function startOfTodayBrasilia(now: Date): Date {
  const local = new Date(now.getTime() - 3 * 3600_000).toISOString().slice(0, 10);
  return new Date(`${local}T00:00:00-03:00`);
}

// Modo retenção: mantém os últimos N dias inteiros e apaga o que vier antes.
export function retentionCutoff(retentionDays: number, now: Date): Date {
  return new Date(startOfTodayBrasilia(now).getTime() - retentionDays * DAY_MS);
}

// Retenção que vale para a empresa: a maior entre as licenças que contam agora
// (vigentes ou em tolerância). Nenhuma = não dá para limpar pela retenção.
export function effectiveRetention(licenses: { retentionDays: number }[]): number | null {
  return licenses.length ? Math.max(...licenses.map((l) => l.retentionDays)) : null;
}

export function resolveRange(req: PurgeRequest, retentionDays: number | null, now: Date): PurgeRange {
  if (req.mode === 'manual') return { from: req.from, to: req.to! };
  if (retentionDays === null) {
    throw new BadRequestException('a empresa não tem licença vigente; escolha o período manualmente');
  }
  return { from: null, to: retentionCutoff(retentionDays, now) };
}

// Janelas de um dia (alinhadas à meia-noite UTC, como as partes da hypertable)
// entre o primeiro e o último evento encontrados. Cada janela é um DELETE
// próprio, para a transação não crescer com o período inteiro.
export function dayWindows(range: PurgeRange, first: Date, last: Date): PurgeRange[] {
  const start = Math.max(first.getTime(), range.from?.getTime() ?? -Infinity);
  const end = Math.min(last.getTime() + 1, range.to.getTime());
  const out: PurgeRange[] = [];
  for (let t = Math.floor(start / DAY_MS) * DAY_MS; t < end; t += DAY_MS) {
    out.push({ from: new Date(Math.max(t, start)), to: new Date(Math.min(t + DAY_MS, end)) });
  }
  return out;
}
