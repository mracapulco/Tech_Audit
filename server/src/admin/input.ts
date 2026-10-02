import { BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
import { parseDay, parseVolume } from './admin.js';

// Leitura dos corpos JSON das rotas de administração, com mensagens em português.

type Body = Record<string, unknown>;

export const asBody = (b: unknown): Body =>
  typeof b === 'object' && b !== null && !Array.isArray(b) ? (b as Body) : {};

export function text(b: Body, name: string, label: string, opts: { max?: number; optional?: boolean } = {}): string | undefined {
  const v = b[name];
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
    if (opts.optional) return undefined;
    throw new BadRequestException(`${label} é obrigatório`);
  }
  if (typeof v !== 'string' || v.trim().length > (opts.max ?? 255)) {
    throw new BadRequestException(`${label} deve ser um texto de até ${opts.max ?? 255} caracteres`);
  }
  return v.trim();
}

export function int(b: Body, name: string, label: string, opts: { min?: number; max?: number; optional?: boolean } = {}): number | undefined {
  const v = b[name];
  if (v === undefined || v === null || v === '') {
    if (opts.optional) return undefined;
    throw new BadRequestException(`${label} é obrigatório`);
  }
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : NaN;
  const min = opts.min ?? 0;
  const max = opts.max ?? 1_000_000;
  if (!Number.isInteger(n) || n < min || n > max) throw new BadRequestException(`${label} deve ser um número de ${min} a ${max}`);
  return n;
}

export function volume(b: Body, name: string, label: string): bigint {
  const v = text(b, name, label, { max: 32 })!;
  try {
    const n = parseVolume(v);
    if (n <= 0n) throw new Error();
    return n;
  } catch {
    throw new BadRequestException(`${label} inválido (ex.: 500GB, 2TB)`);
  }
}

export function day(b: Body, name: string, label: string, end: boolean, optional = false): Date | undefined {
  const v = text(b, name, label, { max: 32, optional });
  if (v === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new BadRequestException(`${label} deve estar no formato AAAA-MM-DD`);
  const d = parseDay(v, end);
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`${label} inválida`);
  return d;
}

export const bool = (b: Body, name: string): boolean | undefined =>
  typeof b[name] === 'boolean' ? (b[name] as boolean) : undefined;

// Erros de regra das funções de admin.ts viram 400; registro inexistente, 404.
export async function asBadRequest<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpException) throw err;
    const code = (err as { code?: string }).code;
    if (code === 'P2002') throw new BadRequestException('já existe um cadastro com esse e-mail');
    if (code === 'P2025' || code === 'P2003') throw new NotFoundException('registro não encontrado');
    if (code === undefined && err instanceof Error) throw new BadRequestException(err.message);
    throw err;
  }
}
