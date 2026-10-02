import { useId } from 'react';

// Marca do Tech Audit: escudo (segurança) com pasta verificada (auditoria de arquivos).
// Cores iguais aos tokens --brand-* de globals.css (SVG de favicon não lê CSS, então ficam fixas).
export function LogoMark({ size = 32, className }: { size?: number; className?: string }) {
  // Id próprio por instância: um gradiente com id repetido some quando a primeira cópia está oculta.
  const grad = `ta-logo-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={grad} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2f7cf6" />
          <stop offset="1" stopColor="#0b2a5b" />
        </linearGradient>
      </defs>
      <path d="M24 2.5 41.5 8.5v13.8c0 11-7.3 18.9-17.5 23.2C13.8 41.2 6.5 33.3 6.5 22.3V8.5Z" fill={`url(#${grad})`} />
      <path
        d="M14 16.5a1.5 1.5 0 0 1 1.5-1.5h5.6l2.4 2.6h9a1.5 1.5 0 0 1 1.5 1.5v10.4a1.5 1.5 0 0 1-1.5 1.5h-17a1.5 1.5 0 0 1-1.5-1.5Z"
        fill="#fff"
      />
      <path d="m19.5 24.2 3.2 3.2 6-6" fill="none" stroke="#1f5fbf" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
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
