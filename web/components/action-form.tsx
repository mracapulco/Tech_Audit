'use client';

import { useActionState, useState, type ReactNode } from 'react';
import type { ActionResult } from '@/lib/api';

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
  action: (prev: ActionResult | undefined, form: FormData) => Promise<ActionResult>;
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
        if (confirm && !window.confirm(confirm)) e.preventDefault();
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

function Secret({ label, value, config, message }: { label: string; value: string; config?: string; message?: string }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
    } catch {
      setCopied(null);
    }
  };
  return (
    <div className="secret" role="status">
      {message && <p>{message}</p>}
      <p className="muted small">{label} Ele não será mostrado de novo; copie agora.</p>
      <div className="secret-row">
        <code>{value}</code>
        <button type="button" className="secondary small-btn" onClick={() => copy(value, 'valor')}>
          {copied === 'valor' ? 'Copiado' : 'Copiar'}
        </button>
      </div>
      {config && (
        <>
          <p className="muted small">Arquivo agent.json para o servidor do cliente:</p>
          <pre className="code">{config}</pre>
          <button type="button" className="secondary small-btn" onClick={() => copy(config, 'config')}>
            {copied === 'config' ? 'Copiado' : 'Copiar agent.json'}
          </button>
        </>
      )}
    </div>
  );
}
