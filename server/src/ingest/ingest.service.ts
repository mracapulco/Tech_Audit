import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { PgService } from '../db/pg.service.js';
import type { AuthenticatedAgent } from './agent-auth.guard.js';
import { identityKey, ParsedBatch } from './batch.js';

export interface IngestResult {
  batch_id: string;
  // true quando o lote já tinha sido recebido (reenvio após falha no ACK).
  duplicate_batch: boolean;
  received: number;
  inserted: number;
  duplicates: number;
  rejected: number;
}

// Hash do caminho em minúsculas: o NTFS não diferencia maiúsculas.
const pathHash = (p: string) => createHash('sha256').update(p.toLowerCase()).digest('hex');

@Injectable()
export class IngestService {
  constructor(private readonly pg: PgService) {}

  async ingest(agent: AuthenticatedAgent, batch: ParsedBatch, contentSha256: string): Promise<IngestResult> {
    const client = await this.pg.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE agents SET last_seen_at = now(),
           hostname = COALESCE($2, hostname), agent_version = COALESCE($3, agent_version)
         WHERE id = $1`,
        [agent.id, batch.hostname, batch.agentVersion],
      );

      const claimed = await client.query(
        `INSERT INTO ingest_batches
           (agent_id, batch_id, tenant_id, event_count, inserted_count, rejected_count, sha256)
         VALUES ($1, $2, $3, $4, 0, $5, $6)
         ON CONFLICT DO NOTHING`,
        [agent.id, batch.batchId, agent.tenantId, batch.events.length, batch.rejected.length, contentSha256],
      );
      if (claimed.rowCount === 0) {
        // Lote já gravado: confirma de novo para o agente avançar o bookmark.
        const { rows } = await client.query(
          `SELECT event_count, inserted_count, rejected_count FROM ingest_batches
           WHERE agent_id = $1 AND batch_id = $2`,
          [agent.id, batch.batchId],
        );
        await client.query('COMMIT');
        const r = rows[0];
        return {
          batch_id: batch.batchId,
          duplicate_batch: true,
          received: r.event_count,
          inserted: 0,
          duplicates: r.event_count,
          rejected: r.rejected_count,
        };
      }

      const pathIds = await this.upsertPaths(client, agent, batch);
      const identityIds = await this.upsertIdentities(client, agent, batch);
      const inserted = await this.insertEvents(client, agent, batch, pathIds, identityIds);

      await client.query(
        'UPDATE ingest_batches SET inserted_count = $3 WHERE agent_id = $1 AND batch_id = $2',
        [agent.id, batch.batchId, inserted],
      );
      await client.query('COMMIT');
      return {
        batch_id: batch.batchId,
        duplicate_batch: false,
        received: batch.events.length,
        inserted,
        duplicates: batch.events.length - inserted,
        rejected: batch.rejected.length,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  private async upsertPaths(client: Client, agent: AuthenticatedAgent, batch: ParsedBatch) {
    const byHash = new Map<string, string>();
    for (const e of batch.events) if (e.path) byHash.set(pathHash(e.path), e.path);
    const ids = new Map<string, string>();
    if (byHash.size === 0) return ids;
    // Ordem fixa reduz deadlocks entre lotes concorrentes.
    const hashes = [...byHash.keys()].sort();
    const { rows } = await client.query<{ id: string; h: string }>(
      `INSERT INTO paths (tenant_id, agent_id, path_hash, path)
       SELECT $1, $2, decode(h, 'hex'), p FROM unnest($3::text[], $4::text[]) AS t(h, p)
       ON CONFLICT (agent_id, path_hash) DO UPDATE SET path = paths.path
       RETURNING id, encode(path_hash, 'hex') AS h`,
      [agent.tenantId, agent.id, hashes, hashes.map((h) => byHash.get(h))],
    );
    for (const r of rows) ids.set(r.h, r.id);
    return ids;
  }

  private async upsertIdentities(client: Client, agent: AuthenticatedAgent, batch: ParsedBatch) {
    const byKey = new Map<string, ParsedBatch['events'][number]['user']>();
    for (const e of batch.events) byKey.set(identityKey(e.user), e.user);
    const ids = new Map<string, string>();
    if (byKey.size === 0) return ids;
    const keys = [...byKey.keys()].sort();
    const users = keys.map((k) => byKey.get(k)!);
    const { rows } = await client.query<{ id: string; key: string }>(
      `INSERT INTO identities (tenant_id, key, sid, domain, name)
       SELECT $1, k, s, d, n FROM unnest($2::text[], $3::text[], $4::text[], $5::text[]) AS t(k, s, d, n)
       ON CONFLICT (tenant_id, key) DO UPDATE
         SET sid = COALESCE(EXCLUDED.sid, identities.sid), domain = EXCLUDED.domain, name = EXCLUDED.name
       RETURNING id, key`,
      [agent.tenantId, keys, users.map((u) => u.sid), users.map((u) => u.domain), users.map((u) => u.name)],
    );
    for (const r of rows) ids.set(r.key, r.id);
    return ids;
  }

  private async insertEvents(
    client: Client,
    agent: AuthenticatedAgent,
    batch: ParsedBatch,
    pathIds: Map<string, string>,
    identityIds: Map<string, string>,
  ): Promise<number> {
    const ev = batch.events;
    if (ev.length === 0) return 0;
    const details = ev.map((e) => {
      const d: Record<string, string> = {};
      if (e.handleId) d.handle_id = e.handleId;
      if (e.user.logonId) d.logon_id = e.user.logonId;
      if (e.computer) d.computer = e.computer;
      return Object.keys(d).length ? JSON.stringify(d) : null;
    });
    const res = await client.query(
      `INSERT INTO events.file_events
         (time, tenant_id, agent_id, batch_id, source_record_id, source_event_id, kind, path_id,
          identity_id, actions, success, access_mask, object_type, share_name, source_ip,
          process_name, details)
       SELECT t.time, $1, $2, $3, t.rid, t.eid, t.kind, t.path_id, t.identity_id,
              ARRAY(SELECT jsonb_array_elements_text(t.actions)), t.success, t.mask, t.otype,
              t.share, t.ip, t.proc, t.details
       FROM unnest($4::timestamptz[], $5::bigint[], $6::int[], $7::text[], $8::bigint[], $9::bigint[],
                   $10::jsonb[], $11::bool[], $12::int[], $13::text[], $14::text[], $15::inet[],
                   $16::text[], $17::jsonb[])
         AS t(time, rid, eid, kind, path_id, identity_id, actions, success, mask, otype, share, ip, proc, details)
       ON CONFLICT DO NOTHING`,
      [
        agent.tenantId,
        agent.id,
        batch.batchId,
        ev.map((e) => e.time),
        ev.map((e) => e.recordId),
        ev.map((e) => e.eventId),
        ev.map((e) => e.kind),
        ev.map((e) => (e.path ? pathIds.get(pathHash(e.path)) : null)),
        ev.map((e) => identityIds.get(identityKey(e.user))),
        ev.map((e) => JSON.stringify(e.actions)),
        ev.map((e) => e.success),
        ev.map((e) => e.accessMask),
        ev.map((e) => e.objectType),
        ev.map((e) => e.shareName),
        ev.map((e) => e.clientIp),
        ev.map((e) => e.process),
        details,
      ],
    );
    return res.rowCount ?? 0;
  }
}

type Client = pg.PoolClient;
