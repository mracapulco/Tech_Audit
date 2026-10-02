import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bucketFor, bucketKeys, bucketLabel } from '../src/reports/report-query.js';
import { columnWidths, fitText, pdfSafe, reportPdf } from '../src/reports/pdf.js';
import { cellText, sortActions, type ReportTable } from '../src/reports/table.js';
import { colName, excelDate, reportXlsx } from '../src/reports/xlsx.js';
import { agentHealth } from '../src/reports/reports.service.js';
import { unzip } from './fixtures.js';

const table: ReportTable = {
  title: 'Atividade por usuário',
  info: ['Empresa: Cliente & Cia', 'Período: 01/10/2026 00:00:00 a 02/10/2026 00:00:00'],
  columns: [
    { key: 'user', label: 'Usuário', kind: 'text' },
    { key: 'path', label: 'Caminho', kind: 'path' },
    { key: 'total', label: 'Eventos', kind: 'int' },
    { key: 'last', label: 'Último evento', kind: 'datetime' },
  ],
  rows: [
    { user: 'CORP\\joão', path: 'D:\\Dados\\<a>.txt', total: 1234, last: '2026-10-01T15:00:00Z' },
    { user: '=HYPERLINK("x")', path: null, total: 0, last: null },
  ],
  truncated: false,
};

describe('formatos dos relatórios', () => {
  it('nomes de coluna do Excel', () => {
    assert.deepEqual([0, 25, 26, 27, 701, 702].map(colName), ['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
  });

  it('data do Excel no horário de Brasília', () => {
    // 2026-10-01 12:00 em Brasília = 46296,5
    assert.equal(excelDate('2026-10-01T15:00:00Z'), 46296.5);
  });

  it('gera um .xlsx válido com cabeçalho, números e datas', () => {
    const files = unzip(reportXlsx(table));
    assert.deepEqual([...files.keys()].sort(), [
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
    ]);
    const sheet = files.get('xl/worksheets/sheet1.xml')!;
    assert.match(sheet, /Cliente &amp; Cia/);
    assert.match(sheet, /D:\\Dados\\&lt;a&gt;.txt/);
    assert.match(sheet, /<c r="C6"><v>1234<\/v><\/c>/);
    assert.match(sheet, /<c r="D6" s="2"><v>46296.5<\/v><\/c>/);
    // Texto continua texto (o Excel não interpreta como fórmula).
    assert.match(sheet, /t="inlineStr"><is><t xml:space="preserve">=HYPERLINK\(&quot;x&quot;\)<\/t>/);
    assert.match(sheet, /<autoFilter ref="A5:D7"\/>/);
  });

  it('gera um PDF com várias páginas quando há muitas linhas', async () => {
    const many = { ...table, rows: Array.from({ length: 120 }, (_, i) => ({ user: `u${i}`, path: 'D:\\x', total: i, last: null })) };
    const pdf = await reportPdf(many, 'Tech Audit · teste');
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    const pages = pdf.toString('latin1').match(/\/Type \/Page\b/g)?.length ?? 0;
    assert.ok(pages >= 3, `páginas: ${pages}`);
  });

  it('PDF: texto fora do Latin-1 e larguras proporcionais', () => {
    assert.equal(pdfSafe('ação → 日本'), 'ação ? ??');
    const len = (t: string) => t.length;
    assert.equal(fitText('curto', 10, false, len), 'curto');
    assert.equal(fitText('EXEMPLO\\carlos.pereira', 10, false, len), 'EXEMPLO...');
    assert.equal(fitText('D:\\Dados\\Financeiro\\arquivo.xlsx', 16, true, len), 'D:\\Dado...o.xlsx');
    const w = columnWidths(table.columns, 700);
    assert.equal(Math.round(w.reduce((a, b) => a + b, 0)), 700);
    assert.ok(w[1] > w[0] && w[0] > w[2]);
  });

  it('texto das células', () => {
    assert.equal(cellText(table.columns[2], 1234), '1.234');
    assert.equal(cellText(table.columns[3], '2026-10-01T15:00:00Z'), '01/10/2026 12:00:00');
    assert.equal(cellText(table.columns[0], null), '-');
  });

  it('ações conhecidas primeiro, novas em ordem alfabética', () => {
    assert.deepEqual(sortActions(['moved_to_recycle_bin', 'delete', 'created', 'read', 'delete']), ['read', 'delete', 'created', 'moved_to_recycle_bin']);
  });

  it('intervalos do gráfico por período, no horário de Brasília', () => {
    const d = (s: string) => new Date(s);
    assert.equal(bucketFor(d('2026-10-01T00:00:00Z'), d('2026-10-02T00:00:00Z')), 'hour');
    assert.equal(bucketFor(d('2026-09-01T00:00:00Z'), d('2026-10-01T00:00:00Z')), 'day');
    assert.equal(bucketFor(d('2026-01-01T00:00:00Z'), d('2026-10-01T00:00:00Z')), 'month');
    // 01/10 21:00 a 02/10 00:30 em Brasília
    assert.deepEqual(bucketKeys(d('2026-10-02T00:00:00Z'), d('2026-10-02T03:30:00Z'), 'hour'), [
      '2026-10-01T21:00',
      '2026-10-01T22:00',
      '2026-10-01T23:00',
      '2026-10-02T00:00',
    ]);
    assert.deepEqual(bucketKeys(d('2026-09-29T03:00:00Z'), d('2026-10-02T03:00:00Z'), 'day'), ['2026-09-29', '2026-09-30', '2026-10-01']);
    assert.deepEqual(bucketKeys(d('2026-08-15T03:00:00Z'), d('2026-10-02T03:00:00Z'), 'month'), ['2026-08', '2026-09', '2026-10']);
    assert.equal(bucketLabel('2026-10-01T21:00', 'hour'), '01/10 21h');
    assert.equal(bucketLabel('2026-10-01', 'day'), '01/10/2026');
    assert.equal(bucketLabel('2026-10', 'month'), '10/2026');
  });

  it('saúde do agente pelo último envio', () => {
    const now = new Date('2026-10-02T12:00:00Z');
    const ago = (h: number) => new Date(now.getTime() - h * 3600_000);
    assert.equal(agentHealth({ lastSeenAt: ago(0.5), disabledAt: null }, now), 'ok');
    assert.equal(agentHealth({ lastSeenAt: ago(5), disabledAt: null }, now), 'late');
    assert.equal(agentHealth({ lastSeenAt: ago(30), disabledAt: null }, now), 'stale');
    assert.equal(agentHealth({ lastSeenAt: null, disabledAt: null }, now), 'never');
    assert.equal(agentHealth({ lastSeenAt: ago(0.5), disabledAt: now }, now), 'disabled');
  });
});
