import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { PrismaService } from './prisma.service.js';

@Module({
  controllers: [HealthController],
  providers: [PrismaService],
})
export class AppModule {}
