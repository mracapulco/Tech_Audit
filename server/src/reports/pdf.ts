import PDFDocument from 'pdfkit';
import { COLOR, companyOf, footerText, INTER, LOGO, PLATFORM, STRIPE, TAGLINE, VENDOR } from './brand.js';
import { cellText, type ReportColumn, type ReportField, type ReportTable } from './table.js';

// Relatório em PDF (A4 paisagem) no padrão visual da plataforma (brand.ts):
// faixa Tech Audit, título, dados do cliente, tabela com cabeçalho repetido em
// cada página e rodapé com a numeração.

const MARGIN = 36;
const FONT = 'Inter';
const SEMI = 'Inter-SemiBold';
const BOLD = 'Inter-Bold';
// Altura da faixa da plataforma: completa na abertura, fina nas demais páginas.
const BAND_H = 54;
const SLIM_H = 24;
const SIZE = 7.5;
const ROW_H = 14;
// Cabeçalho com até duas linhas, para rótulos longos de ação.
const HEAD_H = 22;
const WEIGHT: Record<ReportColumn['kind'], number> = { text: 1.6, path: 3.4, int: 0.8, datetime: 1.7 };

// A Inter embutida (subconjunto latin) cobre o Latin-1 e a pontuação comum;
// o resto vira "?".
export const pdfSafe = (s: string) => s.replace(/[^\u0009\u0020-\u007e\u00a0-\u00ff\u2000-\u206f\u20ac\u2122]/g, '?');

// Corta o texto para caber em `width`. Caminhos perdem o meio, para o nome do
// arquivo continuar visível; o resto perde o fim.
export function fitText(s: string, width: number, middle: boolean, measure: (t: string) => number): string {
  if (measure(s) <= width) return s;
  const cut = (n: number) => (middle ? s.slice(0, Math.ceil(n / 2)) + '...' + s.slice(s.length - Math.floor(n / 2)) : s.slice(0, n) + '...');
  let lo = 0;
  let hi = s.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(cut(mid)) <= width) lo = mid;
    else hi = mid - 1;
  }
  return cut(lo);
}

// Larguras proporcionais ao tipo de coluna, ocupando a largura útil.
export function columnWidths(columns: ReportColumn[], total: number): number[] {
  const sum = columns.reduce((n, c) => n + WEIGHT[c.kind], 0) || 1;
  return columns.map((c) => (WEIGHT[c.kind] / sum) * total);
}

// Desenha o logo radar (viewBox 48x48) com `size` pontos em (x, y).
function drawLogo(doc: PDFKit.PDFDocument, x: number, y: number, size: number) {
  const k = size / 48;
  doc.save().translate(x, y).scale(k);
  doc.roundedRect(0, 0, 48, 48, 11).fill(LOGO.tile);
  doc.lineCap('round');
  for (const a of LOGO.arcs) doc.path(a.d).lineWidth(4.5).stroke(a.color);
  doc.path(LOGO.inner).lineWidth(3.5).stroke('#ffffff');
  doc.circle(24, 24, 3.6).fill('#ffffff');
  doc.restore();
}

// Faixa tricolor da Tech Master na largura toda da página.
function drawStripe(doc: PDFKit.PDFDocument, y: number, h: number) {
  let x = 0;
  for (const [color, part] of STRIPE) {
    const w = doc.page.width * part;
    doc.rect(x, y, w, h).fill(color);
    x += w;
  }
}

// extra são tabelas a mais, cada uma começando em página nova (ex.: apêndice).
export function reportPdf(t: ReportTable, extra: ReportTable[] = []): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    layout: 'landscape',
    margin: MARGIN,
    bufferPages: true,
    info: { Title: pdfSafe(t.title), Author: VENDOR, Creator: PLATFORM },
  });
  doc.registerFont(FONT, INTER.regular);
  doc.registerFont(SEMI, INTER.semibold);
  doc.registerFont(BOLD, INTER.bold);
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const width = doc.page.width - MARGIN * 2;
  const right = MARGIN + width;
  const bottom = doc.page.height - MARGIN - 16;
  const company = companyOf(t);

  // Cabeçalho da plataforma na primeira página de cada tabela: faixa roxa com
  // logo, nome e Tech Master; nas páginas seguintes, uma versão fina.
  const band = (full: boolean): number => {
    const h = full ? BAND_H : SLIM_H;
    doc.rect(0, 0, doc.page.width, h).fill(COLOR.ink);
    drawStripe(doc, h, 3);
    const logo = full ? 32 : 16;
    drawLogo(doc, MARGIN, (h - logo) / 2, logo);
    const x = MARGIN + logo + (full ? 10 : 7);
    if (full) {
      doc.font(SEMI).fontSize(15).fillColor('#ffffff').text(PLATFORM, x, h / 2 - 15, { lineBreak: false });
      doc.font(FONT).fontSize(8).fillColor(COLOR.purpleSoft).text(TAGLINE, x, h / 2 + 4, { lineBreak: false });
      doc.font(SEMI).fontSize(9).fillColor('#ffffff').text(VENDOR, right - 220, h / 2 - 11, { width: 220, align: 'right', lineBreak: false });
      doc.font(FONT).fontSize(8).fillColor(COLOR.purpleSoft).text('techmaster.inf.br', right - 220, h / 2 + 2, { width: 220, align: 'right', lineBreak: false });
    } else {
      doc.font(SEMI).fontSize(8.5).fillColor('#ffffff').text(PLATFORM, x, h / 2 - 5.5, { lineBreak: false });
      const ctx = pdfSafe([t.title, company].filter(Boolean).join(' · '));
      doc.font(FONT).fontSize(8).fillColor(COLOR.purpleSoft).text(ctx, right - 420, h / 2 - 5, { width: 420, align: 'right', lineBreak: false });
    }
    return h + 3;
  };

  // Dados do cliente em uma grade de três colunas sobre fundo lavanda.
  const clientBox = (fields: ReportField[], top: number): number => {
    const cols = 3;
    const pad = 10;
    const colW = (width - pad * 2) / cols;
    const rows: ReportField[][] = [];
    for (let i = 0; i < fields.length; i += cols) rows.push(fields.slice(i, i + cols));
    const valueH = (f: ReportField) => doc.font(FONT).fontSize(9).heightOfString(pdfSafe(f.value), { width: colW - 12 });
    const heights = rows.map((r) => 11 + Math.max(...r.map(valueH)));
    const h = pad * 2 + heights.reduce((a, b) => a + b, 0) + (rows.length - 1) * 6;
    doc.rect(MARGIN, top, width, h).fill(COLOR.lavender);
    doc.rect(MARGIN, top, 3, h).fill(COLOR.purple);
    let y = top + pad;
    rows.forEach((r, i) => {
      r.forEach((f, j) => {
        const x = MARGIN + pad + j * colW;
        doc.font(SEMI).fontSize(6.5).fillColor(COLOR.label).text(f.label.toUpperCase(), x, y, { width: colW - 12, characterSpacing: 0.5, lineBreak: false });
        doc.font(FONT).fontSize(9).fillColor(COLOR.text).text(pdfSafe(f.value), x, y + 10, { width: colW - 12 });
      });
      y += heights[i] + 6;
    });
    return top + h;
  };

  const draw = (t: ReportTable, first: boolean) => {
    const widths = columnWidths(t.columns, width);

    let y = band(true) + 14;
    doc.font(BOLD).fontSize(15).fillColor(COLOR.ink).text(pdfSafe(t.title), MARGIN, y);
    y = doc.y + 6;
    // O bloco completo do cliente vai na primeira tabela; o apêndice só lembra a empresa.
    if (first) y = clientBox(t.client, y) + 8;
    doc.font(FONT).fontSize(8).fillColor(COLOR.muted);
    for (const line of t.notes) {
      doc.text(pdfSafe(line), MARGIN, y, { width });
      y = doc.y + 1;
    }
    if (t.truncated) {
      doc.fillColor(COLOR.warn).text('Resultado limitado; refine os filtros ou o período para ver tudo.', MARGIN, y, { width });
      y = doc.y + 1;
    }
    y += 8;

    // Cabeçalho quebra em até duas linhas; células cortam o texto para caber.
    const cell = (text: string, x: number, w: number, c: ReportColumn, h = ROW_H) => {
      const head = h > ROW_H;
      const s = head ? pdfSafe(text) : fitText(pdfSafe(text), w - 6, c.kind === 'path', (t) => doc.widthOfString(t));
      doc.text(s, x + 3, y + (head ? 4 : 3.5), { width: w - 6, height: h - 4, lineBreak: head, ellipsis: head, align: c.kind === 'int' ? 'right' : 'left' });
    };

    const header = () => {
      doc.rect(MARGIN, y, width, HEAD_H).fill(COLOR.ink);
      doc.font(SEMI).fontSize(SIZE).fillColor('#ffffff');
      let x = MARGIN;
      t.columns.forEach((c, i) => {
        cell(c.label, x, widths[i], c, HEAD_H);
        x += widths[i];
      });
      y += HEAD_H;
    };

    header();
    if (t.rows.length === 0) {
      doc.font(FONT).fontSize(9).fillColor(COLOR.muted).text('Nenhum registro encontrado com esses filtros.', MARGIN, y + 8);
    }
    t.rows.forEach((row, n) => {
      if (y + ROW_H > bottom) {
        doc.addPage();
        y = band(false) + 12;
        header();
      }
      if (n % 2 === 1) doc.rect(MARGIN, y, width, ROW_H).fill(COLOR.zebra);
      doc.font(FONT).fontSize(SIZE).fillColor(COLOR.text);
      let x = MARGIN;
      t.columns.forEach((c, i) => {
        cell(cellText(c, row[c.key] ?? null), x, widths[i], c);
        x += widths[i];
      });
      y += ROW_H;
    });
  };

  draw(t, true);
  for (const x of extra) {
    doc.addPage();
    draw(x, false);
  }

  const footer = pdfSafe(footerText(t));
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    // Sem margem inferior, para o texto do rodapé não abrir página nova.
    const m = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const y = doc.page.height - MARGIN;
    doc.moveTo(MARGIN, y - 6).lineTo(right, y - 6).lineWidth(0.5).stroke('#d9d7ec');
    doc.font(FONT).fontSize(7).fillColor(COLOR.muted);
    doc.text(footer, MARGIN, y, { width: width - 90, lineBreak: false });
    doc.text(`Página ${i + 1} de ${range.count}`, right - 90, y, { width: 90, align: 'right', lineBreak: false });
    doc.page.margins.bottom = m;
  }
  doc.end();
  return done;
}
