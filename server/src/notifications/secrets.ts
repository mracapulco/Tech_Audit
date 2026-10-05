// Criptografia das senhas e segredos guardados no banco (servidor de e-mail).
// Chave em SECRETS_KEY no .env: um backup do banco sozinho não revela a senha.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export class SecretsKeyError extends Error {
  constructor() {
    super('SECRETS_KEY não definida no .env do servidor; gere uma com: openssl rand -hex 32');
  }
}

function key(): Buffer {
  const k = process.env.SECRETS_KEY?.trim();
  if (!k || k.length < 32) throw new SecretsKeyError();
  return createHash('sha256').update(k).digest();
}

export const secretsKeyOk = (): boolean => {
  try {
    key();
    return true;
  } catch {
    return false;
  }
};

// "v1:" + base64(iv | tag | dados), AES-256-GCM.
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), data]).toString('base64');
}

export function decryptSecret(stored: string): string {
  if (!stored.startsWith('v1:')) throw new Error('segredo em formato desconhecido');
  const raw = Buffer.from(stored.slice(3), 'base64');
  const d = createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  try {
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch {
    throw new Error('não foi possível abrir a senha salva: a SECRETS_KEY mudou? Salve a senha de novo na tela Servidor de e-mail');
  }
}
