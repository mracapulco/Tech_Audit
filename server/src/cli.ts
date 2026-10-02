import 'reflect-metadata';
import { parseArgs } from 'node:util';
import {
  bootstrapAdmin,
  createEnrollmentToken,
  createLicense,
  createTenant,
  createUser,
  disableAgent,
  parseDay,
  parseVolume,
  setUserPassword,
} from './admin/admin.js';
import { PgService } from './db/pg.service.js';
import { migrateEvents } from './db/events-migrations.js';
import { PrismaService } from './prisma.service.js';

const USAGE = `uso: node dist/cli.js <comando> [opções]

  migrate-events                       aplica as migrations do schema "events" (TimescaleDB)
  tenant:create --name <nome>
  license:create --tenant <id> --max-agents <n> --max-volume <2TB> --valid-until <AAAA-MM-DD>
                 [--valid-from <AAAA-MM-DD>] [--plan <nome>] [--retention-days <n>] [--grace-days <n>]
  token:create --tenant <id> [--ttl-hours 24] [--max-uses 1] [--description <texto>]
  agent:disable --agent <id>
  user:create --email <e-mail> --name <nome> --role <perfil> [--tenant <id>] [--password <senha>]
              perfis: msp_admin, msp_operator (Tech Master, sem --tenant),
                      tenant_admin, tenant_auditor (cliente, com --tenant)
              sem --password, gera uma senha e mostra uma única vez
  user:password --email <e-mail> [--password <senha>]
  admin:bootstrap                      cria o primeiro administrador, se não houver nenhum,
                                       com BOOTSTRAP_ADMIN_EMAIL e BOOTSTRAP_ADMIN_PASSWORD`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: 'string' },
    tenant: { type: 'string' },
    agent: { type: 'string' },
    'max-agents': { type: 'string' },
    'max-volume': { type: 'string' },
    'valid-from': { type: 'string' },
    'valid-until': { type: 'string' },
    plan: { type: 'string' },
    'retention-days': { type: 'string' },
    'grace-days': { type: 'string' },
    'ttl-hours': { type: 'string' },
    'max-uses': { type: 'string' },
    description: { type: 'string' },
    email: { type: 'string' },
    role: { type: 'string' },
    password: { type: 'string' },
  },
});

function need(name: keyof typeof values): string {
  const v = values[name];
  if (typeof v !== 'string' || v === '') throw new Error(`--${name} é obrigatório\n\n${USAGE}`);
  return v;
}
const int = (v: string | undefined) => (v === undefined ? undefined : Number.parseInt(v, 10));
const print = (v: unknown) =>
  console.log(JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 2));

async function main() {
  const cmd = positionals[0];
  if (cmd === 'migrate-events') {
    const pool = new PgService();
    try {
      const applied = await migrateEvents(pool, console.log);
      if (applied.length === 0) console.log('schema "events" já atualizado');
    } finally {
      await pool.end();
    }
    return;
  }
  const db = new PrismaService();
  try {
    switch (cmd) {
      case 'tenant:create':
        return print(await createTenant(db, need('name')));
      case 'license:create':
        return print(
          await createLicense(db, {
            tenantId: need('tenant'),
            plan: values.plan,
            maxAgents: int(need('max-agents'))!,
            maxVolumeBytes: parseVolume(need('max-volume')),
            retentionDays: int(values['retention-days']),
            validFrom: values['valid-from'] ? parseDay(values['valid-from'], false) : new Date(),
            validUntil: parseDay(need('valid-until'), true),
            graceDays: int(values['grace-days']),
          }),
        );
      case 'token:create':
        return print(
          await createEnrollmentToken(db, {
            tenantId: need('tenant'),
            ttlHours: int(values['ttl-hours']),
            maxUses: int(values['max-uses']),
            description: values.description,
          }),
        );
      case 'user:create':
        return print(
          await createUser(db, {
            email: need('email'),
            name: need('name'),
            role: need('role'),
            tenantId: values.tenant,
            password: values.password,
          }),
        );
      case 'admin:bootstrap': {
        const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
        const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
        if (!email || !password) {
          console.log('admin:bootstrap: BOOTSTRAP_ADMIN_EMAIL/PASSWORD não definidos; nada a fazer');
          return;
        }
        const r = await bootstrapAdmin(db, email, password);
        console.log(r.created ? `administrador ${r.email} criado` : 'já existe administrador; nada a fazer');
        return;
      }
      case 'user:password':
        return print(await setUserPassword(db, need('email'), values.password));
      case 'agent:disable':
        return print(await disableAgent(db, need('agent')));
      default:
        console.error(USAGE);
        process.exitCode = 2;
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exitCode = 1;
});
