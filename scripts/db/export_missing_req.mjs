/**
 * Writes out the payments on one account that still have no request number,
 * as the sheet to type them into.
 *
 * The same file the Export button produces — same columns, same layout, and
 * the same Ledger ID column that matches each line back to its own row — so
 * what comes out of here goes back in through Import in update mode exactly
 * as it would have done.
 *
 * Money coming in is left out. It needs no request number and asking for one
 * would put rows in the sheet that nobody can fill.
 *
 *   LEDGER_DEPS=... EXPORT_BUNDLE=... SEARCH_BUNDLE=... ACCOUNT=... OUT=... \
 *     node scripts/db/export_missing_req.mjs
 */

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { connect, q } from './connect.mjs';

const load = (v, fallback) => import(pathToFileURL(resolve(process.env[v] ?? fallback)).href);
const { buildXlsx } = await load('EXPORT_BUNDLE', 'web/src/lib/export.ts');
const { applyFilters, EMPTY_FILTERS } = await load('SEARCH_BUNDLE', 'web/src/lib/search.ts');

const ACCOUNT = process.env.ACCOUNT ?? 'BANK KSA (SAB 7631)';
/**
 * Narrows the sheet to a stretch of days, so a backlog nobody is going to work
 * through does not come out with the month someone is actually filling in.
 */
const DATE_FROM = process.env.DATE_FROM ?? '';
const DATE_TO = process.env.DATE_TO ?? '';
const OUT = process.env.OUT ?? `${ACCOUNT.replace(/[^\w ()-]/g, '')} - missing req number.xlsx`;

const money = (n) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const client = await connect();
let rows;
let cur;

try {
  const cards = await q(
    client,
    `select id, name, settlement_currency as "settlementCurrency", card_type as "cardType",
            tracks_balance as "tracksBalance", balance_sign as "balanceSign"
       from cards`,
  );
  const card = cards.find((c) => c.name === ACCOUNT);
  if (!card) throw new Error(`no account named ${ACCOUNT}`);
  cur = card.settlementCurrency;

  const transactions = await q(
    client,
    `select id, card_id as "cardId", to_char(txn_date,'YYYY-MM-DD') as txn_date,
            supplier_raw as supplier, amount_aed::float8 as amount_aed, currency,
            original_amount::float8 as original_amount, direction, entry_type, status,
            req_number, payment_ref, invoice, lpo_number, crm, client, account,
            sales_operation, notes, source_sheet, source_row, source_date_raw,
            currency_raw, occurrence
       from transactions where status <> 'voided'`,
  );

  rows = applyFilters(transactions, cards, {
    ...EMPTY_FILTERS,
    cardIds: [card.id],
    dateFrom: DATE_FROM,
    dateTo: DATE_TO,
    missing: 'req_number',
  });

  const period = DATE_FROM || DATE_TO ? ` — ${DATE_FROM || 'the beginning'} to ${DATE_TO || 'today'}` : '';
  const summary = `${rows.length} transactions — ${ACCOUNT}${period} — missing the req number`;
  writeFileSync(OUT, buildXlsx(rows, cards, summary));
} finally {
  await client.end();
}

const total = rows.reduce((t, r) => t + r.amount_aed, 0);
const days = [...new Set(rows.map((r) => r.txn_date))].sort();

console.log(`\n  ${rows.length} payments out with no request number`);
console.log(`  ${money(-total)} ${cur}, from ${days[0]} to ${days[days.length - 1]}`);
console.log(`\n  written to ${OUT}\n`);
console.log('  Type into the Request number column, then bring the file back on the');
console.log('  Import page in update mode. Nothing but that column is read.\n');
