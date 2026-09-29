/**
 * Answers one question with arithmetic instead of opinion:
 *
 *   The euro account can be set up two ways, and both show the right balance
 *   today. Does either of them go wrong the next time a statement is uploaded?
 *
 *     (a) the account opens at 0.00 and the 500,000 arrival is a row, exactly
 *         as the bank wrote it
 *     (b) the account opens at 500,000 and that row is not held at all
 *
 * The next statement will cover the same days again — that is what uploading
 * daily means — so it will offer the 24 September arrival a second time. What
 * matters is whether the ledger recognises it. In (a) it is there to be
 * recognised. In (b) it is not.
 *
 * Nothing is written and nothing is rolled back, because nothing is changed:
 * (b) is simulated by hiding that one row from the importer, which is the only
 * thing the importer's decision depends on.
 *
 *   LEDGER_DEPS=... IMPORT_BUNDLE=... STATEMENT=... ACCOUNT=... \
 *     node scripts/db/opening_balance_choice_test.mjs
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
  `${process.env.USERPROFILE ?? process.env.HOME}/Downloads/Account Statement_29-09-2026 09_48_51.xlsx`;
const ACCOUNT = process.env.ACCOUNT ?? 'BANK KSA EUR (SAB 1081)';

const money = (n) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(56)}${detail}`);
};

const client = await connect();

try {
  const [cardRow] = await q(
    client,
    `select c.id, c.name, c.settlement_currency, c.balance_sign, c.card_type,
            c.tracks_balance, c.opening_balance::float8 ob,
            to_char(c.opening_date,'YYYY-MM-DD') od,
            c.source_header_row, c.decreasing_column, c.decreasing_header,
            c.increasing_column, c.increasing_header, c.balance_formula
       from cards c where c.name = $1`,
    [ACCOUNT],
  );
  if (!cardRow) throw new Error(`no account named ${ACCOUNT}`);

  const card = {
    id: cardRow.id, name: cardRow.name,
    settlementCurrency: cardRow.settlement_currency,
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
  const cur = card.settlementCurrency;

  const held = await q(
    client,
    `select id, card_id as "cardId", to_char(txn_date,'YYYY-MM-DD') as txn_date,
            supplier_raw as supplier, supplier_raw, amount_aed::float8 as amount_aed,
            direction, entry_type, status, req_number, payment_ref
       from transactions where card_id = $1 and status <> 'voided'`,
    [card.id],
  );

  // The money that opened the account: the one arrival, the largest credit.
  const funding = held
    .filter((r) => r.amount_aed > 0)
    .sort((a, b) => b.amount_aed - a.amount_aed)[0];
  if (!funding) throw new Error('this account holds no incoming row to reason about');

  const sheet = parseXlsx(new Uint8Array(readFileSync(STATEMENT)))[0];
  const analysis = analyseSheet(sheet, card);

  console.log('='.repeat(100));
  console.log(`TWO WAYS TO OPEN ${card.name}`);
  console.log('='.repeat(100));
  console.log(`\n  the arrival in question: ${funding.txn_date}  ${money(funding.amount_aed)} ${cur}`);
  console.log(`  ${funding.supplier_raw.replace(/\s+/g, ' ').slice(0, 72)}\n`);
  console.log(`  the statement being uploaded again: ${STATEMENT.split(/[\\/]/).pop()}\n`);

  /**
   * What happens when that statement is uploaded, given what the ledger holds
   * and what it opened at.
   */
  const upload = (opening, existing) => {
    const rows = buildRows(sheet, analysis.headerRow, analysis.mapping, {
      card: { ...card, openingBalance: opening },
      existing, cardId: card.id, dayFirst: analysis.dayFirst,
    }).filter((r) => r.amountAed !== null);
    const fresh = rows.filter((r) => !r.duplicateOf && r.include);
    const now = existing.reduce((t, r) => t + r.amount_aed, opening);
    return { fresh, before: now, after: fresh.reduce((t, r) => t + r.amountAed, now) };
  };

  const a = upload(card.openingBalance, held);
  const b = upload(
    funding.amount_aed,
    held.filter((r) => r.id !== funding.id),
  );

  const truth = a.before; // the balance the bank printed, already checked elsewhere

  for (const [name, how, state] of [
    ['(a)', `opens at ${money(card.openingBalance)} ${cur}, the arrival is a row`, a],
    ['(b)', `opens at ${money(funding.amount_aed)} ${cur}, the arrival is not held`, b],
  ]) {
    console.log('-'.repeat(100));
    console.log(`${name}  ${how}`);
    console.log('-'.repeat(100));
    console.log(`  balance today                      ${money(state.before).padStart(16)} ${cur}`);
    console.log(`  rows the next upload would add     ${String(state.fresh.length).padStart(16)}`);
    for (const r of state.fresh.slice(0, 4))
      console.log(`      ${r.date}  ${money(r.amountAed).padStart(14)}  ${r.supplier.replace(/\s+/g, ' ').slice(0, 44)}`);
    console.log(`  balance after that upload          ${money(state.after).padStart(16)} ${cur}`);
    console.log('');
  }

  check('both ways show the same balance today', Math.abs(a.before - b.before) < 0.005,
        `${money(a.before)} and ${money(b.before)} ${cur}`);

  console.log('');
  check('(a) survives the next upload unchanged',
        a.fresh.length === 0 && Math.abs(a.after - truth) < 0.005,
        `${a.fresh.length} rows added, balance ${money(a.after)} ${cur}`);
  check('(b) survives the next upload unchanged',
        b.fresh.length === 0 && Math.abs(b.after - truth) < 0.005,
        `${b.fresh.length} rows added, balance ${money(b.after)} ${cur}`);
} finally {
  await client.end();
}

console.log('\n' + '='.repeat(100));
console.log(
  failures
    ? `${failures} CHECK(S) FAILED — one of the two ways does not survive a second upload`
    : 'Both ways survive a second upload.',
);
console.log('='.repeat(100));
