// Regras dos caminhos auditados (docs/ARCHITECTURE.md, seções 4.6 e 9.2),
// sem acesso a banco.

export class PathError extends Error {}

const MAX_PATH = 1024;

// "d:/Dados//Financeiro\" -> "D:\Dados\Financeiro". Só caminhos locais do
// servidor: o agente aplica a SACL no disco, não no compartilhamento.
export function normalizePath(input: unknown): string {
  if (typeof input !== 'string' || input.trim() === '') throw new PathError('Caminho é obrigatório');
  let p = input.trim().replace(/\//g, '\\');
  if (p.startsWith('\\\\')) {
    throw new PathError('Use o caminho local no servidor (ex.: D:\\Dados\\Financeiro), não o compartilhamento de rede');
  }
  if (!/^[A-Za-z]:\\/.test(p) && !/^[A-Za-z]:$/.test(p)) {
    throw new PathError('Caminho deve começar com a letra do disco (ex.: D:\\Dados\\Financeiro)');
  }
  p = p[0].toUpperCase() + p.slice(1);
  p = p.replace(/\\{2,}/g, '\\');
  if (p.length > 3) p = p.replace(/\\+$/, '');
  if (p.length === 2) p += '\\';
  if (p.length > MAX_PATH) throw new PathError(`Caminho deve ter até ${MAX_PATH} caracteres`);
  const parts = p.slice(3).split('\\').filter(Boolean);
  if (parts.some((s) => s === '.' || s === '..')) throw new PathError('Caminho não pode conter "." ou ".."');
  // eslint-disable-next-line no-control-regex
  if (/[<>:"|?*\x00-\x1f]/.test(p.slice(2))) throw new PathError('Caminho contém caracteres inválidos');
  if (parts.some((s) => /[ .]$/.test(s))) throw new PathError('Nome de pasta não pode terminar com espaço ou ponto');
  return p;
}

// Chave de comparação: o NTFS não diferencia maiúsculas.
export const pathKey = (normalized: string) => normalized.toLowerCase();

// child está dentro de parent (ou é o próprio), comparando chaves.
export function isWithin(childKey: string, parentKey: string): boolean {
  if (childKey === parentKey) return true;
  const prefix = parentKey.endsWith('\\') ? parentKey : parentKey + '\\';
  return childKey.startsWith(prefix);
}

// Volume auditado de um servidor: soma só dos caminhos que não estão dentro
// de outro caminho auditado, para não contar duas vezes.
export function dedupedVolume(paths: { pathKey: string; sizeBytes: bigint | null }[]): bigint {
  const unique = [...new Map(paths.map((p) => [p.pathKey, p])).values()];
  let total = 0n;
  for (const p of unique) {
    if (!unique.some((o) => o !== p && isWithin(p.pathKey, o.pathKey))) total += p.sizeBytes ?? 0n;
  }
  return total;
}

export type VolumeLevel = 0 | 80 | 100;

export interface VolumeUsage {
  usedBytes: bigint;
  maxBytes: bigint;
  // Percentual com uma casa decimal; null sem licença.
  percent: number | null;
  level: VolumeLevel;
}

export function volumeUsage(usedBytes: bigint, maxBytes: bigint): VolumeUsage {
  if (maxBytes <= 0n) return { usedBytes, maxBytes, percent: null, level: usedBytes > 0n ? 100 : 0 };
  const permille = Number((usedBytes * 1000n) / maxBytes);
  const level: VolumeLevel = usedBytes >= maxBytes ? 100 : usedBytes * 10n >= maxBytes * 8n ? 80 : 0;
  return { usedBytes, maxBytes, percent: permille / 10, level };
}

const MAX_EXCLUSIONS = 20;

// Padrões de exclusão: um por linha (ou separados por vírgula/ponto e vírgula).
export function parseExclusions(input: unknown): string[] {
  if (input === undefined || input === null || input === '') return [];
  const raw = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/[\r\n,;]+/) : null;
  if (!raw) throw new PathError('Exclusões inválidas');
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') throw new PathError('Exclusões inválidas');
    const s = v.trim();
    if (!s) continue;
    // eslint-disable-next-line no-control-regex
    if (s.length > 260 || /[\x00-\x1f<>"|]/.test(s)) throw new PathError(`Exclusão inválida: ${s.slice(0, 40)}`);
    if (!out.some((o) => o.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  if (out.length > MAX_EXCLUSIONS) throw new PathError(`Até ${MAX_EXCLUSIONS} exclusões por caminho`);
  return out;
}

// Perfis que podem alterar a configuração (o auditor do cliente só consulta).
export const CONFIG_WRITE_ROLES = ['msp_admin', 'msp_operator', 'tenant_admin'];
