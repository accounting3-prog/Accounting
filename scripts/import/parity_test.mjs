/**
 * Reads the real workbook with the browser importer and compares every row it
 * finds against what the Python extractor found in the same file.
 *
 * The two share no code. extract.py uses openpyxl and derives direction from
 * each sheet's balance formula; importFile.ts unzips the xlsx by hand in the
 * browser and derives direction from the card's recorded convention. If both
 * arrive at the same date, amount and direction for 1,900-odd rows across seven
 * differently-laid-out sheets, the importer can be trusted with a file the user
 * uploads.
 *
 *   node scripts/import/parity_test.mjs "<path to 2026 Cards Monitoring.xlsx>"
 *
 * Set IMPORT_BUNDLE to a prebuilt bundle of web/src/lib/importFile.ts when the
 * web workspace has no node_modules:
 *
 *   esbuild web/src/lib/importFile.ts --bundle --format=esm --platform=node \
 *     --outfile=/tmp/importFile.mjs
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const workbookPath = process.argv[2];
if (!workbookPath) {
  console.error('usage: node scripts/import/parity_test.mjs <workbook.xlsx>');
  process.exit(2);
}

const modulePath = process.env.IMPORT_BUNDLE
  ? resolve(process.env.IMPORT_BUNDLE)
  : resolve('web/src/lib/importFile.ts');
const imp = await import(pathToFileURL(modulePath).href);
const { parseXlsx, analyseSheet, buildRows } = imp;

const expected = JSON.parse(readFileSync('scripts/out/normalised.json', 'utf8'));

/**
 * Two sheets were typed as DD/MM and read by Excel as M/D, and the extractor
 * transposes them back using evidence from outside the cell. A file being
 * uploaded carries no such evidence, so the importer reads the date Excel
 * actually stored. Those two sheets are compared on amount and direction only,
 * and the date difference is reported rather than counted as agreement.
 */
const DATE_TRANSPOSED = new Set(['MASTERCARD 5135 (4173) (7206)', 'RAK 9825 (6071)']);

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const sheets = parseXlsx(new Uint8Array(readFileSync(workbookPath)));
check('the importer opens the real workbook', sheets.length > 0, `${sheets.length} sheets`);
check(
  'it finds the same sheets the extractor did',
  expected.every((c) => sheets.some((s) => s.name === c.card)),
  sheets.map((s) => s.name).join(' | '),
);

let totalCompared = 0;
let totalDateMismatch = 0;

for (const card of expected) {
  const sheet = sheets.find((s) => s.name === card.card);
  if (!sheet) continue;

  // The card record, as the app holds it.
  const cardRecord = {
    name: card.card,
    decreasingHeader: card.decreasing_header,
    increasingHeader: card.increasing_header,
    balanceFormula: card.balance_formula_sample,
  };
  const analysis = analyseSheet(sheet, cardRecord);
  const { headerRow, headers, mapping, dayFirst } = analysis;

  check(
    `${card.card}: header row found where the extractor found it`,
    headerRow === card.header_row - 1,
    `importer row ${headerRow + 1}, extractor row ${card.header_row}`,
  );
  if (headerRow < 0) continue;

  const letter = (i) => String.fromCharCode(65 + i);
  check(
    `${card.card}: the decreasing column is the one the balance formula subtracts`,
    mapping.decrease !== undefined && letter(mapping.decrease) === card.decreasing_column,
    `importer ${mapping.decrease === undefined ? 'none' : letter(mapping.decrease)}, formula ${card.decreasing_column}`,
  );
  check(
    `${card.card}: the increasing column matches too`,
    mapping.increase !== undefined && letter(mapping.increase) === card.increasing_column,
    `importer ${mapping.increase === undefined ? 'none' : letter(mapping.increase)}, formula ${card.increasing_column}`,
  );
  check(
    `${card.card}: the date column was recognised`,
    mapping.date !== undefined,
    mapping.date === undefined
      ? headers.join(' | ')
      : letter(mapping.date) + (analysis.dateFoundByContent ? ' (found by its contents; the header is blank)' : ''),
  );

  const rows = buildRows(sheet, headerRow, mapping, { dayFirst });

  // The extractor's rows, keyed by their source row number.
  const byRow = new Map(
    card.transactions
      .filter((t) => t.entry_type === 'source_transaction')
      .map((t) => [t.source_row, t]),
  );

  let matchedAmount = 0;
  let matchedDirection = 0;
  let matchedDate = 0;
  let compared = 0;
  const amountMismatches = [];
  const directionMismatches = [];
  const dateMismatches = [];

  for (const row of rows) {
    const want = byRow.get(row.sourceRow);
    if (!want) continue;
    compared++;

    const wantAmount = Math.abs(want.amount_aed);
    const gotAmount = row.amountAed === null ? NaN : Math.abs(row.amountAed);
    if (Math.abs(wantAmount - gotAmount) < 0.005) matchedAmount++;
    else if (amountMismatches.length < 3)
      amountMismatches.push(`row ${row.sourceRow}: ${gotAmount} vs ${wantAmount}`);

    const gotDirection = row.kind === 'purchase' || row.kind === 'fee' ? 'spend' : 'funding';
    if (gotDirection === want.direction) matchedDirection++;
    else if (directionMismatches.length < 3)
      directionMismatches.push(`row ${row.sourceRow}: ${gotDirection} vs ${want.direction}`);

    if (row.date === want.txn_date) matchedDate++;
    else if (dateMismatches.length < 3)
      dateMismatches.push(`row ${row.sourceRow}: ${row.date} vs ${want.txn_date} (raw "${row.dateRaw}")`);
  }

  totalCompared += compared;

  check(
    `${card.card}: reads every transaction the extractor found`,
    compared === byRow.size,
    `${compared} of ${byRow.size}`,
  );
  check(
    `${card.card}: every AED amount agrees`,
    matchedAmount === compared,
    amountMismatches.join('; '),
  );
  check(
    `${card.card}: every direction agrees`,
    matchedDirection === compared,
    directionMismatches.join('; '),
  );

  if (DATE_TRANSPOSED.has(card.card)) {
    totalDateMismatch += compared - matchedDate;
    console.log(
      `NOTE  ${card.card}: ${compared - matchedDate} of ${compared} dates differ, as expected — ` +
        `this sheet was typed day-first and stored month-first, and only the extractor has the evidence to transpose it. ` +
        `Example ${dateMismatches[0] ?? 'none'}`,
    );
  } else {
    check(
      `${card.card}: every date agrees`,
      matchedDate === compared,
      dateMismatches.join('; '),
    );
  }
}

check('a meaningful number of rows was compared', totalCompared > 1500, String(totalCompared));

console.log(`\n${totalCompared} rows compared.`);
if (totalDateMismatch)
  console.log(`${totalDateMismatch} dates differ only on the two known transposed sheets.`);
if (failures) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log('All checks passed.');
