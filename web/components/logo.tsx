// Marca do Tech Audit: "radar" — arcos nas três cores da Tech Master em volta de um ponto, monitoramento
// contínuo. As cores vêm das variáveis --lm-* de globals.css, que trocam no tema escuro e sobre o painel roxo.
// Mesmo desenho de app/icon.svg (versão clara, porque SVG de favicon não lê o CSS da página).
export function LogoMark({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg className={className ? `logo-mark ${className}` : 'logo-mark'} width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <rect className="lm-tile" width="48" height="48" rx="11" />
      <path className="lm-arc lm-a" d="M24 8a16 16 0 0 1 16 16" />
      <path className="lm-arc lm-b" d="M40 24a16 16 0 0 1-16 16" />
      <path className="lm-arc lm-c" d="M24 40A16 16 0 0 1 8 24" />
      <path className="lm-inner" d="M24 15a9 9 0 1 1-9 9" />
      <circle className="lm-dot" cx="24" cy="24" r="3.6" />
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
