'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useState } from 'react';
import type { FormResult } from '@/components/action-form';
import { CopyField } from '@/components/copy-field';
import { Drawer } from '@/components/drawer';
import { linuxPackageCommand } from '@/lib/agent';

export interface InstallerFiles {
  windows: string | null;
  deb: string | null;
  rpm: string | null;
}

type TokenAction = (prev: FormResult | undefined, form: FormData) => Promise<FormResult>;

// Assistente "Adicionar servidor": escolhe o sistema, baixa o instalador, gera
// o token de instalação e espera o servidor aparecer na tela.
export function AddServer(props: { files: InstallerFiles; serverUrl: string; agents: { id: string; hostname: string }[]; tokenAction: TokenAction | null; label?: string }) {
  return (
    <Drawer trigger={props.label ?? '+ Adicionar servidor'} title="Adicionar servidor">
      <Wizard {...props} />
    </Drawer>
  );
}

function Wizard({ files, serverUrl, agents, tokenAction }: { files: InstallerFiles; serverUrl: string; agents: { id: string; hostname: string }[]; tokenAction: TokenAction | null }) {
  const router = useRouter();
  const [os, setOs] = useState<'windows' | 'linux'>('windows');
  const [known] = useState(() => new Set(agents.map((a) => a.id)));
  const fresh = agents.filter((a) => !known.has(a.id));

  // Enquanto o assistente está aberto, a tela confere a cada 10 s se o servidor novo já se registrou.
  useEffect(() => {
    if (fresh.length) return;
    const t = setInterval(() => router.refresh(), 10_000);
    return () => clearInterval(t);
  }, [fresh.length, router]);

  return (
    <div className="wizard">
      <section className="wizard-step">
        <h3>1. Sistema do servidor</h3>
        <div className="choice" role="radiogroup" aria-label="Sistema do servidor">
          <button type="button" role="radio" aria-checked={os === 'windows'} className={os === 'windows' ? 'on' : undefined} onClick={() => setOs('windows')}>
            <strong>Windows</strong>
            <span>Windows Server 2016 ou mais novo</span>
          </button>
          <button type="button" role="radio" aria-checked={os === 'linux'} className={os === 'linux' ? 'on' : undefined} onClick={() => setOs('linux')}>
            <strong>Linux</strong>
            <span>Ubuntu, Debian e família Red Hat 8/9</span>
          </button>
        </div>
      </section>

      <section className="wizard-step">
        <h3>2. Baixe o instalador</h3>
        {os === 'windows' ? (
          files.windows ? (
            <p>
              <a className="button" href="/agente/download" download>
                Baixar {files.windows}
              </a>
            </p>
          ) : (
            <p className="error">O instalador do Windows ainda não está disponível neste servidor.</p>
          )
        ) : (
          <>
            <div className="row-actions">
              {files.deb && (
                <a className="button" href="/agente/download?tipo=deb" download>
                  Ubuntu / Debian (.deb)
                </a>
              )}
              {files.rpm && (
                <a className="button secondary" href="/agente/download?tipo=rpm" download>
                  Red Hat e família (.rpm)
                </a>
              )}
            </div>
            {!files.deb && !files.rpm && <p className="error">Os pacotes Linux ainda não estão disponíveis neste servidor.</p>}
            <p className="muted small">Copie o pacote para a pasta /tmp do servidor e instale com um usuário que tenha sudo:</p>
            {files.deb && <CopyField value={linuxPackageCommand('deb', files.deb)} />}
            {files.rpm && <CopyField value={linuxPackageCommand('rpm', files.rpm)} />}
          </>
        )}
      </section>

      <section className="wizard-step">
        <h3>3. Token de instalação</h3>
        {tokenAction ? <TokenStep action={tokenAction} os={os} serverUrl={serverUrl} /> : <p>Peça à Tech Master um token de instalação para este servidor. Ele vale por tempo limitado.</p>}
      </section>

      <section className="wizard-step">
        <h3>4. Aguarde o servidor aparecer</h3>
        {fresh.length ? (
          <div className="notice ok-box" role="status">
            <strong>{fresh.map((a) => a.hostname).join(', ')} conectado.</strong> Feche este painel e use <em>+ Adicionar pasta</em> no servidor para
            escolher o que auditar.
          </div>
        ) : (
          <div className="notice waiting" role="status">
            <span className="pill neutral">Esperando…</span>
            <span>Quando o agente se conectar, o servidor aparece aqui e na lista de servidores. Esta tela confere sozinha a cada 10 segundos.</span>
          </div>
        )}
      </section>
    </div>
  );
}

function TokenStep({ action, os, serverUrl }: { action: TokenAction; os: 'windows' | 'linux'; serverUrl: string }) {
  const [state, run, pending] = useActionState(action, undefined);
  const s = state?.secret;
  if (s) {
    return (
      <div className="stack">
        <p className="muted small">Copie agora: o token não é mostrado de novo. {state?.ok}</p>
        <CopyField value={s.value} />
        {os === 'windows' ? (
          <>
            <p className="small">Abra o instalador no servidor (como administrador) e informe este endereço e o token acima:</p>
            <CopyField value={s.server ?? serverUrl} />
            {s.command && (
              <details>
                <summary className="small">Instalação sem telas (GPO ou script)</summary>
                <CopyField value={s.command} />
              </details>
            )}
          </>
        ) : (
          <>
            <p className="small">Depois de instalar o pacote, registre o servidor:</p>
            {s.linuxCommand && <CopyField value={s.linuxCommand} />}
          </>
        )}
      </div>
    );
  }
  return (
    <form action={run} className="stack">
      <p className="muted small">O token liga o agente a esta empresa. Por padrão vale para 1 instalação por 24 horas.</p>
      <details>
        <summary className="small">Mais opções (vários servidores, prazo maior)</summary>
        <div className="grid-form">
          <label>
            Descrição
            <input name="description" maxLength={255} placeholder="Ex.: servidor da matriz" />
          </label>
          <label>
            Instalações permitidas
            <input name="max_uses" type="number" min={1} max={1000} defaultValue={1} />
          </label>
          <label>
            Validade (horas)
            <input name="ttl_hours" type="number" min={1} max={720} defaultValue={24} />
          </label>
        </div>
      </details>
      <div className="form-actions">
        <button type="submit" disabled={pending}>
          {pending ? 'Aguarde…' : 'Gerar token'}
        </button>
        {state?.error && (
          <span className="error inline" role="alert">
            {state.error}
          </span>
        )}
      </div>
    </form>
  );
}
