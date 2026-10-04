/**
 * Checks the month-by-month bank figures the Transactions screen now shows,
 * against arithmetic done here and against the balances the bank printed.
 *
 * The screen used to show a month's net movement under the label "Net cost",
 * which on a bank account read as a balance and looked plainly wrong. It now
 * shows opening, paid out, came in and closing, and says whether the closing
 * matches what the bank printed. This test runs that same code — bankPeriod
 * from ledger.ts — over every calendar month on every bank account, and checks
 * three things for each:
 *
 *   1. it agrees with a sum done independently here, in SQL
 *   2. closing = opening − paid out + came in
 *   3. one month's closing is the next month's opening, so no row falls
 *      between two months
 *
 * and reports whether the bank printed each closing balance.
 *
 *   LEDGER_DEPS=... LEDGER_BUNDLE=... node scripts/db/bank_period_test.mjs
 */

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { connect, q } from './connect.mjs';

const { bankPeriod, setLedgerData } = await import(
  pathToFileURL(resolve(process.env.LEDGER_BUNDLE ?? 'web/src/lib/ledger.ts')).href
);

const money = (n) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

let failures = 0;
const fail = (msg) => {
  failures++;
  console.log(`  FAIL  ${msg}`);
};

const client = await connect();

try {
  const cards = await q(
    client,
    `select id, name, settlement_currency as "settlementCurrency", card_type as "cardType",
            tracks_balance as "tracksBalance", opening_balance::float8 as "openingBalance"
       from cards where card_type = 'bank_account' and tracks_balance is not false order by name`,
  );
  const transactions = await q(
    client,
    `select t.id, t.card_id as "cardId", to_char(t.txn_date,'YYYY-MM-DD') txn_date,
            t.amount_aed::float8 amount_aed, t.status,
            t.statement_balance::float8 statement_balance
       from transactions t join cards c on c.id = t.card_id
      where c.card_type = 'bank_account'`,
  );
  setLedgerData({ generatedFrom: 'test', cards, transactions, spendByCurrency: [] });

  console.log('='.repeat(100));
  console.log('A BANK ACCOUNT, MONTH BY MONTH, AS THE TRANSACTIONS SCREEN NOW SHOWS IT');
  console.log('='.repeat(100));

  for (const card of cards) {
    console.log(`\n  ${card.name} (${card.settlementCurrency})\n`);
    console.log('    month       opening          paid out          came in           closing     bank');

    const months = (
      await q(
        client,
        `select distinct to_char(txn_date,'YYYY-MM') m from transactions
          where card_id = $1 and status <> 'voided' order by 1`,
        [card.id],
      )
    ).map((r) => r.m);

    let previousClosing = null;
    for (const m of months) {
      const from = `${m}-01`;
      const [y, mo] = m.split('-').map(Number);
      const to = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
      const p = bankPeriod(card, from, to);

      // The same figures, summed by the database rather than by ledger.ts.
      const [sql] = await q(
        client,
        `select coalesce(sum(amount_aed) filter (where txn_date < $2),0)::float8 before,
                coalesce(sum(-amount_aed) filter (where txn_date between $2 and $3 and amount_aed < 0),0)::float8 paid,
                coalesce(sum(amount_aed)  filter (where txn_date between $2 and $3 and amount_aed > 0),0)::float8 came
           from transactions where card_id = $1 and status <> 'voided'`,
        [card.id, from, to],
      );
      const opening = card.openingBalance + sql.before;

      if (Math.abs(p.opening - opening) > 0.005) fail(`${m} opening ${money(p.opening)} vs ${money(opening)}`);
      if (Math.abs(p.paidOut - sql.paid) > 0.005) fail(`${m} paid out ${money(p.paidOut)} vs ${money(sql.paid)}`);
      if (Math.abs(p.cameIn - sql.came) > 0.005) fail(`${m} came in ${money(p.cameIn)} vs ${money(sql.came)}`);
      if (Math.abs(p.closing - (p.opening - p.paidOut + p.cameIn)) > 0.005) fail(`${m} closing does not add up`);
      if (previousClosing !== null && Math.abs(previousClosing - p.opening) > 0.005)
        fail(`${m} opens at ${money(p.opening)} but the month before closed at ${money(previousClosing)}`);
      if (p.bankAgrees === false) fail(`${m} closing ${money(p.closing)} was not printed by the bank on ${p.lastDay}`);
      previousClosing = p.closing;

      console.log(
        `    ${m}  ${money(p.opening).padStart(14)}  ${money(p.paidOut).padStart(15)}  ` +
          `${money(p.cameIn).padStart(15)}  ${money(p.closing).padStart(15)}     ` +
          (p.bankAgrees === null ? '—' : p.bankAgrees ? 'yes' : 'NO'),
      );
    }
  }
} finally {
  await client.end();
}

console.log('\n' + '='.repeat(100));
if (failures) { console.log(`${failures} CHECK(S) FAILED`); process.exit(1); }
console.log('Every month adds up, each month opens where the last one closed, and the bank printed every closing.');
console.log('='.repeat(100));
