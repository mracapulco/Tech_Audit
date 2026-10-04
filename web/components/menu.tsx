'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

// Menu suspenso (o "⋯" das linhas, o menu Tech Master e o do usuário). Os itens
// ficam montados mesmo fechado: um formulário com confirmação ou um painel
// lateral aberto a partir do menu não some quando ele fecha.
export function Menu({
  label,
  children,
  buttonClass = 'icon-btn',
  ariaLabel,
  align = 'right',
}: {
  label: ReactNode;
  children: ReactNode;
  buttonClass?: string;
  ariaLabel?: string;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <div className="menu-wrap" ref={ref}>
      <button type="button" className={open ? `${buttonClass} open` : buttonClass} aria-expanded={open} aria-haspopup="menu" aria-label={ariaLabel} onClick={() => setOpen(!open)}>
        {label}
      </button>
      <div className={`menu ${align}`} hidden={!open} onClick={(e) => (e.target as HTMLElement).closest('a') && setOpen(false)}>
        {children}
      </div>
    </div>
  );
}
