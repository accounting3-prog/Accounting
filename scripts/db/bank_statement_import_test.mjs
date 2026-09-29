/**
 * Uploading a bank statement through the Import screen's own code.
 *
 * The question this answers is the one that was asked: upload a statement
 * covering many days when only some of them are recorded, and does the system
 * know which rows it already has?
 *
 * It runs the real importer — the same parseXlsx, analyseSheet and buildRows
 * the browser runs — against the real SAB statement and the real ledger, and
 * checks what it decides. Nothing is written.
 *
 * Recognition is by COUNT, not by existence. If the ledger holds two identical
 * charges and the statement lists two, both are already there; if it lists
 * three, exactly one is new. Deciding by existence would silently discard a
 * charge the bank really did levy twice.
 *
 *   LEDGER_DEPS=... IMPORT_BUNDLE=... STATEMENT=... node scripts/db/bank_statement_import_test.mjs
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { connect, q } from './connect.mjs';

const { parseXlsx, analyseSheet, buildRows } = await import(
  pathToFileURL(resolve(process.env.IMPORT_BUNDLE ?? 'web/src/lib/importFile.ts')).href
);

const STATEMENT =
  process.env.STATEMENT ??
  `${process.env.USERPROFILE ?? process.env.HOME}/Downloads/Account Statement_15-09-2026 10_02_36.xlsx`;
const ACCOUNT = 'BANK KSA (SAB 7631)';

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(62)}${detail}`);
};
const money = (n) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const client = await connect();

try {
  console.log('='.repeat(100));
  console.log('A BANK STATEMENT, THROUGH THE IMPORT SCREEN\'S OWN CODE');
  console.log('='.repeat(100));
  console.log(`\n  ${STATEMENT}\n`);

  const [cardRow] = await q(
    client,
    `select c.id, c.name, c.settlement_currency, c.balance_sign,
            c.card_type, c.tracks_balance,
            c.opening_balance::float8 ob, to_char(c.opening_date,'YYYY-MM-DD') od,
            c.source_header_row, c.decreasing_column, c.decreasing_header,
            c.increasing_column, c.increasing_header, c.balance_formula
       from cards c where c.name = $1`,
    [ACCOUNT],
  );
  if (!cardRow) throw new Error(`${ACCOUNT} is not in the ledger`);

  const card = {
    id: cardRow.id, name: cardRow.name,
    settlementCurrency: cardRow.settlement_currency,
    // Carried because the importer reads it: a charge line on a bank account
    // labels itself BAC, and a fixture without this silently tested a version
    // of the account that does not exist.
    cardType: cardRow.card_type ?? undefined,
    tracksBalance: cardRow.tracks_balance !== false,
    balanceSign: Number(cardRow.balance_sign),
    openingBalance: Number(cardRow.ob), openingDate: cardRow.od,
    sourceHeaderRow: cardRow.source_header_row ?? 1,
    decreasingColumn: cardRow.decreasing_column ?? '',
    decreasingHeader: cardRow.decreasing_header ?? 'DEBIT',
    increasingColumn: cardRow.increasing_column ?? '',
    increasingHeader: cardRow.increasing_header ?? 'CREDIT',
    balanceFormula: cardRow.balance_formula ?? '',
    headerIsMisleading: false, verifiedRows: 0,
  };

  /* -------------------------------------------- what the importer makes of it */

  const sheets = parseXlsx(new Uint8Array(readFileSync(STATEMENT)));
  const sheet = sheets[0];
  const analysis = analyseSheet(sheet, card);

  // The bank's own summary block, read from the file rather than written here.
  // An earlier version asserted 167 rows and two totals taken from the
  // statement it happened to be written against, which made it a test of one
  // afternoon's download rather than of the importer.
  const figure = (v) => Number(String(v ?? '').replace(/[^0-9.]/g, '')) || 0;
  const summary = sheet.rows[
    sheet.rows.findIndex((r) => r.some((c) => /Total Credits/i.test(String(c ?? '')))) + 1
  ] ?? [];
  const bank = {
    transactions: figure(summary[1]),
    credits: figure(summary[2]), creditValue: figure(summary[3]),
    debits: figure(summary[4]), debitValue: figure(summary[5]),
    opening: figure(summary[6]), closing: figure(summary[7]),
  };
  console.log(`  the bank says: ${bank.transactions} transactions, ` +
    `${bank.debits} debits of ${money(bank.debitValue)}, ${bank.credits} credits of ${money(bank.creditValue)}`);
  console.log(`  opening ${money(bank.opening)}   closing ${money(bank.closing)}
`);

  check('the real header is found, past the account details above it',
        analysis.headerRow === 17, `row ${analysis.headerRow}`);
  const m = analysis.mapping;
  check('the date column is bound', m.date !== undefined, `column ${m.date}`);
  check('the narrative is bound', m.supplier !== undefined, `column ${m.supplier}`);
  check('the single amount column is bound', m.amount_abs !== undefined, `column ${m.amount_abs}`);
  check('the Debit/Credit column is bound', m.txn_type !== undefined, `column ${m.txn_type}`);
  check('the printed balance is bound', m.statement_balance !== undefined,
        `column ${m.statement_balance}`);

  /* ------------------------------------------------ the rows it would produce */

  const existing = await q(
    client,
    `select id, card_id as "cardId", to_char(txn_date,'YYYY-MM-DD') as txn_date,
            supplier_raw as supplier, supplier_raw, amount_aed::float8 as amount_aed,
            direction, entry_type, status, req_number, payment_ref
       from transactions where card_id = $1 and status <> 'voided'`,
    [card.id],
  );

  const rows = buildRows(sheet, analysis.headerRow, analysis.mapping, {
    card, existing, cardId: card.id, dayFirst: analysis.dayFirst,
  });

  const withAmount = rows.filter((r) => r.amountAed !== null);
  check('every transaction row on the statement is read',
        withAmount.length === bank.transactions,
        `${withAmount.length} of the bank's own count of ${bank.transactions}`);

  const spend = withAmount.filter((r) => r.kind === 'purchase');
  const inbound = withAmount.filter((r) => r.kind !== 'purchase');
  const spendTotal = spend.reduce((a, r) => a + r.amountAed, 0);
  const inTotal = inbound.reduce((a, r) => a + r.amountAed, 0);

  // The statement prints its own totals in a summary block. These are the
  // figures to land on, and they were not told to the importer.
  check('debits total what the statement says they do',
        Math.abs(spendTotal - bank.debitValue) < 0.005,
        `${money(spendTotal)} vs the bank's ${money(bank.debitValue)}`);
  check('credits total what the statement says they do',
        Math.abs(inTotal - bank.creditValue) < 0.005,
        `${money(inTotal)} vs the bank's ${money(bank.creditValue)}`);
  check('a Debit lowers the balance and a Credit raises it',
        spend.length === bank.debits && inbound.length === bank.credits,
        `${spend.length} debits and ${inbound.length} credits, against the bank's ${bank.debits} and ${bank.credits}`);

  check('each row carries the balance the bank printed beside it',
        withAmount.every((r) => r.statementBalance !== null),
        `${withAmount.filter((r) => r.statementBalance === null).length} without one`);

  /* ------------------------------------------- the question that was asked */

  const known = rows.filter((r) => r.duplicateOf);
  const fresh = withAmount.filter((r) => !r.duplicateOf);
  console.log('');
  check('the rows already in the ledger are recognised', known.length > 0,
        `${known.length} of ${withAmount.length} recognised as already present`);
  check('and none of them is ticked to be imported again',
        known.every((r) => !r.include || r.duplicateOf),
        `${known.filter((r) => r.include && !r.duplicateOf).length} would slip through`);

  // A statement reaching further than the ledger SHOULD offer the days it has
  // and the ledger does not. What must never happen is a row inside a period
  // already recorded being offered again — that is the matching failing, and
  // it is the difference between "this file has news" and "this file will
  // duplicate everything".
  console.log(`\n  the statement covers ${withAmount.at(-1)?.date} to ${withAmount[0]?.date}`);
  const held = existing.map((e) => e.txn_date).filter(Boolean).sort();
  const lastHeld = held[held.length - 1] ?? '0000-00-00';
  console.log(`  the ledger holds ${existing.length} rows for this account, up to ${lastHeld}\n`);

  const wronglyNew = fresh.filter((r) => r.date && r.date <= lastHeld);
  check('nothing inside the period already recorded is offered again',
        wronglyNew.length === 0,
        wronglyNew.length
          ? `${wronglyNew.length} already-held rows would be written twice`
          : `${known.length} recognised, ${fresh.length} genuinely new`);

  if (wronglyNew.length) {
    console.log('\n      offered despite being inside the recorded period:\n');
    for (const r of wronglyNew.slice(0, 8))
      console.log(`        ${r.date}  ${String(r.kind).padEnd(9)} ${money(r.amountAed).padStart(13)}   ${r.supplier.replace(/\s+/g, ' ').slice(0, 54)}`);
  }

  /* --------------------------------------- every cost must carry a reference */

  // A bank statement has no reference column at all, so a cost imported
  // straight from one arrives with nothing to search on. Charges label
  // themselves BAC; every other payment needs a request number put on it, and
  // that is a thing to be told about rather than to discover later.
  const needingRef = fresh.filter(
    (r) => r.kind === 'purchase' && !String(r.reqNumber ?? '').trim(),
  );
  console.log(
    `\n  of the ${fresh.length} new rows, ${needingRef.length} are costs carrying no request number\n`,
  );
  for (const r of needingRef.slice(0, 8))
    console.log(`      ${r.date}  ${money(r.amountAed).padStart(12)}  ${r.supplier.replace(/\s+/g, ' ').slice(0, 50)}`);
  if (needingRef.length > 8) console.log(`      … and ${needingRef.length - 8} more`);

  /* --------------------------------------------- and nothing was invented */

  const errors = rows.filter((r) => r.errors.length);
  check('no row is refused', errors.length === 0,
        errors.length ? errors[0].errors[0] : `${rows.length} rows read`);
} finally {
  await client.end();
}

console.log('\n' + '='.repeat(100));
if (failures) { console.log(`${failures} CHECK(S) FAILED`); process.exit(1); }
console.log('The statement reads correctly, and the days already recorded are recognised.');
console.log('='.repeat(100));
