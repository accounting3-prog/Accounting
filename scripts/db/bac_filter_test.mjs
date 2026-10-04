/**
 * The BAC filter on the Transactions screen, run over the real ledger.
 *
 * Checked against the database rather than against the filter's own rule:
 * "only" must return exactly the rows whose request number is BAC in any
 * spelling, "hide" must return exactly the rest, and the two together must be
 * every row — nothing counted twice, nothing dropped between them.
 *
 * The spelling matters. The ledger holds BAC, bac and Bac. A filter that
 * matched only the capitals would look right and leave out four rows in ten.
 *
 *   LEDGER_DEPS=... SEARCH_BUNDLE=... node scripts/db/bac_filter_test.mjs
 */

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { connect, q } from './connect.mjs';

const { applyFilters, EMPTY_FILTERS, isFiltered } = await import(
  pathToFileURL(resolve(process.env.SEARCH_BUNDLE ?? 'web/src/lib/search.ts')).href
);

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(56)}${detail}`);
};
const money = (n) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const client = await connect();
let cards, transactions, spellings, expected;
try {
  cards = await q(client, `select id, name, settlement_currency as "settlementCurrency" from cards`);
  transactions = await q(
    client,
    `select id, card_id as "cardId", to_char(txn_date,'YYYY-MM-DD') txn_date,
            supplier_raw as supplier, supplier_raw, amount_aed::float8 amount_aed,
            status, req_number, source_sheet
       from transactions where status <> 'voided'`,
  );
  spellings = await q(
    client,
    `select req_number, count(*)::int n from transactions
      where status <> 'voided' and upper(btrim(req_number)) = 'BAC' group by 1 order by 2 desc`,
  );
  [expected] = await q(
    client,
    `select count(*)::int n, sum(amount_aed)::float8 total from transactions
      where status <> 'voided' and upper(btrim(req_number)) = 'BAC'`,
  );
} finally {
  await client.end();
}

console.log('='.repeat(100));
console.log('FILTERING BY BANK CHARGES (BAC)');
console.log('='.repeat(100) + '\n');
console.log(`  spelled in the ledger as: ${spellings.map((s) => `"${s.req_number}" ${s.n}`).join(', ')}\n`);

const only = applyFilters(transactions, cards, { ...EMPTY_FILTERS, bac: 'only' });
const hide = applyFilters(transactions, cards, { ...EMPTY_FILTERS, bac: 'hide' });

check('"Only BAC" returns every BAC row, in any spelling', only.length === expected.n,
      `${only.length} of ${expected.n}`);
check('and nothing that is not one',
      only.every((t) => String(t.req_number ?? '').trim().toUpperCase() === 'BAC'), '');
check('"Hide BAC" returns everything else',
      hide.length === transactions.length - expected.n,
      `${hide.length} of ${transactions.length - expected.n}`);
check('and no BAC row slips through',
      hide.every((t) => String(t.req_number ?? '').trim().toUpperCase() !== 'BAC'), '');
check('the two together are every row, once each',
      only.length + hide.length === transactions.length &&
        new Set([...only, ...hide].map((t) => t.id)).size === transactions.length, '');
check('the filter counts as narrowing the view', isFiltered({ ...EMPTY_FILTERS, bac: 'only' }), '');

// What the screen will show as the total, per account and never across
// currencies.
const byCard = new Map();
for (const t of only) {
  const c = cards.find((x) => x.id === t.cardId);
  const b = byCard.get(c.name) ?? { n: 0, total: 0, cur: c.settlementCurrency };
  b.n++; b.total += t.amount_aed;
  byCard.set(c.name, b);
}
console.log('\n  what the bank charged, per account:\n');
for (const [name, b] of byCard)
  console.log(`    ${name.padEnd(26)} ${String(b.n).padStart(4)} charges   ${money(-b.total).padStart(10)} ${b.cur}`);

console.log('\n' + '='.repeat(100));
if (failures) { console.log(`${failures} CHECK(S) FAILED`); process.exit(1); }
console.log('The BAC filter finds every bank charge in every spelling, and hiding them hides only them.');
console.log('='.repeat(100));
