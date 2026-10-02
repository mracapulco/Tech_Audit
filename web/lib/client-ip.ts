// Sem dependências, para testar com node --test.

// Só o último endereço do X-Forwarded-For é confiável: é o que o proxy reverso
// (ou o próprio Next.js, sem proxy) acrescentou. Os anteriores vêm do
// navegador e podem ser inventados para fugir do bloqueio de login.
export function clientIp(xff: string | null | undefined): string | undefined {
  const last = xff?.split(',').pop()?.trim();
  return last || undefined;
}
