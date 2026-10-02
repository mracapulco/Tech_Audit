import { Injectable, OnModuleDestroy } from '@nestjs/common';
import pg from 'pg';

// Pool do driver pg para SQL direto (ingestão em lote na hypertable), fora do Prisma.
@Injectable()
export class PgService extends pg.Pool implements OnModuleDestroy {
  constructor() {
    super({ connectionString: process.env.DATABASE_URL });
  }

  async onModuleDestroy() {
    await this.end();
  }
}
