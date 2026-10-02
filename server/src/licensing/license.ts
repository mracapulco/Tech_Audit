// Regras de licença (docs/ARCHITECTURE.md, seção 9.2), sem acesso a banco.

export interface LicenseTerms {
  id: string;
  maxAgents: number;
  maxVolumeBytes: bigint;
  validFrom: Date;
  validUntil: Date;
  graceDays: number;
  revokedAt: Date | null;
}

export type LicenseStatus = 'active' | 'grace' | 'expired' | 'none';

export interface LicenseState {
  status: LicenseStatus;
  // Licenças que contam agora (vigentes ou em tolerância); limites somados.
  licenses: LicenseTerms[];
  maxAgents: number;
  maxVolumeBytes: bigint;
  // Maior fim de vigência e de tolerância entre as licenças que contam.
  validUntil: Date | null;
  graceUntil: Date | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function graceEnd(l: LicenseTerms): Date {
  return new Date(l.validUntil.getTime() + l.graceDays * DAY_MS);
}

export function evaluateLicenses(all: LicenseTerms[], now: Date): LicenseState {
  const t = now.getTime();
  const counted = all.filter(
    (l) => !l.revokedAt && l.validFrom.getTime() <= t && t < graceEnd(l).getTime(),
  );
  if (counted.length === 0) {
    const everValid = all.some((l) => !l.revokedAt && l.validFrom.getTime() <= t);
    return {
      status: everValid ? 'expired' : 'none',
      licenses: [],
      maxAgents: 0,
      maxVolumeBytes: 0n,
      validUntil: null,
      graceUntil: null,
    };
  }
  const inForce = counted.some((l) => t < l.validUntil.getTime());
  return {
    status: inForce ? 'active' : 'grace',
    licenses: counted,
    maxAgents: counted.reduce((n, l) => n + l.maxAgents, 0),
    maxVolumeBytes: counted.reduce((n, l) => n + l.maxVolumeBytes, 0n),
    validUntil: new Date(Math.max(...counted.map((l) => l.validUntil.getTime()))),
    graceUntil: new Date(Math.max(...counted.map((l) => graceEnd(l).getTime()))),
  };
}

// Ingestão é aceita enquanto houver licença vigente ou em tolerância.
export function acceptsIngestion(s: LicenseState): boolean {
  return s.status === 'active' || s.status === 'grace';
}
