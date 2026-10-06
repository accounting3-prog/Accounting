/**
 * The NBD payments sheet, filled in and brought back through the Import
 * screen's own code, against the live account.
 *
 * The bug this covers: the app hands out a blank payments sheet for NBD, and a
 * sheet filled in from it came back reading nothing. The importer had never
 * been taught the sheet's headings — only the date column was found, and that
 * by reading the dates rather than the heading — so every amount, name and
 * reference was "not in this file" and no row survived.
 *
 * Checked here, on the file as it was filled in:
 *   - every heading the blank sheet writes is mapped to the right field
 *   - every payment is read, with its beneficiary, currency, amount, cost in
 *     dirhams and request number, none refused
 *   - payments already in the ledger are recognised, not written again
 *   - a row settled in a currency other than the account's is refused
 *
 * Nothing is written.
 *
 *   LEDGER_DEPS=... IMPORT_BUNDLE=... EXPORT_BUNDLE=... FILE=... \
 *     node scripts/db/payments_sheet_test.mjs
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { connect, q } from './connect.mjs';

const load = (v) => import(pathToFileURL(resolve(process.env[v])).href);
const { parseXlsx, analyseSheet, buildRows } = await load('IMPORT_BUNDLE');
const { paymentTemplateColumns } = await load('EXPORT_BUNDLE');

const FILE =
  process.env.FILE ??
  `${process.env.USERPROFILE ?? process.env.HOME}/Downloads/NBD (payments) — blank sheet (1).xlsx`;
const ACCOUNT = process.env.ACCOUNT ?? 'NBD (payments)';

const money = (n) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(60)}${detail}`);
};

const client = await connect();
let cardRow, existing;
try {
  [cardRow] = await q(
    client,
    `select id, name, settlement_currency, balance_sign, card_type, tracks_balance,
            opening_balance::float8 ob, to_char(opening_date,'YYYY-MM-DD') od
       from cards where name = $1`,
    [ACCOUNT],
  );
  existing = await q(
    client,
    `select id, card_id as "cardId", to_char(txn_date,'YYYY-MM-DD') as txn_date,
            supplier_raw as supplier, supplier_raw, amount_aed::float8 as amount_aed,
            direction, entry_type, status, req_number, payment_ref
       from transactions where card_id = $1 and status <> 'voided'`,
    [cardRow.id],
  );
} finally {
  await client.end();
}

const card = {
  id: cardRow.id, name: cardRow.name,
  settlementCurrency: cardRow.settlement_currency,
  cardType: cardRow.card_type ?? undefined,
  tracksBalance: cardRow.tracks_balance !== false,
  balanceSign: Number(cardRow.balance_sign),
  openingBalance: Number(cardRow.ob), openingDate: cardRow.od,
  sourceHeaderRow: 1, decreasingColumn: '', decreasingHeader: 'DEBIT',
  increasingColumn: '', increasingHeader: 'CREDIT', balanceFormula: '',
  headerIsMisleading: false, verifiedRows: 0,
};

console.log('='.repeat(100));
console.log(`THE PAYMENTS SHEET, FILLED IN, BACK THROUGH THE IMPORT SCREEN — ${card.name}`);
console.log('='.repeat(100));
console.log(`\n  ${FILE}\n`);

const sheet = parseXlsx(new Uint8Array(readFileSync(FILE)))[0];
const analysis = analyseSheet(sheet, card);
const header = sheet.rows[analysis.headerRow] ?? [];

/* ---------------------------------------- every heading the sheet writes */

const expected = {
  'Payment Date': 'date',
  'Beneficiary Name': 'supplier',
  'Payment Currency': 'currency',
  'Payment Amount': 'original_amount',
  'Customer Reference': 'req_number',
  'Local Currency': 'settlement_currency',
  'Amount in Local Currency': 'decrease',
};
check('the blank sheet\'s headings are the ones checked here',
      paymentTemplateColumns().map((c) => c.header).join('|') === Object.keys(expected).join('|'), '');
for (const [heading, field] of Object.entries(expected)) {
  const col = header.findIndex((h) => String(h ?? '').trim() === heading);
  check(`"${heading}" is read as ${field}`, col >= 0 && analysis.mapping[field] === col,
        col < 0 ? 'not in the file' : analysis.mapping[field] === undefined ? 'not mapped' : '');
}
check('the date is found by its heading, not by guessing from the values',
      !analysis.dateFoundByContent, '');

/* ------------------------------------------------------- every payment */

const rows = buildRows(sheet, analysis.headerRow, analysis.mapping, {
  card, existing, cardId: card.id, dayFirst: analysis.dayFirst,
}).filter((r) => r.amountAed !== null || r.errors.length);

const lines = sheet.rows.slice(analysis.headerRow + 1).filter((r) => String(r[0] ?? '').trim());
const refused = rows.filter((r) => r.errors.length);
const known = rows.filter((r) => r.duplicateOf);
const fresh = rows.filter((r) => !r.duplicateOf && r.include && !r.errors.length);

console.log('');
check('every payment line is read', rows.length === lines.length, `${rows.length} of ${lines.length}`);
check('none is refused', refused.length === 0, refused[0] ? `row ${refused[0].sourceRow}: ${refused[0].errors[0]}` : '');
// The importer keeps the amount unsigned and the kind says which way it
// went; create_transaction applies the sign from the kind when it writes.
check('every one is a payment out', rows.every((r) => r.kind === 'purchase' && r.amountAed > 0), '');
check('every one carries its beneficiary', rows.every((r) => String(r.supplier ?? '').trim()), '');
check('every one carries a request number', rows.every((r) => String(r.reqNumber ?? '').trim()),
      `${rows.filter((r) => !String(r.reqNumber ?? '').trim()).length} without`);

// The figures, against the file read independently of the importer.
const col = (h) => header.findIndex((x) => String(x ?? '').trim() === h);
const fileAed = lines.reduce((t, r) => t + Number(String(r[col('Amount in Local Currency')]).replace(/[^0-9.]/g, '')), 0);
const readAed = rows.reduce((t, r) => t + r.amountAed, 0);
check('the dirham costs add up to the file\'s', Math.abs(fileAed - readAed) < 0.005,
      `${money(readAed)} vs ${money(fileAed)} ${card.settlementCurrency}`);
// A payment in a foreign currency keeps that currency and its amount. One
// paid in the account's own currency has no separate original — the same way
// the 28 dirham payments already on this account are stored.
const sameCurrency = rows.every((r, i) => {
  const paidIn = String(lines[i][col('Payment Currency')] ?? '').trim().toUpperCase();
  return paidIn === card.settlementCurrency ? !r.currency : r.currency === paidIn;
});
check('each keeps the currency it was paid in', sameCurrency, '');

console.log(`\n  ${rows.length} payments · ${known.length} already in the ledger · ${fresh.length} new\n`);
for (const r of known)
  console.log(`    already in: ${r.date}  ${money(r.amountAed).padStart(12)} AED  ${String(r.supplier).slice(0, 40)}`);
for (const r of fresh.slice(0, 12))
  console.log(`    ${r.date}  ${String(r.currency || card.settlementCurrency).padEnd(4)} ${money(r.originalAmount ?? r.amountAed).padStart(13)}  = ${money(r.amountAed).padStart(12)} AED  ${String(r.reqNumber ?? '').padEnd(20)} ${String(r.supplier).slice(0, 34)}`);
if (fresh.length > 12) console.log(`    … and ${fresh.length - 12} more`);

/* ----------------------- a row in another currency must not get through */

const tampered = { ...sheet, rows: sheet.rows.map((r) => r.slice()) };
const first = analysis.headerRow + 1;
tampered.rows[first][col('Local Currency')] = 'SAR';
const tAnalysis = analyseSheet(tampered, card);
const tRows = buildRows(tampered, tAnalysis.headerRow, tAnalysis.mapping, {
  card, existing, cardId: card.id, dayFirst: tAnalysis.dayFirst,
});
const bad = tRows.find((r) => r.sourceRow === first + 1);
console.log('');
check('a row settled in SAR on a dirham account is refused',
      Boolean(bad && bad.errors.some((e) => /settled in SAR/.test(e))),
      bad?.errors[0] ?? 'row not found');

console.log('\n' + '='.repeat(100));
if (failures) { console.log(`${failures} CHECK(S) FAILED`); process.exit(1); }
console.log('The payments sheet comes back in whole.');
console.log('='.repeat(100));
