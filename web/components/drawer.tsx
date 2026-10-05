'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

// Painel lateral para cadastros e edições: o formulário só aparece quando a
// pessoa pede, sem empurrar a tela para baixo.
export function Drawer({
  trigger,
  triggerClass = 'button',
  title,
  children,
  onOpenChange,
  defaultOpen = false,
}: {
  trigger: ReactNode;
  triggerClass?: string;
  title: string;
  children: ReactNode;
  onOpenChange?: (open: boolean) => void;
  // Já aberto ao carregar (ex.: link "Agendar por e-mail" dos relatórios).
  defaultOpen?: boolean;
}) {
  const [open, setOpenState] = useState(defaultOpen);
  const setOpen = (v: boolean) => {
    setOpenState(v);
    onOpenChange?.(v);
  };
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', esc);
    document.body.classList.add('drawer-open');
    return () => {
      document.removeEventListener('keydown', esc);
      document.body.classList.remove('drawer-open');
    };
  }, [open]);
  return (
    <>
      <button type="button" className={triggerClass} onClick={() => setOpen(true)}>
        {trigger}
      </button>
      {open &&
        createPortal(
          <>
            <div className="veil" onClick={() => setOpen(false)} />
            <aside className="drawer" role="dialog" aria-modal="true" aria-label={title}>
              <header>
                <h2>{title}</h2>
                <button type="button" className="icon-btn" aria-label="Fechar" onClick={() => setOpen(false)}>
                  ✕
                </button>
              </header>
              <div className="drawer-body">{children}</div>
            </aside>
          </>,
          document.body,
        )}
    </>
  );
}
