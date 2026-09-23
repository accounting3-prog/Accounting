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

  const aedCards = rows.map(asCard);

  /* ------------------------------------------- the ledger as it stands today */

  setLedgerData({ cards: aedCards, transactions: [], currencySpend: [] });
  const before = getTotals();
  const aedBefore = before.byCurrency.find((c) => c.code === 'AED');
  check('today every account settles in AED', before.byCurrency.length === 1,
        before.byCurrency.map((c) => c.code).join(', '));
  check('and its total is the sum of the real cards',
        near(aedBefore.liveBalance, rows.reduce((a, r) => a + Number(r.ledger), 0)),
        money(aedBefore.liveBalance));

  /* ------------------------------------------------- now a SAR bank joins it */

  const SAR_BALANCE = 3_926_392.64; // the KSA account's closing balance
  const withBank = [
    ...aedCards,
    {
      ...asCard(
        { name: 'SAB KSA — SASABB036677631001', settlement_currency: 'SAR',
          ledger: SAR_BALANCE, source: SAR_BALANCE, diff: 0, n: 167 },
        999,
      ),
    },
  ];
  setLedgerData({ cards: withBank, transactions: [], currencySpend: [] });
  const after = getTotals();

  const aed = after.byCurrency.find((c) => c.code === 'AED');
  const sar = after.byCurrency.find((c) => c.code === 'SAR');

  check('both currencies are reported', Boolean(aed && sar),
        after.byCurrency.map((c) => `${c.code} ${money(c.liveBalance)}`).join('  ·  '));

  // The point. The AED figure must be exactly what it was before the SAR
  // account existed — if it moved, riyals leaked into it.
  check('the AED figure did not move when the SAR account appeared',
        near(aed.liveBalance, aedBefore.liveBalance),
        `${money(aedBefore.liveBalance)} -> ${money(aed.liveBalance)}`);
  check('and the SAR figure is the bank alone', near(sar.liveBalance, SAR_BALANCE),
        money(sar.liveBalance));

  // The forbidden number, hunted for in every numeric field of the result.
  const forbidden = aedBefore.liveBalance + SAR_BALANCE;
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
        after.cardCount === aedCards.length + 1 &&
        after.transactionCount === before.transactionCount + 167,
        `${after.cardCount} accounts, ${after.transactionCount} transactions`);

  /* ----------------------------------- an account out of balance in each one */

  const skewed = withBank.map((c, i) =>
    i === 0 ? { ...c, reconciliationDifference: 1000 }
    : c.settlementCurrency === 'SAR' ? { ...c, reconciliationDifference: -1000 }
    : c);
  setLedgerData({ cards: skewed, transactions: [], currencySpend: [] });
  const skew = getTotals();

  // Netting these against each other would report "nothing is wrong" for two
  // accounts that are each wrong, in different currencies.
  check('two accounts out by opposite amounts in different currencies are both reported',
        skew.cardsWithDifference.length === 2,
        `${skew.cardsWithDifference.length} flagged`);
  check('and neither difference cancelled the other',
        near(skew.byCurrency.find((c) => c.code === 'AED').reconciliationDifference, 1000) &&
        near(skew.byCurrency.find((c) => c.code === 'SAR').reconciliationDifference, -1000),
        'AED +1,000.00 and SAR -1,000.00, kept apart');
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
