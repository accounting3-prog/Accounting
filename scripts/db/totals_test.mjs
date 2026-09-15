/**
 * The search total, checked against the database's own arithmetic.
 *
 * The figure it shows is a NET: what went out, less what came back. That is the
 * question a request number is asked — a 5,000 booking refunded in full cost
 * nothing — and it is also the figure most easily got wrong, because a refund
 * is stored with the opposite sign to a purchase and adding them up carelessly
 * gives an answer that looks plausible.
 *
 * So every figure is recomputed in SQL, which shares no code with the selector,
 * and the two are compared on real request numbers and real cards.
 *
 *   LEDGER_DEPS=... LEDGER_BUNDLE=... node scripts/db/totals_test.mjs
 */

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { connect, q } from './connect.mjs';

const { totalsFor } = await import(
  pathToFileURL(resolve(process.env.LEDGER_BUNDLE ?? 'web/src/lib/ledger.ts')).href
);

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(56)}${detail}`);
};
const money = (n) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

const client = await connect();

/** The rows as the app holds them, shaped the way api.ts shapes them. */
const asTransactions = (rows) =>
  rows.map((r) => ({
    id: r.id,
    cardId: r.card_id,
    entry_type: r.entry_type,
    status: r.status,
    txn_date: r.txn_date,
    supplier: r.supplier,
    amount_aed: Number(r.amount_aed),
    direction: r.direction ?? undefined,
    currency: r.currency ?? undefined,
    original_amount: r.original_amount === null ? undefined : Number(r.original_amount),
  }));

const FIELDS = `id, card_id, entry_type::text, status::text,
                to_char(txn_date,'YYYY-MM-DD') as txn_date,
                supplier_raw as supplier, amount_aed::float8 as amount_aed,
                direction::text, currency, original_amount::float8 as original_amount`;

try {
  console.log('='.repeat(92));
  console.log('THE SEARCH TOTAL — recomputed in SQL and compared');
  console.log('='.repeat(92));

  /* ------------------ the request numbers with the most interesting mix */

  const reqs = await q(
    client,
    `select req_number, count(*)::int n
       from transactions
      where coalesce(btrim(req_number),'') <> '' and status <> 'voided'
      group by 1
     having count(*) filter (where amount_aed > 0) > 0
        and count(*) filter (where amount_aed < 0) > 0
      order by count(*) desc limit 5`,
  );
  console.log(`\nrequest numbers holding BOTH money out and money in: ${reqs.length}\n`);

  for (const { req_number } of reqs) {
    const rows = await q(client, `select ${FIELDS} from transactions where req_number = $1`, [
      req_number,
    ]);
    const t = totalsFor(asTransactions(rows));

    // The same figures, worked out by the database.
    const [sql] = await q(
      client,
      `select
         coalesce(sum(-amount_aed) filter (
            where amount_aed < 0 and entry_type = 'source_transaction' and status <> 'voided'), 0)::float8 as spent,
         coalesce(sum(amount_aed) filter (
            where amount_aed > 0 and entry_type = 'source_transaction' and status <> 'voided'), 0)::float8 as received,
         count(*) filter (where status <> 'voided')::int as rows
       from transactions where req_number = $1`,
      [req_number],
    );

    const ok =
      near(t.spent, sql.spent) && near(t.received, sql.received) &&
      near(t.net, sql.spent - sql.received);
    check(
      `${req_number.slice(0, 22).padEnd(24)} ${money(t.spent)} out − ${money(t.received)} back`,
      ok,
      ok ? `net ${money(t.net)}` : `SQL says ${money(sql.spent)} / ${money(sql.received)}`,
    );
  }

  /* ---------------------------------------- a whole card, every row of it */

  console.log('');
  for (const name of ['MASTERCARD 6404 VPAY', 'RAK 9825 (6071)']) {
    const rows = await q(
      client,
      `select ${FIELDS} from transactions t
        where card_id = (select id from cards where name = $1)`,
      [name],
    );
    const t = totalsFor(asTransactions(rows));
    const [sql] = await q(
      client,
      `select
         coalesce(sum(-amount_aed) filter (
            where amount_aed < 0 and entry_type='source_transaction' and status <> 'voided'), 0)::float8 spent,
         coalesce(sum(amount_aed) filter (
            where amount_aed > 0 and entry_type='source_transaction' and status <> 'voided'), 0)::float8 received
       from transactions where card_id = (select id from cards where name = $1)`,
      [name],
    );
    check(
      `${name.slice(0, 24).padEnd(26)} ${money(t.spent)} out − ${money(t.received)} back`,
      near(t.spent, sql.spent) && near(t.received, sql.received),
      `net ${money(t.net)}`,
    );
  }

  /* ------------------------------------------- the rules that must hold */

  console.log('');
  const all = await q(client, `select ${FIELDS} from transactions`);
  const t = totalsFor(asTransactions(all));

  const [{ n: voided }] = await q(
    client,
    `select coalesce(sum(abs(amount_aed)),0)::float8 n from transactions where status = 'voided'`,
  );
  check('voided rows are left out entirely', voided > 0, `${money(voided)} of voided rows exist`);
  const [sqlAll] = await q(
    client,
    `select coalesce(sum(-amount_aed) filter (
              where amount_aed < 0 and entry_type='source_transaction' and status <> 'voided'), 0)::float8 spent
       from transactions`,
  );
  check('and the spend total excludes them', near(t.spent, sqlAll.spent), money(t.spent));

  const [{ n: adjRows }] = await q(
    client,
    `select count(*)::int n from transactions
      where entry_type = 'reconciliation_adjustment' and status <> 'voided'`,
  );
  check('reconciliation adjustments are reported apart, not folded into spend',
        t.adjustmentRows === adjRows, `${t.adjustmentRows} kept separate`);

  // The rule this ledger has held since the first line of it.
  const codes = t.byCurrency.map((c) => c.code);
  check('original amounts are one figure per currency, never one total',
        new Set(codes).size === codes.length && codes.length > 1,
        `${codes.length} currencies: ${codes.slice(0, 6).join(', ')}`);

  const [sqlEur] = await q(
    client,
    `select coalesce(sum(abs(original_amount) * case when amount_aed < 0 then 1 else -1 end), 0)::float8 n
       from transactions
      where currency = 'EUR' and original_amount is not null
        and entry_type = 'source_transaction' and status <> 'voided'`,
  );
  const eur = t.byCurrency.find((c) => c.code === 'EUR');
  check('and each currency nets its own refunds the same way',
        eur && near(eur.amount, sqlEur.n),
        `EUR ${money(eur?.amount ?? 0)} vs SQL ${money(sqlEur.n)}`);

  /* ------------------------------------------- a refund cancels its purchase */

  const t2 = totalsFor([
    { id: 'a', cardId: 'c', entry_type: 'source_transaction', status: 'confirmed',
      amount_aed: -5000, direction: 'spend' },
    { id: 'b', cardId: 'c', entry_type: 'source_transaction', status: 'confirmed',
      amount_aed: 5000, direction: 'funding' },
  ]);
  check('a booking refunded in full comes to nothing', near(t2.net, 0),
        `${money(t2.spent)} out, ${money(t2.received)} back, net ${money(t2.net)}`);
  check('and both halves are still shown, so the zero is checkable',
        near(t2.spent, 5000) && near(t2.received, 5000));
} finally {
  await client.end();
}

console.log('\n' + '='.repeat(92));
if (failures) {
  console.log(`${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('The total nets refunds against payments, and never adds two currencies together.');
console.log('='.repeat(92));
