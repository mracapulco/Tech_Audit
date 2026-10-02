import { createHash, randomBytes } from 'node:crypto';

// Tokens de alta entropia: SHA-256 basta para o hash guardado no banco.
export function generateToken(prefix: 'ta_enr' | 'ta_agt' | 'ta_ses'): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// Extrai o token de "Authorization: Bearer <token>".
export function bearerToken(header: string | undefined): string | undefined {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  return m?.[1];
}
