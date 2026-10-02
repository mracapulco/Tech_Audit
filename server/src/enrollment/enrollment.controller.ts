import { BadRequestException, Body, Controller, HttpCode, Post } from '@nestjs/common';
import { EnrollmentService } from './enrollment.service.js';

const field = (body: Record<string, unknown>, name: string, max = 255): string => {
  const v = body[name];
  if (typeof v !== 'string' || v.trim() === '' || v.length > max) {
    throw new BadRequestException(`${name} é obrigatório (texto de até ${max} caracteres)`);
  }
  return v.trim();
};

@Controller('v1')
export class EnrollmentController {
  constructor(private readonly enrollment: EnrollmentService) {}

  // Primeiro contato do agente: troca o token de registro (gerado no portal)
  // por um agent_id e um token próprio, se a licença do tenant permitir.
  @Post('enroll')
  @HttpCode(201)
  async enroll(@Body() body: unknown) {
    if (typeof body !== 'object' || body === null) throw new BadRequestException('corpo deve ser um objeto JSON');
    const b = body as Record<string, unknown>;
    return this.enrollment.enroll({
      enrollmentToken: field(b, 'enrollment_token'),
      hostname: field(b, 'hostname'),
      machineId: field(b, 'machine_id', 128),
      os: field(b, 'os'),
      agentVersion: typeof b.agent_version === 'string' ? b.agent_version.slice(0, 64) : null,
    });
  }
}
