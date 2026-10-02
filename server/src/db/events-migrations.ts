import type pg from 'pg';

// Migrations em SQL nativo do schema "events" (TimescaleDB), fora do Prisma
// (docs/ARCHITECTURE.md, seção 6.3). O Prisma só compara o schema "public",
// então estas tabelas não aparecem como divergência no `prisma migrate`.
// Nunca altere uma migration já publicada: adicione uma nova no fim da lista.
export const eventsMigrations: { id: string; sql: string }[] = [
  {
    id: '0001_file_events',
    sql: `
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE events.file_events (
  time             timestamptz NOT NULL,
  tenant_id        uuid        NOT NULL,
  agent_id         uuid        NOT NULL,
  batch_id         uuid        NOT NULL,
  source_record_id bigint      NOT NULL, -- RecordID do Event Log
  source_event_id  integer     NOT NULL, -- 4663, 4660, 4656, 5145...
  kind             text        NOT NULL, -- object_access, object_deleted, handle_request, share_access
  path_id          bigint,               -- public.paths; nulo quando o agente não resolveu o caminho
  identity_id      bigint,               -- public.identities
  actions          text[]      NOT NULL, -- read, write, delete, permission_change...
  success          boolean     NOT NULL,
  access_mask      integer,
  object_type      text,
  share_name       text,
  source_ip        inet,
  process_name     text,
  details          jsonb                 -- handle_id, logon_id, computer
);

SELECT create_hypertable('events.file_events', by_range('time', INTERVAL '1 day'));

-- Entrega "pelo menos uma vez": o mesmo evento reenviado é ignorado.
-- O índice único de uma hypertable precisa incluir a coluna de partição.
CREATE UNIQUE INDEX file_events_dedup ON events.file_events (agent_id, source_record_id, time);
CREATE INDEX file_events_tenant_path ON events.file_events (tenant_id, path_id, time DESC);
CREATE INDEX file_events_tenant_identity ON events.file_events (tenant_id, identity_id, time DESC);

ALTER TABLE events.file_events SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'tenant_id, agent_id',
  timescaledb.compress_orderby = 'time DESC'
);
SELECT add_compression_policy('events.file_events', INTERVAL '7 days');
`,
  },
  {
    // Ações lógicas do agente 0.2 (criou, excluiu, renomeou...). Um ADD COLUMN
    // por comando: hypertables comprimidas não aceitam vários no mesmo ALTER.
    id: '0002_logical_actions',
    sql: `
ALTER TABLE events.file_events ADD COLUMN action text;        -- created, modified, deleted, recycled, renamed, moved...
ALTER TABLE events.file_events ADD COLUMN new_path_id bigint; -- public.paths: destino de renomear/mover/Lixeira
ALTER TABLE events.file_events ADD COLUMN item_type text;     -- file ou folder
ALTER TABLE events.file_events ADD COLUMN event_count integer; -- operações agregadas (nulo = 1)
ALTER TABLE events.file_events ADD COLUMN end_time timestamptz; -- última operação agregada
`,
  },
];

export async function migrateEvents(pool: pg.Pool, log: (msg: string) => void = () => {}): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('CREATE SCHEMA IF NOT EXISTS events');
    await client.query(`CREATE TABLE IF NOT EXISTS events.schema_migrations (
      id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    // Impede duas instâncias migrando ao mesmo tempo.
    await client.query("SELECT pg_advisory_lock(hashtext('techaudit.events_migrations'))");
    try {
      const { rows } = await client.query<{ id: string }>('SELECT id FROM events.schema_migrations');
      const done = new Set(rows.map((r) => r.id));
      for (const m of eventsMigrations) {
        if (done.has(m.id)) continue;
        await client.query('BEGIN');
        try {
          await client.query(m.sql);
          await client.query('INSERT INTO events.schema_migrations (id) VALUES ($1)', [m.id]);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw new Error(`migration ${m.id}: ${(err as Error).message}`);
        }
        applied.push(m.id);
        log(`migration ${m.id} aplicada`);
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext('techaudit.events_migrations'))");
    }
  } finally {
    client.release();
  }
  return applied;
}
