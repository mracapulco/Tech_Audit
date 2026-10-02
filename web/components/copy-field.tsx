'use client';

import { useState } from 'react';

// Valor em destaque com botão Copiar (endereço do servidor, token, comando).
export function CopyField({ value, label = 'Copiar' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="secret-row">
      <code>{value}</code>
      <button
        type="button"
        className="secondary small-btn"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? 'Copiado' : label}
      </button>
    </div>
  );
}
