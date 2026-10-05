// Leitura do inventário enviado pelo agente em POST /v1/permissions, sem
// acesso a banco.

export class PermissionsInputError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FOLDERS = 1000;
const MAX_ENTRIES = 2000;

export const SOURCES = ['ntfs', 'posix', 'share'] as const;
export const REASONS = ['root', 'explicit', 'protected', 'changed', 'share', 'error'] as const;
export const KINDS = ['user', 'group', 'other', 'unknown'] as const;
export const ACCESS = ['allow', 'deny'] as const;

export interface PermissionRow {
  folderPath: string;
  depth: number;
  source: string;
  share: string | null;
  owner: string | null;
  protected: boolean;
  reason: string;
  folderError: string | null;
  principal: string | null;
  sid: string | null;
  kind: string | null;
  access: string | null;
  rights: string | null;
  raw: string | null;
  inherited: boolean;
  appliesTo: string | null;
}

export interface PermissionUpload {
  scanId: string;
  pathId: string;
  part: number;
  final: boolean;
  startedAt: Date;
  finishedAt: Date;
  scanned: number;
  truncated: boolean;
  error: string | null;
  folders: number;
  rows: PermissionRow[];
}

const obj = (v: unknown, what: string): Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new PermissionsInputError(`${what} deve ser um objeto JSON`);
  return v as Record<string, unknown>;
};

const list = (v: unknown, what: string, max: number): unknown[] => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new PermissionsInputError(`${what} deve ser uma lista`);
  if (v.length > max) throw new PermissionsInputError(`${what}: no máximo ${max} itens`);
  return v;
};

const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v !== '' ? v.replace(/\u0000/g, '').slice(0, max) : null);

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T | null): T | null =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

const int = (v: unknown, what: string, max = 100_000_000): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > max) throw new PermissionsInputError(`${what} inválido`);
  return v;
};

const date = (v: unknown, what: string): Date => {
  const d = typeof v === 'string' ? new Date(v) : new Date(NaN);
  if (Number.isNaN(d.getTime())) throw new PermissionsInputError(`${what} inválido`);
  return d;
};

export function parsePermissionUpload(body: unknown): PermissionUpload {
  const b = obj(body, 'corpo');
  if (typeof b.scan_id !== 'string' || !UUID.test(b.scan_id)) throw new PermissionsInputError('scan_id inválido');
  if (typeof b.path_id !== 'string' || !UUID.test(b.path_id)) throw new PermissionsInputError('path_id inválido');
  const folders = list(b.folders, 'folders', MAX_FOLDERS);
  const rows: PermissionRow[] = [];
  for (const raw of folders) {
    const f = obj(raw, 'pasta');
    const folderPath = text(f.path, 4096);
    if (!folderPath) throw new PermissionsInputError('pasta sem caminho');
    const base = {
      folderPath,
      depth: typeof f.depth === 'number' && Number.isInteger(f.depth) && f.depth >= 0 ? Math.min(f.depth, 10_000) : 0,
      source: oneOf(f.source, SOURCES, 'ntfs')!,
      share: text(f.share, 255),
      owner: text(f.owner, 512),
      protected: f.protected === true,
      reason: oneOf(f.reason, REASONS, 'explicit')!,
      folderError: text(f.error, 2000),
    };
    const entries = list(f.entries, 'entries', MAX_ENTRIES);
    if (entries.length === 0) {
      rows.push({ ...base, principal: null, sid: null, kind: null, access: null, rights: null, raw: null, inherited: false, appliesTo: null });
      continue;
    }
    for (const re of entries) {
      const e = obj(re, 'permissão');
      rows.push({
        ...base,
        principal: text(e.principal, 512) ?? '(sem nome)',
        sid: text(e.sid, 255),
        kind: oneOf(e.kind, KINDS, 'unknown'),
        access: oneOf(e.access, ACCESS, 'allow'),
        rights: text(e.rights, 255),
        raw: text(e.raw, 255),
        inherited: e.inherited === true,
        appliesTo: text(e.applies_to, 255),
      });
    }
  }
  return {
    scanId: b.scan_id.toLowerCase(),
    pathId: b.path_id.toLowerCase(),
    part: int(b.part, 'part', 100_000),
    final: b.final === true,
    startedAt: date(b.started_at, 'started_at'),
    finishedAt: date(b.finished_at, 'finished_at'),
    scanned: int(b.scanned ?? 0, 'scanned'),
    truncated: b.truncated === true,
    error: text(b.error, 2000),
    folders: folders.length,
    rows,
  };
}
