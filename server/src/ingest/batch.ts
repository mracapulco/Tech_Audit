import { isIP } from 'node:net';

// Validação do lote enviado pelo agente (formato em agent/README.md e
// agent/internal/event/event.go), sem acesso a banco.

export const MAX_EVENTS_PER_BATCH = 10_000;

export interface AgentEvent {
  recordId: string; // bigint como texto, para não perder precisão
  eventId: number;
  kind: string;
  time: Date;
  computer: string | null;
  user: { name: string; domain: string; sid: string | null; logonId: string | null };
  path: string | null;
  objectType: string | null;
  shareName: string | null;
  clientIp: string | null;
  process: string | null;
  actions: string[];
  accessMask: number | null;
  success: boolean;
  handleId: string | null;
}

export interface ParsedBatch {
  batchId: string;
  hostname: string | null;
  agentVersion: string | null;
  events: AgentEvent[];
  // Eventos descartados por estarem malformados. Não recusamos o lote inteiro
  // por causa deles: o agente reenviaria o mesmo lote para sempre.
  rejected: { index: number; reason: string }[];
}

export class BatchError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

export function parseBatch(body: unknown): ParsedBatch {
  if (!isObj(body)) throw new BatchError('corpo deve ser um objeto JSON');
  const batchId = body.batch_id;
  if (typeof batchId !== 'string' || !UUID.test(batchId)) throw new BatchError('batch_id deve ser um UUID');
  if (!Array.isArray(body.events)) throw new BatchError('events deve ser uma lista');
  if (body.events.length > MAX_EVENTS_PER_BATCH) {
    throw new BatchError(`lote com mais de ${MAX_EVENTS_PER_BATCH} eventos`);
  }
  const events: AgentEvent[] = [];
  const rejected: ParsedBatch['rejected'] = [];
  body.events.forEach((raw, index) => {
    try {
      events.push(parseEvent(raw));
    } catch (err) {
      rejected.push({ index, reason: (err as Error).message });
    }
  });
  return {
    batchId: batchId.toLowerCase(),
    hostname: str(body.hostname),
    agentVersion: str(body.agent_version),
    events,
    rejected,
  };
}

function parseEvent(e: unknown): AgentEvent {
  if (!isObj(e)) throw new Error('evento deve ser um objeto');
  const recordId = e.record_id;
  if (typeof recordId !== 'number' || !Number.isSafeInteger(recordId) || recordId < 0) {
    throw new Error('record_id inválido');
  }
  if (typeof e.event_id !== 'number' || !Number.isInteger(e.event_id)) throw new Error('event_id inválido');
  const kind = str(e.kind);
  if (!kind) throw new Error('kind ausente');
  const time = typeof e.time === 'string' ? new Date(e.time) : null;
  if (!time || Number.isNaN(time.getTime())) throw new Error('time inválido');
  if (!isObj(e.user)) throw new Error('user ausente');
  const name = str(e.user.name);
  if (!name) throw new Error('user.name ausente');
  if (!Array.isArray(e.actions) || !e.actions.every((a) => typeof a === 'string')) {
    throw new Error('actions deve ser uma lista de textos');
  }
  if (e.outcome !== 'success' && e.outcome !== 'failure') throw new Error('outcome inválido');

  return {
    recordId: String(recordId),
    eventId: e.event_id,
    kind,
    time,
    computer: str(e.computer),
    user: { name, domain: str(e.user.domain) ?? '', sid: str(e.user.sid), logonId: str(e.user.logon_id) },
    path: str(e.path),
    objectType: str(e.object_type),
    shareName: str(e.share_name),
    clientIp: parseIp(e.client_ip),
    process: str(e.process),
    actions: e.actions as string[],
    accessMask: parseMask(e.access_mask),
    success: e.outcome === 'success',
    handleId: str(e.handle_id),
  };
}

// "0x2" -> 2. Valores fora de 32 bits viram nulo (a coluna é integer).
function parseMask(v: unknown): number | null {
  if (typeof v !== 'string' || !/^0x[0-9a-f]{1,8}$/i.test(v)) return null;
  const n = parseInt(v, 16);
  return n <= 0x7fffffff ? n : null;
}

// O 5145 traz "::ffff:10.0.0.5", ou "-" quando o acesso é local.
function parseIp(v: unknown): string | null {
  // O inet do PostgreSQL não aceita zona IPv6 (fe80::1%eth0).
  return typeof v === 'string' && !v.includes('%') && isIP(v) !== 0 ? v : null;
}

// Chave do dicionário de identidades: SID quando houver, senão DOMINIO\usuario.
export function identityKey(u: AgentEvent['user']): string {
  return (u.sid ?? `${u.domain}\\${u.name}`).toLowerCase();
}
