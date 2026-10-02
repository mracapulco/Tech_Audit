import { BadRequestException, Body, Controller, HttpCode, Logger, Post, Req, UseGuards } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AgentAuthGuard, AgentIdentityGuard, type AgentRequest } from './agent-auth.guard.js';
import { BatchError, parseBatch, parseHeartbeat } from './batch.js';
import { IngestService } from './ingest.service.js';

@Controller('v1')
export class IngestController {
  private readonly logger = new Logger(IngestController.name);

  constructor(private readonly ingest: IngestService) {}

  // Recebe um lote do agente (JSON, normalmente gzip). Qualquer 2xx é o ACK
  // que faz o agente avançar o bookmark do Event Log.
  @Post('events')
  @HttpCode(200)
  @UseGuards(AgentAuthGuard)
  async events(@Req() req: AgentRequest, @Body() body: unknown) {
    let batch;
    try {
      batch = parseBatch(body);
    } catch (err) {
      if (err instanceof BatchError) throw new BadRequestException(err.message);
      throw err;
    }
    for (const r of batch.rejected.slice(0, 5)) {
      this.logger.warn(`agente ${req.agent.id}, lote ${batch.batchId}: evento ${r.index} descartado (${r.reason})`);
    }
    const sha256 = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    return this.ingest.ingest(req.agent, batch, sha256);
  }

  // Sinal de vida enviado pelo agente a cada minuto, mesmo sem eventos.
  @Post('heartbeat')
  @HttpCode(200)
  @UseGuards(AgentIdentityGuard)
  async heartbeat(@Req() req: AgentRequest, @Body() body: unknown) {
    await this.ingest.heartbeat(req.agent, parseHeartbeat(body));
    return { ok: true, server_time: new Date().toISOString() };
  }
}
