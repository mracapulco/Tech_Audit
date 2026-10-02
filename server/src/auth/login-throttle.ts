// Limita tentativas de login erradas por e-mail + IP, em memória. Suficiente
// para uma instância só; com várias, mover para o Redis.
export class LoginThrottle {
  private readonly failures = new Map<string, number[]>();

  constructor(
    readonly maxFailures = 5,
    readonly windowMs = 15 * 60_000,
  ) {}

  private recent(key: string, now: number): number[] {
    const list = (this.failures.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length) this.failures.set(key, list);
    else this.failures.delete(key);
    return list;
  }

  blocked(key: string, now = Date.now()): boolean {
    return this.recent(key, now).length >= this.maxFailures;
  }

  fail(key: string, now = Date.now()): void {
    this.failures.set(key, [...this.recent(key, now), now]);
  }

  reset(key: string): void {
    this.failures.delete(key);
  }
}
