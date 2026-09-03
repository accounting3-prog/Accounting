/**
 * Independent verification of the imported ledger.
 *
 * The figures are computed THREE ways and compared:
 *
 *   1. raw SQL written here from scratch, spelling out the arithmetic
 *      explicitly rather than calling anything the application defines;
 *   2. the card_balances view, which is what the application actually reads;
 *   3. the audited extraction output, computed in Python before any database
 *      existed.
 *
 * A check that reuses the app's own function to produce its expectation only
 * proves the function equals itself, so (1) deliberately shares no definition
 * with (2). All three must agree.
 *
 * SERVER-SIDE ONLY. Read-only: this script never writes.
 */

import { readFile } from 'node:fs/promises';
import { connect, q } from './connect.mjs';

const money = (n) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const near = (a, b, tol = 0.005) => Math.abs(Number(a) - Number(b)) <= tol;

let failures = 0;
function check(label, actual, expected, extra = '') {
  const ok = typeof expected === 'number' ? near(actual, expected) : actual === expected;
  if (!ok) failures++;
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(52)}` +
      (ok ? '' : ` expected ${expected}, got ${actual}`) +
      (extra ? `  ${extra}` : ''),
  );
  return ok;
}

const client = await connect();
try {
  const extraction = JSON.parse(await readFile('scripts/out/normalised.json', 'utf8'));
  const expected = new Map(extraction.map((c) => [c.card, c.summary]));

  console.log('='.repeat(94));
  console.log('INDEPENDENT VERIFICATION — raw SQL vs the view vs the audited extraction');
  console.log('='.repeat(94));

  /* ------------------------------------------------ 1. raw SQL, written fresh */

  // Spelled out deliberately: opening balance plus the transactions that the
  // workbook's own formula consumed gives the source balance; opening balance
  // plus every non-voided real transaction gives the ledger balance.
  const raw = await q(
    client,
    `
    select c.name,
           c.opening_balance::numeric                                    as opening,
           c.opening_balance + coalesce(sum(t.amount_aed) filter (
               where t.included_in_source_balance and t.status <> 'voided'), 0)
                                                                          as source_balance,
           c.opening_balance + coalesce(sum(t.amount_aed) filter (
               where t.entry_type = 'source_transaction' and t.status <> 'voided'), 0)
                                                                          as ledger_balance,
           coalesce(sum(t.amount_aed) filter (
               where t.direction = 'spend' and t.status <> 'voided'), 0)   as total_spend,
           coalesce(sum(t.amount_aed) filter (
               where t.direction = 'funding' and t.status <> 'voided'), 0) as total_funding,
           coalesce(sum(t.amount_aed) filter (
               where t.entry_type = 'reconciliation_adjustment'), 0)       as adjustments,
           count(*) filter (where t.entry_type = 'source_transaction')     as txn_count,
           count(*) filter (where t.status = 'needs_review')               as needs_review,
           count(*) filter (where t.status = 'excluded_from_source_balance') as excluded
      from cards c
      left join transactions t
             on t.card_id = c.id
            and (c.opening_date is null or t.txn_date >= c.opening_date)
     group by c.id, c.name, c.opening_balance
     order by c.name`,
  );

  /* ---------------------------------------------------- 2. the app's own view */

  const view = new Map(
    (await q(client, 'select * from card_balances order by card_name')).map((r) => [
      r.card_name,
      r,
    ]),
  );

  console.log('\nPER-CARD BALANCES');
  console.log('-'.repeat(94));
  console.log(
    `  ${'CARD'.padEnd(32)}${'SOURCE'.padStart(14)}${'LEDGER'.padStart(14)}` +
      `${'DIFF'.padStart(12)}${'SQL=VIEW'.padStart(10)}${'SQL=EXTRACT'.padStart(13)}`,
  );

  for (const r of raw) {
    const v = view.get(r.name);
    const e = expected.get(r.name);
    const diff = Number(r.source_balance) - Number(r.ledger_balance);

    const sqlEqView =
      near(r.source_balance, v.source_balance) &&
      near(r.ledger_balance, v.ledger_balance) &&
      near(diff, v.reconciliation_difference);
    const sqlEqExtract =
      near(r.source_balance, e.source_balance) &&
      near(r.ledger_balance, e.ledger_balance) &&
      near(diff, e.reconciliation_difference);

    if (!sqlEqView || !sqlEqExtract) failures++;
    console.log(
      `  ${r.name.padEnd(32)}${money(r.source_balance).padStart(14)}` +
        `${money(r.ledger_balance).padStart(14)}${money(diff).padStart(12)}` +
        `${(sqlEqView ? 'yes' : 'NO').padStart(10)}${(sqlEqExtract ? 'yes' : 'NO').padStart(13)}`,
    );
  }

  const totals = raw.reduce(
    (a, r) => ({
      source: a.source + Number(r.source_balance),
      ledger: a.ledger + Number(r.ledger_balance),
    }),
    { source: 0, ledger: 0 },
  );
  console.log('  ' + '-'.repeat(92));
  console.log(
    `  ${'TOTAL (AED)'.padEnd(32)}${money(totals.source).padStart(14)}` +
      `${money(totals.ledger).padStart(14)}` +
      `${money(totals.source - totals.ledger).padStart(12)}`,
  );

  /* ------------------------------------------------------------ named checks */

  console.log('\nTHE TWO CARDS WHERE SOURCE AND LEDGER DISAGREE');
  console.log('-'.repeat(94));
  const amex = raw.find((r) => r.name.startsWith('AMEX 3024'));
  const rak = raw.find((r) => r.name.startsWith('RAK 9825'));

  check('AMEX 3024 source workbook balance', Number(amex.source_balance), 25474.74);
  check('AMEX 3024 ledger balance incl. FLYNAS', Number(amex.ledger_balance), 16728.96);
  check(
    'AMEX 3024 reconciliation difference',
    Number(amex.source_balance) - Number(amex.ledger_balance),
    8745.78,
  );
  // Scoped to the specific row. FLYNAS is an airline and appears five times
  // across the workbook; only AMEX 3024 row 5 is the excluded one, and a
  // query matching the name alone would sweep in four legitimate charges on
  // other cards.
  const flynas = await q(
    client,
    `select t.amount_aed, t.currency, t.original_amount, t.status,
            t.included_in_source_balance
       from transactions t
       join cards c on c.id = t.card_id
      where c.name = 'AMEX 3024 (3016- COR)' and t.source_row = 5`,
  );
  check('FLYNAS on AMEX 3024 row 5 appears exactly once', flynas.length, 1);
  check('FLYNAS amount', Number(flynas[0].amount_aed), -8745.78);
  check('FLYNAS status', flynas[0].status, 'excluded_from_source_balance');
  check('FLYNAS excluded from source balance', flynas[0].included_in_source_balance, false);
  check('FLYNAS currency preserved', flynas[0].currency, 'SAR');
  check('FLYNAS original amount preserved', Number(flynas[0].original_amount), 8925.77);

  console.log('');
  check('RAK 9825 source workbook balance', Number(rak.source_balance), 165.72);
  check('RAK 9825 ledger without the adjustment', Number(rak.ledger_balance), -1552.30);
  check('RAK 9825 review adjustment held apart', Number(rak.adjustments), 1718.02);
  check(
    'RAK 9825 reconciliation difference',
    Number(rak.source_balance) - Number(rak.ledger_balance),
    1718.02,
  );

  console.log('\nSTRUCTURAL INVARIANTS');
  console.log('-'.repeat(94));

  const [{ n: adjWithDirection }] = await q(
    client,
    `select count(*)::int n from transactions
      where entry_type = 'reconciliation_adjustment' and direction is not null`,
  );
  check('no adjustment carries a direction', adjWithDirection, 0);

  const [{ n: badSign }] = await q(
    client,
    `select count(*)::int n from transactions
      where (direction = 'spend' and amount_aed > 0)
         or (direction = 'funding' and amount_aed < 0)`,
  );
  check('no transaction has a sign contradicting its direction', badSign, 0);

  const [{ n: aedWithRate }] = await q(
    client,
    `select count(*)::int n from transactions
      where currency = 'AED' and exchange_rate is not null`,
  );
  check('no AED transaction carries a conversion rate', aedWithRate, 0);

  const [{ n: dupKeys }] = await q(
    client,
    `select count(*)::int n from (
        select dedup_key from transactions group by dedup_key having count(*) > 1) x`,
  );
  check('every dedup_key is unique', dupKeys, 0);

  const [{ n: repeats }] = await q(
    client,
    'select count(*)::int n from transactions where occurrence > 1',
  );
  check('genuine repeat charges kept apart', repeats, 130);

  const [{ n: repaired }] = await q(
    client,
    'select count(*)::int n from transactions where date_repaired',
  );
  check('dates repaired, originals preserved', repaired, 17);

  const [{ n: repairedNoOriginal }] = await q(
    client,
    'select count(*)::int n from transactions where date_repaired and source_date_raw is null',
  );
  check('every repaired date kept its original cell', repairedNoOriginal, 0);

  /* ------------------------------------------------- counts, per card+status */

  console.log('\nCOUNTS BY CARD AND STATUS  (database vs extraction)');
  console.log('-'.repeat(94));
  const byStatus = await q(
    client,
    `select c.name, t.status, count(*)::int n
       from transactions t join cards c on c.id = t.card_id
      group by c.name, t.status order by c.name, t.status`,
  );
  const dbCounts = new Map();
  for (const r of byStatus) dbCounts.set(`${r.name}|${r.status}`, r.n);

  for (const card of extraction) {
    const rows = card.transactions;
    for (const status of ['confirmed', 'needs_review', 'excluded_from_source_balance']) {
      const exp = rows.filter((t) => t.status === status).length;
      if (exp === 0 && !dbCounts.has(`${card.card}|${status}`)) continue;
      check(
        `${card.card} · ${status}`,
        dbCounts.get(`${card.card}|${status}`) ?? 0,
        exp,
      );
    }
  }

  const [{ n: totalDb }] = await q(client, 'select count(*)::int n from transactions');
  const totalExtract = extraction.reduce((a, c) => a + c.transactions.length, 0);
  console.log('');
  check('total rows in the database', totalDb, totalExtract);

  /* --------------------------------------------- currencies never cross-added */

  console.log('\nCURRENCY SEPARATION');
  console.log('-'.repeat(94));
  const ccy = await q(
    client,
    `select currency, count(*)::int n, sum(original_amount) as original
       from transactions
      where direction = 'spend' and currency is not null
      group by currency order by n desc limit 6`,
  );
  for (const r of ccy)
    console.log(
      `  ${r.currency}  ${String(r.n).padStart(5)} spend rows   ` +
        `original total ${money(r.original ?? 0).padStart(18)} ${r.currency}`,
    );
  console.log('  (reported per currency; no cross-currency total is produced anywhere)');

  console.log('\n' + '='.repeat(94));
  console.log(
    failures === 0
      ? 'ALL CHECKS PASSED — raw SQL, the view and the audited extraction agree'
      : `${failures} CHECK(S) FAILED`,
  );
  console.log('='.repeat(94));
  process.exit(failures ? 1 : 0);
} finally {
  await client.end();
}
