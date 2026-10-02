import { useId } from 'react';

// Marca do Tech Audit: escudo (segurança) com pasta verificada (auditoria de arquivos), dividido pelas
// faixas curvas e cores da logo da Tech Master. Mesmo desenho de app/icon.svg (SVG de favicon não lê CSS).
export function LogoMark({ size = 32, className }: { size?: number; className?: string }) {
  // Ids próprios por instância: um gradiente com id repetido some quando a primeira cópia está oculta.
  const id = `ta-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <defs>
        <clipPath id={`${id}-c`}>
          <path d="M24 2.5 41.5 8.5v13.8c0 11-7.3 18.9-17.5 23.2C13.8 41.2 6.5 33.3 6.5 22.3V8.5Z" />
        </clipPath>
        <linearGradient id={`${id}-p`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#a7a3d6" />
          <stop offset=".45" stopColor="#7a75b5" />
        </linearGradient>
        <linearGradient id={`${id}-cy`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#b3e6eb" />
          <stop offset="1" stopColor="#5cc6d0" />
        </linearGradient>
        <linearGradient id={`${id}-gr`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#e2efc0" />
          <stop offset=".7" stopColor="#a8cf45" />
        </linearGradient>
        <linearGradient id={`${id}-lv`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f2f1f9" />
          <stop offset="1" stopColor="#c6c3e2" />
        </linearGradient>
      </defs>
      <g clipPath={`url(#${id}-c)`}>
        <rect width="48" height="48" fill={`url(#${id}-p)`} />
        <path d="M0 0H22L17 14 0 16Z" fill={`url(#${id}-lv)`} />
        <path d="M22 0H48V24Q36 17 20 14Z" fill={`url(#${id}-cy)`} />
        <path d="M0 16 17 14Q11 28 12 48H0Z" fill={`url(#${id}-gr)`} />
        <path d="M0 15.6Q24 11 48 23" fill="none" stroke="#fff" strokeWidth="2.6" />
        <path d="M22 0Q11 18 13 48" fill="none" stroke="#fff" strokeWidth="2.6" />
      </g>
      <path
        d="M20 22.3a1.3 1.3 0 0 1 1.3-1.3h4.6l2 2.2h7.3a1.3 1.3 0 0 1 1.3 1.3v8.7a1.3 1.3 0 0 1-1.3 1.3H21.3a1.3 1.3 0 0 1-1.3-1.3Z"
        fill="#fff"
      />
      <path d="m24.4 28.6 2.6 2.6 4.9-4.9" fill="none" stroke="#5f5aa0" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Logo({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <span className={className ? `logo ${className}` : 'logo'}>
      <LogoMark size={size} />
      <span className="logo-name">Tech Audit</span>
    </span>
  );
}
