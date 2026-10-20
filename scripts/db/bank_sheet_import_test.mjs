/**
 * The hand-kept bank sheet, uploaded to add its new lines, against the live
 * ledger — and every card sheet in the 2026 workbook, to show nothing about
 * them moved.
 *
 * Two bugs met on the October sheet:
 *
 *   DEBIT was read as money in. Which column lowers a balance came from the
 *   account's recorded convention, the bank accounts have none, and testing
 *   an empty string for the word DEBIT came back false. Every payment on the
 *   sheet would have gone in as money received.
 *
 *   Three incoming transfers the sheet dates 4 October — the bank posted them
 *   on the 1st and 2nd — were not recognised as already in the ledger, and
 *   would have counted 1,167,468.58 twice.
 *
 * So, on the sheet as it was uploaded:
 *   - DEBIT is money out, settled by the sheet's own BALANCE column
 *   - the lines the sheet dates differently are recognised, not added again
 *   - adding what is new lands the ledger exactly on the sheet's last balance
 *   - the request numbers come with the new lines
 *
 * And on every card sheet: the column read as money out is the one it was
 * before this change.
 *
 * Nothing is written.
 *
 *   LEDGER_DEPS=... IMPORT_BUNDLE=... [SHEET=...] [CARDS_BOOK=...] \
 *     node scripts/db/bank_sheet_import_test.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { connect, q } from './connect.mjs';

const { parseXlsx, analyseSheet, buildRows, detectHeaderRow, mapColumns, bindDirectionColumns } =
  await import(pathToFileURL(resolve(process.env.IMPORT_BUNDLE ?? 'web/src/lib/importFile.ts')).href);

const DL = `${process.env.USERPROFILE ?? process.env.HOME}/Downloads`;
const SHEET = process.env.SHEET ?? `${DL}/Book1111.xlsx`;
const CARDS_BOOK = process.env.CARDS_BOOK ?? `${DL}/2026 Cards Monitoring.xlsx`;

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(62)}${detail}`);
};
const n = (v) => {
  const t = String(v ?? '').replace(/[^0-9.-]/g, '');
  return t === '' ? 0 : Number(t);
};
const money = (x) => Number(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const client = await connect();
let cards, existing, ledger;
try {
  cards = await q(
    client,
    `select id, name, settlement_currency as "settlementCurrency", card_type as "cardType",
            tracks_balance as "tracksBalance", balance_sign::int as "balanceSign",
            opening_balance::float8 as "openingBalance",
            coalesce(decreasing_header,'') as "decreasingHeader",
            coalesce(increasing_header,'') as "increasingHeader",
            coalesce(balance_formula,'') as "balanceFormula"
       from cards`,
  );
  const sar = cards.find((c) => c.cardType === 'bank_account' && c.settlementCurrency === 'SAR');
  existing = await q(
    client,
    `select id, card_id as "cardId", to_char(txn_date,'YYYY-MM-DD') txn_date, supplier_raw,
            supplier_raw as supplier, amount_aed::float8 amount_aed, status, req_number
       from transactions where card_id = $1 and status <> 'voided'`,
    [sar.id],
  );
  [ledger] = await q(client, `select ledger_balance::float8 l from card_balances where card_id = $1`, [sar.id]);
} finally {
  await client.end();
}
const sar = cards.find((c) => c.cardType === 'bank_account' && c.settlementCurrency === 'SAR');

console.log('='.repeat(100));
console.log('THE HAND-KEPT BANK SHEET, UPLOADED TO ADD ITS NEW LINES');
console.log('='.repeat(100) + '\n');

if (!existsSync(SHEET)) {
  console.log(`  ${SHEET} is not on this machine — skipped`);
} else {
  const sheet = parseXlsx(new Uint8Array(readFileSync(SHEET)))[0];
  console.log(`  ${SHEET}\n`);
  check('the account has no recorded convention — the case that broke', !sar.decreasingHeader.trim(), '');

  const a = analyseSheet(sheet, sar);
  const header = sheet.rows[a.headerRow];
  check('DEBIT is read as money out', /^debit$/i.test(String(header[a.mapping.decrease]).trim()),
        `money out is "${String(header[a.mapping.decrease]).trim()}"`);
  check('and the screen says what settled it', /BALANCE column settles it/.test(a.directionNote), '');

  const rows = buildRows(sheet, a.headerRow, a.mapping, { card: sar, existing, cardId: sar.id, dayFirst: a.dayFirst });
  const lines = sheet.rows.slice(a.headerRow + 1).filter((r) => String(r[0] ?? '').trim() && (n(r[2]) || n(r[3])));
  const known = rows.filter((r) => r.duplicateOf);
  const fresh = rows.filter((r) => !r.duplicateOf && r.include);
  const shifted = known.filter((r) => r.duplicateOf.date !== r.date);

  check('every line is read, none refused', rows.length === lines.length && rows.every((r) => !r.errors.length),
        `${rows.length} of ${lines.length}`);
  check('each payment is money out, each receipt money in',
        rows.every((r, i) => (n(lines[i][2]) > 0) === (r.kind === 'purchase' || r.kind === 'fee')), '');
  console.log(`\n  ${known.length} already in the ledger (${shifted.length} of them dated differently by the sheet) · ${fresh.length} new\n`);
  for (const r of shifted)
    console.log(`    sheet ${r.date}, bank ${r.duplicateOf.date}  ${money(Math.abs(r.duplicateOf.amount)).padStart(14)}  ${String(r.supplier).replace(/\s+/g, ' ').slice(0, 44)}`);
  console.log('');

  const lastBalance = n(lines[lines.length - 1][4]);
  const after = ledger.l + fresh.reduce((t, r) => t + (r.kind === 'purchase' || r.kind === 'fee' ? -r.amountAed : r.amountAed), 0);
  check('adding what is new lands exactly on the sheet\'s last balance', Math.abs(after - lastBalance) < 0.005,
        `${money(after)} vs ${money(lastBalance)}`);
  const newOut = fresh.filter((r) => r.kind === 'purchase');
  check('the request numbers come with the new payments',
        newOut.every((r) => String(r.reqNumber ?? '').trim()),
        `${newOut.filter((r) => String(r.reqNumber ?? '').trim()).length} of ${newOut.length}`);
}

/* ------------------------------------ every card sheet, before and after */

console.log('\n  the card workbook — the column read as money out, before and after:\n');
if (!existsSync(CARDS_BOOK)) {
  console.log(`  ${CARDS_BOOK} is not on this machine — skipped`);
} else {
  const key = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  let compared = 0;
  for (const sheet of parseXlsx(new Uint8Array(readFileSync(CARDS_BOOK)))) {
    const card = cards.find((c) => key(c.name) === key(sheet.name));
    if (!card) continue;
    compared++;
    const hr = detectHeaderRow(sheet.rows);
    const before = bindDirectionColumns(mapColumns(sheet.rows[hr] ?? []), card).mapping.decrease;
    const after = analyseSheet(sheet, card).mapping.decrease;
    const h = sheet.rows[hr] ?? [];
    check(`${sheet.name}`, before === after, `"${String(h[after] ?? '').trim()}"`);
  }
  check('every card sheet in the workbook was compared', compared >= 7, `${compared}`);
}

console.log('\n' + '='.repeat(100));
if (failures) { console.log(`${failures} CHECK(S) FAILED`); process.exit(1); }
console.log('The bank sheet reads the right way round, nothing is counted twice, and no card sheet moved.');
console.log('='.repeat(100));
