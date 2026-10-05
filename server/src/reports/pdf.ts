import PDFDocument from 'pdfkit';
import { cellText, type ReportColumn, type ReportTable } from './table.js';

// Relatório em PDF (A4 paisagem): título, contexto, tabela com cabeçalho
// repetido em cada página e rodapé com a numeração.

const MARGIN = 36;
const FONT = 'Helvetica';
const BOLD = 'Helvetica-Bold';
const SIZE = 7.5;
const ROW_H = 14;
// Cabeçalho com até duas linhas, para rótulos longos de ação.
const HEAD_H = 22;
const WEIGHT: Record<ReportColumn['kind'], number> = { text: 1.6, path: 3.4, int: 0.8, datetime: 1.7 };

// As fontes padrão do PDF só cobrem Latin-1 (WinAnsi); o resto vira "?".
export const pdfSafe = (s: string) => s.replace(/[^\u0009 -~ -ÿ]/g, '?');

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

// extra são tabelas a mais, cada uma começando em página nova (ex.: apêndice).
export function reportPdf(t: ReportTable, footer: string, extra: ReportTable[] = []): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: MARGIN, bufferPages: true, info: { Title: pdfSafe(t.title), Creator: 'Tech Audit' } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const width = doc.page.width - MARGIN * 2;
  const bottom = doc.page.height - MARGIN - 16;
  const draw = (t: ReportTable) => {
    const widths = columnWidths(t.columns, width);

    doc.font(BOLD).fontSize(15).fillColor('#1c2330').text(pdfSafe(t.title), MARGIN, MARGIN);
    doc.moveDown(0.3).font(FONT).fontSize(9).fillColor('#5d6779');
    for (const line of t.info) doc.text(pdfSafe(line));
    if (t.truncated) doc.fillColor('#9a6700').text('Resultado limitado; refine os filtros ou o período para ver tudo.');
    let y = doc.y + 10;

    // Cabeçalho quebra em até duas linhas; células cortam o texto para caber.
    const cell = (text: string, x: number, w: number, c: ReportColumn, h = ROW_H) => {
      const head = h > ROW_H;
      const s = head ? pdfSafe(text) : fitText(pdfSafe(text), w - 6, c.kind === 'path', (t) => doc.widthOfString(t));
      doc.text(s, x + 3, y + 3.5, { width: w - 6, height: h - 4, lineBreak: head, ellipsis: head, align: c.kind === 'int' ? 'right' : 'left' });
    };

    const header = () => {
      doc.rect(MARGIN, y, width, HEAD_H).fill('#e8eef8');
      doc.font(BOLD).fontSize(SIZE).fillColor('#1c2330');
      let x = MARGIN;
      t.columns.forEach((c, i) => {
        cell(c.label, x, widths[i], c, HEAD_H);
        x += widths[i];
      });
      y += HEAD_H;
    };

    header();
    if (t.rows.length === 0) {
      doc.font(FONT).fontSize(9).fillColor('#5d6779').text('Nenhum registro encontrado com esses filtros.', MARGIN, y + 8);
    }
    t.rows.forEach((row, n) => {
      if (y + ROW_H > bottom) {
        doc.addPage();
        y = MARGIN;
        header();
      }
      if (n % 2 === 1) doc.rect(MARGIN, y, width, ROW_H).fill('#f5f6f8');
      doc.font(FONT).fontSize(SIZE).fillColor('#1c2330');
      let x = MARGIN;
      t.columns.forEach((c, i) => {
        cell(cellText(c, row[c.key] ?? null), x, widths[i], c);
        x += widths[i];
      });
      y += ROW_H;
    });
  };

  draw(t);
  for (const x of extra) {
    doc.addPage();
    draw(x);
  }

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.font(FONT).fontSize(7.5).fillColor('#5d6779');
    // Sem margem inferior, para o texto do rodapé não abrir página nova.
    const m = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.text(pdfSafe(footer), MARGIN, doc.page.height - MARGIN, { width: width - 80, lineBreak: false });
    doc.text(`Página ${i + 1} de ${range.count}`, MARGIN + width - 80, doc.page.height - MARGIN, { width: 80, align: 'right', lineBreak: false });
    doc.page.margins.bottom = m;
  }
  doc.end();
  return done;
}
