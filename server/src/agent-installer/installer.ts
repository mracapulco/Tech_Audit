import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Instaladores do agente oferecidos para download no portal: MSI para Windows
// e pacotes .deb (Ubuntu/Debian) e .rpm (CentOS/Oracle/RHEL) para Linux. A
// imagem Docker do servidor gera os três a partir de agent/ e os coloca em
// /app/downloads; fora do Docker, aponte AGENT_DOWNLOADS_DIR para agent/dist
// (make msi packages).
export const downloadsDir = () => resolve(process.env.AGENT_DOWNLOADS_DIR ?? 'downloads');

export interface InstallerInfo {
  file_name: string;
  version: string;
  size: number;
  sha256: string;
  built_at: string;
}

export type PackageKind = 'windows' | 'deb' | 'rpm';
export const PACKAGE_KINDS: PackageKind[] = ['windows', 'deb', 'rpm'];

const PATTERNS: Record<PackageKind, RegExp> = {
  windows: /^TechAuditAgent-(\d+(?:\.\d+)*(?:-[\w.]+)?)\.msi$/,
  // Linux só x86-64 por enquanto.
  deb: /^techaudit-agent_(\d+(?:\.\d+)*)-\d+_amd64\.deb$/,
  rpm: /^techaudit-agent-(\d+(?:\.\d+)*)-\d+\.x86_64\.rpm$/,
};

export const CONTENT_TYPES: Record<PackageKind, string> = {
  windows: 'application/x-msi',
  deb: 'application/vnd.debian.binary-package',
  rpm: 'application/x-rpm',
};

// Ordena versões numéricas: 0.10.0 > 0.9.1.
export function compareVersions(a: string, b: string): number {
  const pa = a.split('-')[0].split('.').map(Number);
  const pb = b.split('-')[0].split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return a.localeCompare(b);
}

// Escolhe o pacote mais novo do tipo entre os nomes de arquivo.
export function latestPackage(names: string[], kind: PackageKind): { name: string; version: string } | null {
  let best: { name: string; version: string } | null = null;
  for (const name of names) {
    const m = PATTERNS[kind].exec(name);
    if (m && (!best || compareVersions(m[1], best.version) > 0)) best = { name, version: m[1] };
  }
  return best;
}

export const latestMsi = (names: string[]) => latestPackage(names, 'windows');

// O hash é calculado uma vez por arquivo (nome + tamanho + data).
const cache = new Map<PackageKind, { key: string; sha256: string }>();

async function sha256(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

export async function currentInstaller(dir = downloadsDir(), kind: PackageKind = 'windows'): Promise<(InstallerInfo & { path: string }) | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  const pkg = latestPackage(names, kind);
  if (!pkg) return null;
  const path = join(dir, pkg.name);
  const st = await stat(path);
  const key = `${path}:${st.size}:${st.mtimeMs}`;
  let hit = cache.get(kind);
  if (hit?.key !== key) {
    hit = { key, sha256: await sha256(path) };
    cache.set(kind, hit);
  }
  return { path, file_name: pkg.name, version: pkg.version, size: st.size, sha256: hit.sha256, built_at: st.mtime.toISOString() };
}

// Quem pode baixar: a Tech Master e o administrador do cliente, que instalam
// agentes. O auditor do cliente só consulta. A instalação ainda depende de um
// token gerado pela Tech Master.
export const canDownloadAgent = (role: string) => role === 'msp_admin' || role === 'msp_operator' || role === 'tenant_admin';
