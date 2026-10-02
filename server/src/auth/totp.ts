import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Códigos de 6 dígitos que mudam a cada 30 s (TOTP, RFC 6238), o padrão do
// Google Authenticator, Microsoft Authenticator e similares.
export const TOTP_PERIOD_S = 30;
const DIGITS = 6;
// Aceita o código anterior e o seguinte, para relógios um pouco fora de hora.
const WINDOW = 1;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/[\s=]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const i = B32.indexOf(c);
    if (i < 0) throw new Error('segredo base32 inválido');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// 160 bits, o tamanho recomendado pela RFC 4226 para HMAC-SHA1.
export const generateSecret = () => base32Encode(randomBytes(20));

export const stepAt = (ms: number) => Math.floor(ms / 1000 / TOTP_PERIOD_S);

export function codeAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const off = h[h.length - 1] & 15;
  const n = (h.readUInt32BE(off) & 0x7fffffff) % 10 ** DIGITS;
  return n.toString().padStart(DIGITS, '0');
}

// Devolve o passo de tempo do código aceito, ou null. Passos até lastStep já
// foram usados e são recusados, para o mesmo código não servir duas vezes.
export function verifyCode(secret: string, code: string, lastStep: number | null, now = Date.now()): number | null {
  const c = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const current = stepAt(now);
  for (let s = current - WINDOW; s <= current + WINDOW; s++) {
    if (lastStep !== null && s <= lastStep) continue;
    if (timingSafeEqual(Buffer.from(codeAt(secret, s)), Buffer.from(c))) return s;
  }
  return null;
}

// Link lido pelo QR code no aplicativo autenticador.
export function otpauthUrl(secret: string, email: string, issuer = 'Tech Audit'): string {
  const label = encodeURIComponent(`${issuer}:${email}`);
  const q = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(TOTP_PERIOD_S) });
  return `otpauth://totp/${label}?${q}`;
}
