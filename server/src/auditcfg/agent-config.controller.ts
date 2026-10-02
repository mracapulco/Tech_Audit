import { BadRequestException, Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { AgentAuthGuard, type AgentRequest } from '../ingest/agent-auth.guard.js';
import { AgentInputError, parseResults, parseSizes } from './agent-input.js';
import { AuditConfigService } from './audit-config.service.js';

function parsed<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof AgentInputError) throw new BadRequestException(err.message);
    throw err;
  }
}

// Configuração de auditoria do lado do agente (seção 4.6).
@Controller('v1/config')
@UseGuards(AgentAuthGuard)
export class AgentConfigController {
  constructor(private readonly config: AuditConfigService) {}

  // O agente consulta periodicamente e aplica quando a versão muda.
  @Get()
  get(@Req() req: AgentRequest) {
    return this.config.agentConfig(req.agent);
  }

  @Post('result')
  @HttpCode(200)
  result(@Req() req: AgentRequest, @Body() body: unknown) {
    const { version, results } = parsed(() => parseResults(body));
    return this.config.agentResults(req.agent, version, results);
  }

  @Post('sizes')
  @HttpCode(200)
  sizes(@Req() req: AgentRequest, @Body() body: unknown) {
    return this.config.agentSizes(req.agent, parsed(() => parseSizes(body)));
  }
}
