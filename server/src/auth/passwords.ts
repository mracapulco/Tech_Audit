import { hash, verify } from '@node-rs/argon2';

// Argon2id com os parâmetros padrão da biblioteca (m=19 MiB, t=2, p=1),
// os mínimos recomendados pela OWASP.
export const MIN_PASSWORD_LENGTH = 10;

export function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`a senha precisa ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres`);
  }
  return hash(password);
}

// Hash de uma senha qualquer, usado quando o e-mail não existe para o tempo de
// resposta não revelar quais e-mails estão cadastrados.
let dummy: Promise<string> | undefined;

export async function verifyPassword(passwordHash: string | null, password: string): Promise<boolean> {
  if (!passwordHash) {
    dummy ??= hash('techaudit-senha-inexistente');
    await verify(await dummy, password).catch(() => false);
    return false;
  }
  return verify(passwordHash, password).catch(() => false);
}
