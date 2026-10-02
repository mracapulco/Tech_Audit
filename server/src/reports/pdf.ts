import PDFDocument from 'pdfkit';
import { cellText, type ReportColumn, type ReportTable } from './table.js';

// Relatório em PDF (A4 paisagem): título, contexto, tabela com cabeçalho
// repetido em cada página e rodapé com a numeração.

const MARGIN = 36;
const FONT = 'Helvetica';
const BOLD = 'Helvetica-Bold';
const SIZE = 7.5;
const ROW_H = 14;
const WEIGHT: Record<ReportColumn['kind'], number> = { text: 1.6, path: 3.4, int: 0.8, datetime: 1.3 };

// As fontes padrão do PDF só cobrem Latin-1 (WinAnsi); o resto vira "?".
export const pdfSafe = (s: string) => s.replace(/[^\u0009 -~ -ÿ]/g, '?');

// Larguras proporcionais ao tipo de coluna, ocupando a largura útil.
export function columnWidths(columns: ReportColumn[], total: number): number[] {
  const sum = columns.reduce((n, c) => n + WEIGHT[c.kind], 0) || 1;
  return columns.map((c) => (WEIGHT[c.kind] / sum) * total);
}

export function reportPdf(t: ReportTable, footer: string): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: MARGIN, bufferPages: true, info: { Title: pdfSafe(t.title), Creator: 'Tech Audit' } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const width = doc.page.width - MARGIN * 2;
  const bottom = doc.page.height - MARGIN - 16;
  const widths = columnWidths(t.columns, width);

  doc.font(BOLD).fontSize(15).fillColor('#1c2330').text(pdfSafe(t.title), MARGIN, MARGIN);
  doc.moveDown(0.3).font(FONT).fontSize(9).fillColor('#5d6779');
  for (const line of t.info) doc.text(pdfSafe(line));
  if (t.truncated) doc.fillColor('#9a6700').text('Resultado limitado; refine os filtros ou o período para ver tudo.');
  let y = doc.y + 10;

  const cell = (text: string, x: number, w: number, c: ReportColumn) =>
    doc.text(pdfSafe(text), x + 3, y + 3.5, {
      width: w - 6,
      height: ROW_H - 4,
      lineBreak: false,
      ellipsis: true,
      align: c.kind === 'int' ? 'right' : 'left',
    });

  const header = () => {
    doc.rect(MARGIN, y, width, ROW_H).fill('#e8eef8');
    doc.font(BOLD).fontSize(SIZE).fillColor('#1c2330');
    let x = MARGIN;
    t.columns.forEach((c, i) => {
      cell(c.label, x, widths[i], c);
      x += widths[i];
    });
    y += ROW_H;
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
