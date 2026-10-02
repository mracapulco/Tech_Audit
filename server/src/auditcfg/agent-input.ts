// Leitura dos corpos enviados pelo agente em /v1/config/*, sem acesso a banco.

export class AgentInputError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ITEMS = 1000;
const MAX_TEXT = 32 * 1024;

export const OPERATIONS = ['apply', 'remove', 'verify'] as const;
export const RESULT_STATUSES = ['applied', 'removed', 'error', 'divergent'] as const;

// Estado antes/depois de uma aplicação: SDDL da SACL e política do auditpol.
export interface AuditState {
  sacl?: string;
  policy?: string;
}

export interface AgentResult {
  pathId: string;
  operation: (typeof OPERATIONS)[number];
  status: (typeof RESULT_STATUSES)[number];
  message: string | null;
  before: AuditState | null;
  after: AuditState | null;
}

export interface SizeReport {
  pathId: string;
  sizeBytes: bigint | null;
  error: string | null;
}

const obj = (v: unknown, what: string): Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new AgentInputError(`${what} deve ser um objeto JSON`);
  return v as Record<string, unknown>;
};

const list = (v: unknown, what: string): unknown[] => {
  if (!Array.isArray(v)) throw new AgentInputError(`${what} deve ser uma lista`);
  if (v.length > MAX_ITEMS) throw new AgentInputError(`${what}: no máximo ${MAX_ITEMS} itens`);
  return v;
};

const optText = (v: unknown, max = MAX_TEXT): string | null => (typeof v === 'string' && v !== '' ? v.slice(0, max) : null);

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], what: string): T => {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    throw new AgentInputError(`${what} inválido (use ${allowed.join(', ')})`);
  }
  return v as T;
};

const pathId = (v: unknown): string => {
  if (typeof v !== 'string' || !UUID.test(v)) throw new AgentInputError('path_id inválido');
  return v.toLowerCase();
};

function state(v: unknown): AuditState | null {
  if (v === undefined || v === null) return null;
  const o = obj(v, 'before/after');
  const s: AuditState = {};
  const sacl = optText(o.sacl);
  const policy = optText(o.policy);
  if (sacl !== null) s.sacl = sacl;
  if (policy !== null) s.policy = policy;
  return s;
}

export function parseResults(body: unknown): { version: number; results: AgentResult[] } {
  const b = obj(body, 'corpo');
  const version = b.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) throw new AgentInputError('version inválida');
  const results = list(b.results, 'results').map((r) => {
    const o = obj(r, 'resultado');
    return {
      pathId: pathId(o.path_id),
      operation: oneOf(o.operation, OPERATIONS, 'operation'),
      status: oneOf(o.status, RESULT_STATUSES, 'status'),
      message: optText(o.message, 2000),
      before: state(o.before),
      after: state(o.after),
    };
  });
  return { version, results };
}

export function parseSizes(body: unknown): SizeReport[] {
  const b = obj(body, 'corpo');
  return list(b.paths, 'paths').map((r) => {
    const o = obj(r, 'tamanho');
    const error = optText(o.error, 2000);
    let sizeBytes: bigint | null = null;
    if (o.size_bytes !== undefined && o.size_bytes !== null) {
      const n = o.size_bytes;
      if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw new AgentInputError('size_bytes inválido');
      sizeBytes = BigInt(n);
    }
    if (sizeBytes === null && error === null) throw new AgentInputError('informe size_bytes ou error');
    return { pathId: pathId(o.path_id), sizeBytes, error };
  });
}
