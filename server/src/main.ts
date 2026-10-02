import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createServer } from 'node:http';
import { agentPortFromEnv } from './agent-port.js';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';

async function bootstrap() {
  const app = configureApp(await NestFactory.create<NestExpressApplication>(AppModule));
  await app.listen(Number(process.env.PORT ?? 3001));
  // Com AGENT_PORT, os agentes usam uma porta separada que só responde /v1/*.
  const agentPort = agentPortFromEnv();
  if (agentPort) {
    const agents = createServer(app.getHttpAdapter().getInstance()).listen(agentPort);
    process.once('SIGTERM', () => agents.close());
  }
}

void bootstrap();
