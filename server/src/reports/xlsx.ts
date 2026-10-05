import { crc32, deflateRawSync } from 'node:zlib';
import { COLOR, footerText, PLATFORM, STRIPE, TAGLINE, VENDOR } from './brand.js';
import { BAND_PNG } from './band-png.js';
import { BRT_OFFSET_MS, type ReportTable } from './table.js';

// Gerador mínimo de .xlsx (Office Open XML), sem dependências, no padrão
// visual da plataforma (brand.ts): faixa Tech Audit com logo, título, dados do
// cliente, cabeçalho da tabela congelado e filtro automático. Datas viram
// datas de verdade do Excel, no horário de Brasília.

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

// Imagem da faixa (band-png.ts) em 466x54 px, a 8 px da borda e centrada na
// altura das duas linhas roxas (34 + 20 pt = 72 px).
const EMU_PX = 9525;
const BAND_W = 466;
const BAND_IMG_H = 54;

const argb = (hex: string) => `FF${hex.slice(1).toUpperCase()}`;
const font = (o: { sz: number; bold?: boolean; color?: string }) =>
  `<font>${o.bold ? '<b/>' : ''}<sz val="${o.sz}"/>${o.color ? `<color rgb="${argb(o.color)}"/>` : ''}<name val="Calibri"/></font>`;
const fill = (hex: string) => `<fill><patternFill patternType="solid"><fgColor rgb="${argb(hex)}"/></patternFill></fill>`;

// Estilos (índice = s="..."): mesmas cores do PDF e do portal (brand.ts).
const S = {
  normal: 0,
  head: 1, // cabeçalho da tabela
  date: 2,
  band: 3, // faixa roxa (a imagem com logo e nome fica por cima)
  stripe: [4, 5, 6], // faixa tricolor
  title: 7,
  label: 8, // rótulo dos dados do cliente
  value: 9,
  note: 10,
  warn: 11,
};
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy hh:mm:ss"/></numFmts>
<fonts count="7">${[
  font({ sz: 11 }),
  font({ sz: 11, bold: true, color: '#ffffff' }),
  font({ sz: 14, bold: true, color: COLOR.ink }),
  font({ sz: 9, bold: true, color: COLOR.label }),
  font({ sz: 11, color: COLOR.text }),
  font({ sz: 10, color: COLOR.muted }),
  font({ sz: 10, color: COLOR.warn }),
].join('')}</fonts>
<fills count="7"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>${[COLOR.ink, ...STRIPE.map(([c]) => c), COLOR.lavender].map(fill).join('')}</fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="12">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0" applyFill="1"/>
<xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1"/>
<xf numFmtId="0" fontId="0" fillId="4" borderId="0" xfId="0" applyFill="1"/>
<xf numFmtId="0" fontId="0" fillId="5" borderId="0" xfId="0" applyFill="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="3" fillId="6" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" indent="1"/></xf>
<xf numFmtId="0" fontId="4" fillId="6" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="5" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="6" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

const WIDTH: Record<string, number> = { text: 28, path: 70, int: 12, datetime: 20 };

function sheetXml(t: ReportTable): { xml: string; header: number } {
  const rows: string[] = [];
  let r = 0;
  const n = Math.max(t.columns.length, 2);
  const str = (ref: string, v: string, style = 0) =>
    `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
  const blank = (ref: string, style: number) => `<c r="${ref}" s="${style}"/>`;
  // Linha com texto na coluna A (e opcionalmente B) e o fundo `fill` até a última coluna.
  const line = (cells: [string, number][], fill: number, ht?: number) => {
    const row = ++r;
    const xs = Array.from({ length: n }, (_, i) => (cells[i] ? str(`${colName(i)}${row}`, cells[i][0], cells[i][1]) : fill ? blank(`${colName(i)}${row}`, fill) : ''));
    rows.push(`<row r="${row}"${ht ? ` ht="${ht}" customHeight="1"` : ''}>${xs.join('')}</row>`);
  };

  // Cabeçalho da plataforma: faixa roxa com logo e nome, faixa tricolor.
  line([], S.band, 34);
  line([], S.band, 20);
  {
    const row = ++r;
    const widths = t.columns.map((c) => WIDTH[c.kind]);
    const total = widths.reduce((a, b) => a + b, 0) || 1;
    let acc = 0;
    const cells = Array.from({ length: n }, (_, i) => {
      // Cor pela posição do meio da coluna: 50% roxo, 30% ciano, 20% verde.
      const mid = (acc + (widths[i] ?? 0) / 2) / total;
      acc += widths[i] ?? 0;
      const k = mid < STRIPE[0][1] ? 0 : mid < STRIPE[0][1] + STRIPE[1][1] ? 1 : 2;
      return blank(`${colName(i)}${row}`, S.stripe[k]);
    });
    rows.push(`<row r="${row}" ht="4" customHeight="1">${cells.join('')}</row>`);
  }
  r++; // linha em branco
  line([[t.title, S.title]], 0, 22);
  // Dados do cliente: rótulo na coluna A, valor na B, fundo lavanda na largura da tabela.
  for (const f of t.client) line([[f.label, S.label], [f.value, S.value]], S.value, 18);
  for (const note of t.notes) line([[note, S.note]], 0);
  if (t.truncated) line([['Resultado limitado; refine os filtros ou o período para ver tudo.', S.warn]], 0);
  r++; // linha em branco
  const header = ++r;
  rows.push(`<row r="${header}" ht="20" customHeight="1">${t.columns.map((c, i) => str(`${colName(i)}${header}`, c.label, S.head)).join('')}</row>`);
  for (const row of t.rows) {
    const n = ++r;
    const cells = t.columns.map((c, i) => {
      const ref = `${colName(i)}${n}`;
      const v = row[c.key];
      if (v === null || v === undefined || v === '') return '';
      if (c.kind === 'int') return `<c r="${ref}"><v>${Number(v)}</v></c>`;
      if (c.kind === 'datetime') return `<c r="${ref}" s="${S.date}"><v>${excelDate(String(v))}</v></c>`;
      return str(ref, String(v));
    });
    rows.push(`<row r="${n}">${cells.join('')}</row>`);
  }
  const last = colName(Math.max(t.columns.length - 1, 0));
  const cols = t.columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${WIDTH[c.kind]}" customWidth="1"/>`).join('');
  // Rodapé da impressão igual ao do PDF.
  const footer = `&amp;L&amp;8${esc(footerText(t).replace(/&/g, '&&'))}&amp;R&amp;8Página &amp;P de &amp;N`;
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>
<sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="${header}" topLeftCell="A${header + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${cols}</cols>
<sheetData>${rows.join('')}</sheetData>
<autoFilter ref="A${header}:${last}${Math.max(r, header)}"/>
<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.6" header="0.3" footer="0.3"/>
<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>
<headerFooter><oddFooter>${footer}</oddFooter></headerFooter>
<drawing r:id="rId1"/>
</worksheet>`;
  return { xml, header };
}

// Logo e nome da plataforma ancorados no canto da faixa roxa.
const DRAWING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><xdr:oneCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>${8 * EMU_PX}</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>${9 * EMU_PX}</xdr:rowOff></xdr:from><xdr:ext cx="${BAND_W * EMU_PX}" cy="${BAND_IMG_H * EMU_PX}"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="Tech Audit" descr="${PLATFORM} · ${TAGLINE} · ${VENDOR}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${BAND_W * EMU_PX}" cy="${BAND_IMG_H * EMU_PX}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>`;

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

// extra são planilhas a mais no mesmo arquivo (ex.: apêndice).
export function reportXlsx(t: ReportTable, extra: { table: ReportTable; sheet: string }[] = [], sheet = 'Relatório'): Buffer {
  const sheets = [{ table: t, sheet }, ...extra].map((x) => ({ ...x, name: sheetName(x.sheet), ...sheetXml(x.table) }));
  const n = sheets.map((_, i) => i + 1);
  // Repete o cabeçalho da tabela em cada página impressa.
  const printTitles = sheets
    .map((x, i) => `<definedName name="_xlnm.Print_Titles" localSheetId="${i}">'${esc(x.name.replace(/'/g, "''"))}'!$${x.header}:$${x.header}</definedName>`)
    .join('');
  return zip([
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${n.map((i) => `<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/drawings/drawing${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><sheets>${sheets
      .map((x, i) => `<sheet name="${esc(x.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('')}</sheets><definedNames>${printTitles}</definedNames></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${n
      .map((i) => `<Relationship Id="rId${i}" Type="${REL}/worksheet" Target="worksheets/sheet${i}.xml"/>`)
      .join('')}<Relationship Id="rId${sheets.length + 1}" Type="${REL}/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', STYLES],
    ['xl/media/faixa.png', BAND_PNG],
    ...sheets.flatMap((x, i): [string, string][] => [
      [`xl/worksheets/sheet${i + 1}.xml`, x.xml],
      [`xl/worksheets/_rels/sheet${i + 1}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/drawing" Target="../drawings/drawing${i + 1}.xml"/></Relationships>`],
      [`xl/drawings/drawing${i + 1}.xml`, DRAWING],
      [`xl/drawings/_rels/drawing${i + 1}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/image" Target="../media/faixa.png"/></Relationships>`],
    ]),
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
