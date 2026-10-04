import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';
import { evaluateLicenses, LicenseState } from './license.js';

type Db = Pick<PrismaService, 'license'>;
type LicenseRow = Awaited<ReturnType<PrismaService['license']['findMany']>>[number];

@Injectable()
export class LicenseService {
  constructor(private readonly prisma: PrismaService) {}

  async stateFor(tenantId: string, now = new Date(), db: Db = this.prisma): Promise<LicenseState<LicenseRow>> {
    const licenses = await db.license.findMany({ where: { tenantId } });
    return evaluateLicenses(licenses, now);
  }
}
