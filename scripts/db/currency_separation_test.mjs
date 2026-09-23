/**
 * Money of different currencies is never added together.
 *
 * This is the oldest rule in the ledger and it survived only because every
 * account happened to settle in AED — getTotals summed `ledgerBalance` across
 * all of them and the comment above it said "AED only — all cards settle in
 * AED". A SAR bank account makes that false, and the failure would have been
 * silent: the dashboard would have shown riyals added to dirhams under a
 * hard-coded AED label, and nothing would have complained.
 *
 * So the test is not "does it group by currency". It is: given accounts in two
 * currencies, does ANY figure the app produces equal the cross-currency sum?
 * That is the number that must not exist anywhere.
 *
 * Runs against the real cards plus a synthetic SAR account, so the AED figures
 * are the live ones and must not move when the SAR account appears.
 *
 *   LEDGER_DEPS=... LEDGER_BUNDLE=... node scripts/db/currency_separation_test.mjs
 */

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { connect, q } from './connect.mjs';

const { setLedgerData, getTotals } = await import(
  pathToFileURL(resolve(process.env.LEDGER_BUNDLE ?? 'web/src/lib/ledger.ts')).href
);

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(60)}${detail}`);
};
const money = (n) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

const client = await connect();

try {
  console.log('='.repeat(96));
  console.log('TWO CURRENCIES — no figure anywhere is the sum of both');
  console.log('='.repeat(96));

  const rows = await q(
    client,
    `select c.name, c.settlement_currency,
            b.ledger_balance::float8 ledger, b.source_balance::float8 source,
            b.reconciliation_difference::float8 diff, b.transaction_count::int n
       from card_balances b join cards c on c.id = b.card_id
      order by c.name`,
  );

  const asCard = (r, i) => ({
    id: `card-${i}`,
    name: r.name,
    settlementCurrency: r.settlement_currency,
    ledgerBalance: Number(r.ledger),
    sourceBalance: Number(r.source),
    reconciliationDifference: Number(r.diff),
    transactionCount: Number(r.n),
    needsReview: 0,
    excluded: 0,
    reviewAdjustmentsTotal: 0,
    openingBalance: 0,
    balanceSign: 1,
    totalSpend: 0,
    totalFunding: 0,
  });

  const realCards = rows.map(asCard);
  const present = [...new Set(realCards.map((c) => c.settlementCurrency))].sort();

  /* --------------------------------------------- the ledger as it stands now */

  setLedgerData({ cards: realCards, transactions: [], currencySpend: [] });
  const before = getTotals();
  console.log(`\n  live accounts: ${realCards.length} in ${present.join(', ')}\n`);

  // The invariant, not a count of today's currencies: whatever currencies exist,
  // each figure is the sum of ONLY that currency's accounts. An earlier version
  // of this asserted "every account settles in AED", which was a fact about that
  // afternoon rather than a rule, and it failed the moment the bank was added —
  // for the one reason that should never fail a test: the thing it described
  // changed, correctly.
  for (const code of present) {
    const expected = realCards
      .filter((c) => c.settlementCurrency === code)
      .reduce((a, c) => a + c.ledgerBalance, 0);
    const got = before.byCurrency.find((c) => c.code === code);
    check(`${code} is the sum of its own accounts and nothing else`,
          got && near(got.liveBalance, expected), money(got?.liveBalance ?? NaN));
  }
  check('every currency present is reported, none merged away',
        before.byCurrency.length === present.length,
        before.byCurrency.map((c) => `${c.code} ${money(c.liveBalance)}`).join('  ·  '));

  const baseline = Object.fromEntries(before.byCurrency.map((c) => [c.code, c.liveBalance]));

  /* ------------------------------ a third currency arrives, in the same shape */

  // Deliberately a currency no account uses, so this keeps working whatever is
  // added to the ledger later.
  const NEW_BALANCE = 3_926_392.64;
  const withNew = [
    ...realCards,
    asCard({ name: 'A NEW ACCOUNT', settlement_currency: 'JPY',
             ledger: NEW_BALANCE, source: NEW_BALANCE, diff: 0, n: 167 }, 999),
  ];
  setLedgerData({ cards: withNew, transactions: [], currencySpend: [] });
  const after = getTotals();

  const jpy = after.byCurrency.find((c) => c.code === 'JPY');
  check('the new currency gets its own figure', Boolean(jpy) && near(jpy.liveBalance, NEW_BALANCE),
        money(jpy?.liveBalance ?? NaN));

  // The point. Every figure that existed before must be untouched — if any of
  // them moved, the new currency leaked into it.
  for (const code of present) {
    const got = after.byCurrency.find((c) => c.code === code);
    check(`${code} did not move when a new currency appeared`,
          near(got.liveBalance, baseline[code]),
          `${money(baseline[code])} -> ${money(got.liveBalance)}`);
  }

  // The forbidden number, hunted for in every numeric field of the result:
  // everything that already existed, added to the newcomer.
  const forbidden =
    Object.values(baseline).reduce((a, b) => a + b, 0) + NEW_BALANCE;
  const found = [];
  const walk = (value, path) => {
    if (typeof value === 'number') {
      if (near(value, forbidden)) found.push(path);
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`));
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
    }
  };
  walk(after, 'totals');
  check(`the cross-currency sum ${money(forbidden)} appears nowhere`,
        found.length === 0, found.length ? `FOUND AT ${found.join(', ')}` : 'checked every field');

  // Counts are not money and must still be whole-ledger.
  check('counts still cover every account',
        after.cardCount === realCards.length + 1 &&
        after.transactionCount === before.transactionCount + 167,
        `${after.cardCount} accounts, ${after.transactionCount} transactions`);

  /* ----------------------------------- an account out of balance in each one */

  const skewed = withNew.map((c, i) =>
    i === 0 ? { ...c, reconciliationDifference: 1000 }
    : c.settlementCurrency === 'JPY' ? { ...c, reconciliationDifference: -1000 }
    : { ...c, reconciliationDifference: 0 });
  setLedgerData({ cards: skewed, transactions: [], currencySpend: [] });
  const skew = getTotals();

  // Netting these against each other would report "nothing is wrong" for two
  // accounts that are each wrong, in different currencies.
  check('two accounts out by opposite amounts in different currencies are both reported',
        skew.cardsWithDifference.length === 2,
        `${skew.cardsWithDifference.length} flagged`);
  check('and neither difference cancelled the other',
        near(skew.byCurrency.find((c) => c.code === realCards[0].settlementCurrency)
               .reconciliationDifference, 1000) &&
        near(skew.byCurrency.find((c) => c.code === 'JPY').reconciliationDifference, -1000),
        `${realCards[0].settlementCurrency} +1,000.00 and JPY -1,000.00, kept apart`);
} finally {
  await client.end();
}

console.log('\n' + '='.repeat(96));
if (failures) {
  console.log(`${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('Two currencies, two sets of figures, and no number that mixes them.');
console.log('='.repeat(96));
