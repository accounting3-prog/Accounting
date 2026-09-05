/**
 * Writes a real .xlsx from a grid, for tests and for trying the import page by
 * hand.
 *
 * It is deliberately written from scratch rather than by calling the app's own
 * exporter: a test fixture built by the code under test proves nothing. It also
 * writes empty cells the way Excel does — as self-closing <c/> elements — which
 * is the case that used to shift every column to the right of a blank.
 *
 * As a script:
 *   node scripts/import/fixture.mjs out.xlsx
 */

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const col = (i) => {
  let s = '';
  let n = i;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
};

/** A stored (uncompressed) zip. fflate and Excel both read it. */
function zipStore(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;

  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  for (const [name, content] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const data = enc.encode(content);
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 0, true); // stored
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    chunks.push(local, data);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + data.length;
  }

  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const all = [...chunks, ...central, end];
  const out = new Uint8Array(all.reduce((s, c) => s + c.length, 0));
  let p = 0;
  for (const c of all) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

/** Builds a one-sheet .xlsx from an array of rows. */
export function makeXlsx(rows, sheetName = 'Sheet1') {
  const body = rows
    .map((row, r) => {
      const cells = (row ?? [])
        .map((v, c) => {
          const ref = `${col(c)}${r + 1}`;
          if (v === '' || v === null || v === undefined) return `<c r="${ref}" s="0"/>`;
          if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
          return `<c r="${ref}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');

  return zipStore({
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`,
  });
}

/**
 * A sheet in the workbook's own shape, awkward on purpose: an empty cell before
 * the amount, a foreign currency, an unknown currency, a refund, a date typed
 * as text, a date that cannot be read, a row with no amount, a repeat charge,
 * and a totals line.
 */
export const AWKWARD_SHEET = [
  ['2026 CARD IMPORT TEST'],
  [],
  ['TRANSACTION DATE', 'DETAILS', 'ORIGINAL CURRENCY', 'DEBIT', 'CREDIT', 'BALANCE', 'CONVERSION', 'REQ NUMBER', 'PAYMENT REFERENCE NUMBER'],
  ['2026-08-03', 'IMPORT SUPPLIER ONE', '', 1200.5, '', '', '', 'IMP-REQ-1', 'IMP-PAY-1'],
  ['2026-08-04', 'IMPORT SUPPLIER TWO', 'USD 300', 1101.75, '', '', 3.6725, 'IMP-REQ-2', 'IMP-PAY-2'],
  ['2026-08-08', 'IMPORT ODD CURRENCY', 'XYZ 500', 75.25, '', '', '', 'IMP-REQ-7', 'IMP-PAY-7'],
  ['2026-08-05', 'IMPORT REFUND', '', '', 450.25, '', '', 'IMP-REQ-3', 'IMP-PAY-3'],
  ['2026-08-06', 'IMPORT SUPPLIER ONE', '', 1200.5, '', '', '', 'IMP-REQ-4', 'IMP-PAY-4'],
  ['not a date', 'IMPORT BROKEN DATE', '', 99, '', '', '', 'IMP-REQ-5', 'IMP-PAY-5'],
  ['2026-08-07', 'IMPORT NO AMOUNT', '', '', '', '', '', 'IMP-REQ-6', 'IMP-PAY-6'],
  [],
  ['', 'Total', '', 3577.99, 450.25],
];

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('fixture.mjs')) {
  const out = process.argv[2];
  if (!out) {
    console.error('usage: node scripts/import/fixture.mjs <out.xlsx>');
    process.exit(2);
  }
  const { writeFileSync } = await import('node:fs');
  writeFileSync(out, makeXlsx(AWKWARD_SHEET, 'August additions'));
  console.log(`wrote ${out}`);
}
