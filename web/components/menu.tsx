'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

// Menu suspenso (o "⋯" das linhas, o menu Tech Master e o do usuário). Os itens
// ficam montados mesmo fechado: um formulário com confirmação ou um painel
// lateral aberto a partir do menu não some quando ele fecha.
//
// A caixa abre por cima da página (position: fixed), presa ao botão que a
// abriu: não fica cortada dentro de tabelas ou cartões com rolagem e acompanha
// a rolagem da página. Sem espaço embaixo, abre para cima.
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
  const [pos, setPos] = useState<CSSProperties>({});
  const ref = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);

  const place = useCallback(() => {
    const b = btn.current?.getBoundingClientRect();
    const m = box.current;
    if (!b || !m) return;
    const gap = 6;
    const edge = 8;
    const w = m.offsetWidth;
    const h = m.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const below = vh - b.bottom - gap - edge;
    const above = b.top - gap - edge;
    const up = h > below && above > below;
    let left = align === 'right' ? b.right - w : b.left;
    left = Math.max(edge, Math.min(left, vw - w - edge));
    setPos({
      left,
      top: up ? Math.max(edge, b.top - gap - Math.min(h, above)) : b.bottom + gap,
      maxHeight: Math.max(120, up ? above : below),
    });
  }, [align]);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    // Rolagem da página ou de um quadro com rolagem: a caixa segue o botão.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, place]);

  return (
    <div className="menu-wrap" ref={ref}>
      <button
        ref={btn}
        type="button"
        className={open ? `${buttonClass} open` : buttonClass}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={ariaLabel}
        onClick={() => setOpen(!open)}
      >
        {label}
      </button>
      <div ref={box} className="menu" style={pos} hidden={!open} onClick={(e) => (e.target as HTMLElement).closest('a') && setOpen(false)}>
        {children}
      </div>
    </div>
  );
}
