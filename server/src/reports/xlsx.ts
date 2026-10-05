import { crc32, deflateRawSync } from 'node:zlib';
import { BRT_OFFSET_MS, type ReportTable } from './table.js';

// Gerador mínimo de .xlsx (Office Open XML), sem dependências: uma planilha
// com título, linhas de contexto, cabeçalho congelado e filtro automático.
// Datas viram datas de verdade do Excel, no horário de Brasília.

const esc = (s: string) =>
  s
    // Caracteres de controle não são aceitos no XML.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// 0 -> A, 25 -> Z, 26 -> AA
export function colName(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// Data serial do Excel (dias desde 1899-12-30) no horário de Brasília.
export const excelDate = (iso: string) => (new Date(iso).getTime() + BRT_OFFSET_MS) / 86_400_000 + 25569;

// Estilos: 0 normal, 1 negrito (cabeçalho), 2 data/hora, 3 título, 4 contexto.
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy hh:mm:ss"/></numFmts>
<fonts count="4"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font><font><sz val="10"/><color rgb="FF5D6779"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF8"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

const WIDTH: Record<string, number> = { text: 28, path: 70, int: 12, datetime: 20 };

function sheetXml(t: ReportTable): string {
  const rows: string[] = [];
  let r = 0;
  const str = (ref: string, v: string, style = 0) =>
    `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
  rows.push(`<row r="${++r}">${str(`A${r}`, t.title, 3)}</row>`);
  for (const line of t.info) rows.push(`<row r="${++r}">${str(`A${r}`, line, 4)}</row>`);
  if (t.truncated) rows.push(`<row r="${++r}">${str(`A${r}`, 'Resultado limitado; refine os filtros ou o período para ver tudo.', 4)}</row>`);
  r++; // linha em branco
  const header = ++r;
  rows.push(`<row r="${header}">${t.columns.map((c, i) => str(`${colName(i)}${header}`, c.label, 1)).join('')}</row>`);
  for (const row of t.rows) {
    const n = ++r;
    const cells = t.columns.map((c, i) => {
      const ref = `${colName(i)}${n}`;
      const v = row[c.key];
      if (v === null || v === undefined || v === '') return '';
      if (c.kind === 'int') return `<c r="${ref}"><v>${Number(v)}</v></c>`;
      if (c.kind === 'datetime') return `<c r="${ref}" s="2"><v>${excelDate(String(v))}</v></c>`;
      return str(ref, String(v));
    });
    rows.push(`<row r="${n}">${cells.join('')}</row>`);
  }
  const last = colName(Math.max(t.columns.length - 1, 0));
  const cols = t.columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${WIDTH[c.kind]}" customWidth="1"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="${header}" topLeftCell="A${header + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${cols}</cols>
<sheetData>${rows.join('')}</sheetData>
<autoFilter ref="A${header}:${last}${Math.max(r, header)}"/>
</worksheet>`;
}

// extra são planilhas a mais no mesmo arquivo (ex.: apêndice).
export function reportXlsx(t: ReportTable, extra: { table: ReportTable; sheet: string }[] = [], sheet = 'Relatório'): Buffer {
  const sheets = [{ table: t, sheet }, ...extra];
  const n = sheets.map((_, i) => i + 1);
  return zip([
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${n.map((i) => `<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
      .map((x, i) => `<sheet name="${esc(sheetName(x.sheet))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${n
      .map((i) => `<Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i}.xml"/>`)
      .join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', STYLES],
    ...sheets.map((x, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(x.table)]),
  ]);
}

// O Excel recusa nomes de planilha com []:*?/\ ou com mais de 31 caracteres.
const sheetName = (s: string) => s.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31);

// ZIP com compressão deflate (o mínimo que o Excel exige).
export function zip(files: [string, string | Buffer][]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  // 01/01/2026 00:00 no formato DOS; a data do arquivo não importa.
  const dosTime = 0;
  const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const [name, content] of files) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const packed = deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // nomes em UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(dosTime, 12);
    dir.writeUInt16LE(dosDate, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(packed.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    parts.push(local, nameBuf, packed);
    central.push(dir, nameBuf);
    offset += local.length + nameBuf.length + packed.length;
  }
  const dirBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dirBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dirBuf, end]);
}
