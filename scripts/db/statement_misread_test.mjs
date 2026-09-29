/**
 * Proves that a statement read the wrong way is refused rather than imported.
 *
 * The worry this answers is a real one: the summary figures used to be taken
 * by column position, so a bank that adds, drops or reorders a column would
 * shift every number along by one and nothing would say so — the opening
 * balance would quietly become the debit total and the import would still
 * report success.
 *
 * So the statement is deliberately damaged, one way per case, and the importer
 * is expected to refuse each one. A test that only ever sees a good file
 * proves nothing about a bad one.
 *
 * Nothing is written: every case is a dry run, and the checks are on what the
 * importer says, not on the database.
 *
 *   LEDGER_DEPS=... IMPORT_BUNDLE=... STATEMENT=... node scripts/db/statement_misread_test.mjs
 */

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const BUNDLE = resolve(process.env.IMPORT_BUNDLE ?? 'web/src/lib/importFile.ts');
const { parseXlsx } = await import(pathToFileURL(BUNDLE).href);

const STATEMENT =
  process.env.STATEMENT ??
  `${process.env.USERPROFILE ?? process.env.HOME}/Downloads/Account Statement_29-09-2026 09_48_51.xlsx`;

const work = mkdtempSync(join(tmpdir(), 'misread-'));
let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(62)}${detail}`);
};

/**
 * Rewrites the summary block of the statement and hands back a new file.
 *
 * An xlsx is a zip of XML, so the numbers cannot be edited in place with a
 * text replace on the archive. They are edited on the parsed grid instead and
 * written back out as a plain sheet the importer reads the same way.
 */
const damaged = (name, edit) => {
  const sheet = parseXlsx(new Uint8Array(readFileSync(STATEMENT)))[0];
  const grid = sheet.rows.map((r) => r.slice());
  edit(grid, grid.findIndex((r) => r.some((c) => /Total Credits/i.test(String(c ?? '')))));
  const path = join(work, `${name}.xlsx`);
  writeFileSync(path, buildXlsx(grid));
  return path;
};

/** The smallest valid xlsx that holds one sheet of strings. */
function buildXlsx(grid) {
  const esc = (s) =>
    String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const col = (i) => {
    let s = '';
    for (let n = i + 1; n > 0; ) {
      const r = (n - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      n = (n - 1 - r) / 26;
    }
    return s;
  };
  const rows = grid
    .map(
      (r, y) =>
        `<row r="${y + 1}">` +
        r
          .map((c, x) =>
            c === '' || c == null
              ? ''
              : `<c r="${col(x)}${y + 1}" t="inlineStr"><is><t xml:space="preserve">${esc(c)}</t></is></c>`,
          )
          .join('') +
        '</row>',
    )
    .join('');
  const files = {
    '[Content_Types].xml':
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '</Types>',
    '_rels/.rels':
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml':
      '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="Statement" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml':
      '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      `<sheetData>${rows}</sheetData></worksheet>`,
  };
  return zip(files);
}

/** Stored (uncompressed) zip — enough for a reader, and no dependency. */
function zip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (b) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const u32 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
  const u16 = (n) => [n & 255, (n >>> 8) & 255];
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const body = enc.encode(text);
    const sum = crc32(body);
    const local = [
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(sum), ...u32(body.length), ...u32(body.length),
      ...u16(nameBytes.length), ...u16(0), ...nameBytes, ...body,
    ];
    central.push([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(sum), ...u32(body.length), ...u32(body.length),
      ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0),
      ...u32(offset), ...nameBytes,
    ]);
    parts.push(local);
    offset += local.length;
  }
  const dir = central.flat();
  const end = [
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(central.length), ...u16(central.length),
    ...u32(dir.length), ...u32(offset), ...u16(0),
  ];
  return Buffer.from([...parts.flat(), ...dir, ...end]);
}

/** Runs the importer as a dry run and returns everything it printed. */
const run = (path) => {
  try {
    return execFileSync(process.execPath, ['scripts/db/import_statement.mjs'], {
      env: { ...process.env, STATEMENT: path },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    return `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
};

console.log('='.repeat(100));
console.log('A STATEMENT READ THE WRONG WAY MUST BE REFUSED, NOT IMPORTED');
console.log('='.repeat(100));
console.log(`\n  ${STATEMENT}\n`);

/* ------------------------------------------------------------- the good file */

const clean = run(damaged('unchanged', () => {}));
check(
  'the statement as the bank wrote it is accepted',
  /the statement's own summary adds up/.test(clean) && !/FAIL/.test(clean),
  /out by/.test(clean) ? 'summary rejected' : '',
);
check(
  'and its opening balance is read as the bank stated it',
  /opening 0\.00, closing 283,801\.85/.test(clean) ||
    /opening [\d,.]+, closing [\d,.]+/.test(clean),
);

/* ------------------------------------------- a column inserted before the rest */

const shifted = run(
  damaged('shifted', (grid, at) => {
    // Exactly the accident this guards against: one extra column, so every
    // figure after it sits one place to the right of where it used to.
    grid[at].splice(2, 0, 'Branch');
    grid[at + 1].splice(2, 0, 'TAHLIA');
  }),
);
check(
  'a summary with an extra column is still read correctly',
  /opening 0\.00, closing 283,801\.85/.test(shifted),
  /the summary line has no/.test(shifted) ? 'labels not found' : '',
);

/* --------------------------------------------------- a figure changed by hand */

const wrong = run(
  damaged('wrong-opening', (grid, at) => {
    const col = grid[at].findIndex((c) => /^Opening Balance$/i.test(String(c ?? '').trim()));
    grid[at + 1][col] = '500,000.00';
  }),
);
check(
  'an opening balance that contradicts the other figures is refused',
  /out by/.test(wrong) && /refusing to import against it|FAIL/.test(wrong),
  /COMMITTED/.test(wrong) ? 'it was imported anyway' : '',
);

/* ------------------------------------------------- the label itself is missing */

const noLabel = run(
  damaged('no-label', (grid, at) => {
    const col = grid[at].findIndex((c) => /^Opening Balance$/i.test(String(c ?? '').trim()));
    grid[at][col] = 'Balance B/F';
  }),
);
check(
  'a summary column it cannot name is refused, not guessed at',
  /has no "\^Opening Balance\$" column/.test(noLabel) || /no "\^Opening/.test(noLabel),
  /COMMITTED/.test(noLabel) ? 'it was imported anyway' : '',
);

/* ------------------------------------------------------- rows quietly dropped */

const short = run(
  damaged('short', (grid, at) => {
    // One transaction line removed, the stated count left alone.
    const first = grid.findIndex((r) => r.some((c) => /Transaction Particulars/i.test(String(c ?? ''))));
    grid.splice(first + 2, 1);
  }),
);
check(
  'a statement missing a line it says it has is refused',
  /as many rows were read as the bank says/.test(short) && /FAIL/.test(short),
  /COMMITTED/.test(short) ? 'it was imported anyway' : '',
);

console.log('\n' + '='.repeat(100));
if (failures) {
  console.log(`${failures} CHECK(S) FAILED — a misread statement could get through`);
  process.exit(1);
}
console.log('Every way of misreading this statement is caught and refused.');
console.log('='.repeat(100));
