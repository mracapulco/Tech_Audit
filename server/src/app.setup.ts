import { RequestMethod } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';

// Configuração comum ao main.ts e aos testes.
export function configureApp(app: NestExpressApplication): NestExpressApplication {
  // Portal em /api; agentes em /v1 (endpoint configurado no agent.json).
  app.setGlobalPrefix('api', { exclude: [{ path: 'v1/{*path}', method: RequestMethod.ALL }] });
  // Lotes chegam com Content-Encoding: gzip; o limite vale para o JSON já
  // descompactado, o que também barra "bombas" de compressão.
  app.useBodyParser('json', { limit: process.env.INGEST_MAX_BODY ?? '25mb' });
  app.enableShutdownHooks();
  return app;
}
