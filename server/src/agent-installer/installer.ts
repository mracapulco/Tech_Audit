import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Instalador do agente oferecido para download no portal. A imagem Docker do
// servidor compila o MSI a partir de agent/ e o coloca em /app/downloads; fora
// do Docker, aponte AGENT_DOWNLOADS_DIR para agent/dist (make msi).
export const downloadsDir = () => resolve(process.env.AGENT_DOWNLOADS_DIR ?? 'downloads');

export interface InstallerInfo {
  file_name: string;
  version: string;
  size: number;
  sha256: string;
  built_at: string;
}

const MSI = /^TechAuditAgent-(\d+(?:\.\d+)*(?:-[\w.]+)?)\.msi$/;

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

// Escolhe o MSI mais novo entre os nomes de arquivo.
export function latestMsi(names: string[]): { name: string; version: string } | null {
  let best: { name: string; version: string } | null = null;
  for (const name of names) {
    const m = MSI.exec(name);
    if (m && (!best || compareVersions(m[1], best.version) > 0)) best = { name, version: m[1] };
  }
  return best;
}

// O hash é calculado uma vez por arquivo (nome + tamanho + data).
let cache: { key: string; sha256: string } | null = null;

async function sha256(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

export async function currentInstaller(dir = downloadsDir()): Promise<(InstallerInfo & { path: string }) | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  const msi = latestMsi(names);
  if (!msi) return null;
  const path = join(dir, msi.name);
  const st = await stat(path);
  const key = `${path}:${st.size}:${st.mtimeMs}`;
  if (cache?.key !== key) cache = { key, sha256: await sha256(path) };
  return { path, file_name: msi.name, version: msi.version, size: st.size, sha256: cache.sha256, built_at: st.mtime.toISOString() };
}

// Quem pode baixar: a Tech Master e o administrador do cliente, que instalam
// agentes. O auditor do cliente só consulta. A instalação ainda depende de um
// token gerado pela Tech Master.
export const canDownloadAgent = (role: string) => role === 'msp_admin' || role === 'msp_operator' || role === 'tenant_admin';
