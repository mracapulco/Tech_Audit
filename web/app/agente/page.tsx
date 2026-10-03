import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { CopyField } from '@/components/copy-field';
import { TopBar } from '@/components/top-bar';
import { agentServerUrl, canDownloadAgent, linuxPackageCommand, linuxRegisterCommand, silentInstallCommand } from '@/lib/agent';
import { apiGet, type CurrentUser } from '@/lib/api';
import { formatBytes, formatDateTimeShort } from '@/lib/format';

export const metadata: Metadata = { title: 'Instalar agente · Tech Audit' };

interface Package {
  file_name: string;
  version: string;
  size: number;
  sha256: string;
  built_at: string;
}

interface Installer extends Partial<Package> {
  available: boolean;
  // Ausente em servidores com a API anterior aos pacotes Linux.
  linux?: { deb: Package | null; rpm: Package | null };
}

const SERVER_URL = agentServerUrl(process.env.PUBLIC_AGENT_URL ?? process.env.API_URL ?? 'http://localhost:3001');

export default async function AgentPage() {
  const user = await apiGet<CurrentUser>('/api/auth/me');
  if (!canDownloadAgent(user.role)) redirect('/painel');
  const inst = await apiGet<Installer>('/api/agent/installer');
  const admin = user.role === 'msp_admin';

  return (
    <>
      <TopBar user={user} active="agente" />
      <main className="page">
        <h1>Instalar agente</h1>
        <p className="muted">
          O agente é instalado em cada servidor de arquivos, Windows ou Linux. Ele roda como serviço, lê a auditoria de acesso a arquivos e envia
          para o Tech Audit. Veja abaixo o <a href="#linux">passo a passo para Linux</a>.
        </p>

        <section className="section">
          <h2>1. Baixe o instalador (Windows)</h2>
          {inst.available ? (
            <div className="card">
              <p>
                <a className="button" href="/agente/download" download>
                  Baixar {inst.file_name}
                </a>
              </p>
              <p className="muted small">
                Versão {inst.version} · {formatBytes(inst.size ?? 0)} · gerado em {formatDateTimeShort(inst.built_at ?? null)}
              </p>
              <p className="muted small">Para conferir o arquivo baixado, o SHA-256 é:</p>
              <CopyField value={inst.sha256 ?? ''} />
            </div>
          ) : (
            <p className="error">O instalador ainda não está disponível neste servidor. Avise a Tech Master.</p>
          )}
        </section>

        <section className="section">
          <h2>2. Tenha um token de instalação</h2>
          {admin ? (
            <p>
              Gere o token na página da empresa, em <Link href="/admin/empresas">Empresas</Link> › Tokens de instalação. Cada token vale para o número
              de instalações e o prazo escolhidos.
            </p>
          ) : (
            <p>O token de instalação é fornecido pela Tech Master. Ele vale para poucas instalações e por tempo limitado.</p>
          )}
        </section>

        <section className="section">
          <h2>3. Execute no servidor de arquivos Windows</h2>
          <div className="card">
            <ol className="steps">
              <li>Copie o instalador para o servidor e abra com duplo clique (é preciso ser administrador).</li>
              <li>
                Na tela <strong>Conexão com o Tech Audit</strong>, informe o endereço do servidor:
                <CopyField value={SERVER_URL} />
              </li>
              <li>Cole o token de instalação, clique em Avançar e depois em Instalar.</li>
              <li>
                Em poucos minutos o servidor aparece no <Link href="/painel">Painel</Link>. Depois escolha as pastas em{' '}
                <Link href="/configuracao">Caminhos auditados</Link>.
              </li>
            </ol>
          </div>
        </section>

        {inst.available && (
          <details className="section">
            <summary>Instalação sem telas (GPO ou script)</summary>
            <p className="muted small">Rode em um Prompt de Comando como administrador, trocando o token:</p>
            <CopyField value={silentInstallCommand(inst.file_name ?? 'TechAuditAgent.msi', SERVER_URL)} />
          </details>
        )}

        <section className="section" id="linux">
          <h2>Servidor Linux</h2>
          <p className="muted">
            Ubuntu, Debian, CentOS, Oracle Linux, Red Hat, Rocky e Alma (64 bits). O agente registra o acesso direto ao servidor (auditd) e o acesso
            pela rede aos compartilhamentos Samba, com o IP do computador de quem acessou.
          </p>
          <div className="card">
            <ol className="steps">
              <li>
                Baixe o pacote da sua distribuição e copie para o servidor:
                <div className="download-list">
                  <LinuxPackage kind="deb" label="Ubuntu / Debian (.deb)" pkg={inst.linux?.deb ?? null} />
                  <LinuxPackage kind="rpm" label="CentOS / Oracle / Red Hat (.rpm)" pkg={inst.linux?.rpm ?? null} />
                </div>
              </li>
              <li>
                Instale com um usuário que tenha sudo, na pasta onde está o pacote (o auditd é instalado junto, se faltar):
                {inst.linux?.deb && <CopyField value={linuxPackageCommand('deb', inst.linux.deb.file_name)} />}
                {inst.linux?.rpm && <CopyField value={linuxPackageCommand('rpm', inst.linux.rpm.file_name)} />}
              </li>
              <li>
                Registre o servidor, trocando o token de instalação:
                <CopyField value={linuxRegisterCommand(SERVER_URL)} />
              </li>
              <li>
                O servidor aparece no <Link href="/painel">Painel</Link>. Escolha as pastas em <Link href="/configuracao">Caminhos auditados</Link>{' '}
                usando o caminho no servidor, por exemplo /srv/dados/financeiro.
              </li>
            </ol>
          </div>
        </section>
      </main>
    </>
  );
}

function LinuxPackage({ kind, label, pkg }: { kind: 'deb' | 'rpm'; label: string; pkg: Package | null }) {
  if (!pkg) return <p className="muted small">{label}: ainda não disponível neste servidor. Avise a Tech Master.</p>;
  return (
    <div>
      <p>
        <a className="button" href={`/agente/download?tipo=${kind}`} download>
          {label}
        </a>{' '}
        <span className="muted small">
          {pkg.file_name} · {formatBytes(pkg.size)}
        </span>
      </p>
      <details>
        <summary className="small">SHA-256 para conferir o arquivo</summary>
        <CopyField value={pkg.sha256} />
      </details>
    </div>
  );
}
