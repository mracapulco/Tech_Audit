import type { ReactNode } from 'react';

// Explicação que só aparece quando a pessoa clica no "?", em vez de parágrafos fixos na tela.
export function Help({ children, label = 'Como funciona' }: { children: ReactNode; label?: string }) {
  return (
    <details className="help">
      <summary aria-label={label} title={label}>
        ?
      </summary>
      <div className="help-pop small">{children}</div>
    </details>
  );
}
