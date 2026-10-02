'use client';

import { useActionState, useState, type ReactNode } from 'react';
import { CopyField } from '@/components/copy-field';
import type { ActionResult } from '@/lib/api';

// Resultado com os dados de instalação do agente (token gerado no portal).
export type FormResult = ActionResult & { secret?: { server?: string; command?: string } };

// Formulário que chama uma server action e mostra o resultado no lugar:
// erro, confirmação ou um valor que só aparece uma vez (senha, token).
export function ActionForm({
  action,
  submit,
  children,
  className,
  confirm,
  secondary,
}: {
  action: (prev: FormResult | undefined, form: FormData) => Promise<FormResult>;
  submit: string;
  children?: ReactNode;
  className?: string;
  confirm?: string;
  secondary?: boolean;
}) {
  const [state, run, pending] = useActionState(action, undefined);
  return (
    <form
      action={run}
      className={className}
      onSubmit={(e) => {
        if (confirm && !window.confirm(fillConfirm(confirm, e.currentTarget))) e.preventDefault();
      }}
    >
      {children}
      <div className="form-actions">
        <button type="submit" disabled={pending} className={secondary ? 'secondary small-btn' : undefined}>
          {pending ? 'Aguarde…' : submit}
        </button>
        {state?.error && (
          <span className="error inline" role="alert">
            {state.error}
          </span>
        )}
        {state?.ok && !state.secret && (
          <span className="ok-msg" role="status">
            {state.ok}
          </span>
        )}
      </div>
      {state?.secret && <Secret {...state.secret} message={state.ok} />}
    </form>
  );
}

// "{{path}}" no texto de confirmação vira o valor do campo path do formulário.
function fillConfirm(text: string, form: HTMLFormElement): string {
  const data = new FormData(form);
  return text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(data.get(name) ?? '').trim());
}

function Secret({
  label,
  value,
  config,
  server,
  command,
  message,
}: NonNullable<FormResult['secret']> & { message?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="secret" role="status">
      {message && <p>{message}</p>}
      <p className="muted small">{label} Ele não será mostrado de novo; copie agora.</p>
      <CopyField value={value} />
      {server && (
        <>
          <p className="muted small">
            No instalador do agente (<a href="/agente">Instalar agente</a>), informe este endereço do servidor e o token acima:
          </p>
          <CopyField value={server} />
        </>
      )}
      {command && (
        <details>
          <summary className="small">Instalação sem telas (GPO ou script)</summary>
          <CopyField value={command} />
        </details>
      )}
      {config && (
        <details>
          <summary className="small">Instalação manual com agent.json</summary>
          <pre className="code">{config}</pre>
          <button
            type="button"
            className="secondary small-btn"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(config);
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
          >
            {copied ? 'Copiado' : 'Copiar agent.json'}
          </button>
        </details>
      )}
    </div>
  );
}
