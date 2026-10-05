import { createRequire } from 'node:module';
import type { ReportTable } from './table.js';

// Identidade visual comum a todos os relatórios (PDF e Excel): faixa roxa com
// o logo radar e o nome da plataforma, a faixa tricolor da Tech Master e, logo
// abaixo, o bloco com os dados do cliente. Mesmas cores do portal
// (web/app/globals.css).

export const PLATFORM = 'Tech Audit';
export const TAGLINE = 'Auditoria de servidores de arquivos';
export const VENDOR = 'Tech Master Informática';

export const COLOR = {
  ink: '#2c2960', // faixa do topo e cabeçalho das tabelas
  purple: '#7a75b5',
  purpleSoft: '#a9a5e6',
  cyan: '#5cc6d0',
  green: '#a8cf45',
  lavender: '#f2f1f9', // fundo do bloco do cliente
  zebra: '#f7f7fb',
  text: '#1c2330',
  muted: '#5d6779',
  label: '#6b6894',
  warn: '#9a6700',
};

// Proporção da faixa tricolor, como a barra do portal: 50% roxo, 30% ciano, 20% verde.
export const STRIPE: [string, number][] = [
  [COLOR.purple, 0.5],
  [COLOR.cyan, 0.3],
  [COLOR.green, 0.2],
];

// Inter, a fonte do portal. O subconjunto "latin" cobre o português.
const require = createRequire(import.meta.url);
export const INTER = {
  regular: require.resolve('@fontsource/inter/files/inter-latin-400-normal.woff'),
  semibold: require.resolve('@fontsource/inter/files/inter-latin-600-normal.woff'),
  bold: require.resolve('@fontsource/inter/files/inter-latin-700-normal.woff'),
};

// Logo radar (viewBox 48x48), igual a web/components/logo.tsx na versão sobre o roxo.
export const LOGO = {
  tile: '#3d3a6d',
  arcs: [
    { d: 'M24 8a16 16 0 0 1 16 16', color: COLOR.purpleSoft },
    { d: 'M40 24a16 16 0 0 1-16 16', color: COLOR.cyan },
    { d: 'M24 40A16 16 0 0 1 8 24', color: COLOR.green },
  ],
  inner: 'M24 15a9 9 0 1 1-9 9',
};

// Empresa do relatório, para rodapés e assuntos de e-mail.
export const companyOf = (t: ReportTable) => t.client.find((f) => f.label === 'Empresa')?.value ?? '';

// Rodapé: plataforma, relatório e empresa.
export const footerText = (t: ReportTable) => [PLATFORM, t.title, companyOf(t)].filter(Boolean).join(' · ');
