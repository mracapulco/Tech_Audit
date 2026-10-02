import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // `prisma generate` não precisa do banco; migrate exige DATABASE_URL definido.
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
