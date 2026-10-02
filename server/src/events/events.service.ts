import { ForbiddenException, Injectable } from '@nestjs/common';
import { isMspRole, type PortalUser } from '../auth/roles.js';
import { PgService } from '../db/pg.service.js';
import {
  buildEventQuery,
  cursorOf,
  encodeCursor,
  FilterError,
  type Cursor,
  type EventFilters,
  type EventRow,
} from './event-query.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Tenants que o usuário pode consultar. Cliente: sempre só o próprio tenant.
// Tech Master: o tenant pedido, ou todos quando nenhum for informado.
export function tenantScope(user: Pick<PortalUser, 'role' | 'tenantId'>, requested: unknown): string[] | null {
  if (requested !== undefined && requested !== '' && (typeof requested !== 'string' || !UUID.test(requested))) {
    throw new FilterError('tenant inválido');
  }
  const wanted = (requested as string | undefined) || null;
  if (isMspRole(user.role)) return wanted ? [wanted.toLowerCase()] : null;
  if (!user.tenantId) throw new ForbiddenException('usuário sem tenant');
  if (wanted && wanted.toLowerCase() !== user.tenantId) throw new ForbiddenException('sem acesso a este cliente');
  return [user.tenantId];
}

export interface EventPage {
  items: EventRow[];
  next_cursor: string | null;
}

@Injectable()
export class EventsService {
  constructor(private readonly pg: PgService) {}

  async search(filters: EventFilters, cursor: Cursor | null, limit: number): Promise<EventPage> {
    const q = buildEventQuery(filters, cursor, limit + 1);
    const { rows } = await this.pg.query<EventRow>(q.text, q.values);
    const more = rows.length > limit;
    const items = more ? rows.slice(0, limit) : rows;
    return { items, next_cursor: more ? encodeCursor(cursorOf(items[items.length - 1])) : null };
  }

  // Percorre todas as páginas, para a exportação, até `max` linhas.
  async *scan(filters: EventFilters, max: number, pageSize = 2000): AsyncGenerator<EventRow> {
    let cursor: Cursor | null = null;
    let sent = 0;
    while (sent < max) {
      const want = Math.min(pageSize, max - sent);
      const q = buildEventQuery(filters, cursor, want);
      const { rows } = await this.pg.query<EventRow>(q.text, q.values);
      for (const r of rows) yield r;
      sent += rows.length;
      if (rows.length < want) return;
      cursor = cursorOf(rows[rows.length - 1]);
    }
  }
}
