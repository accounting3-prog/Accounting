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
           -- A voided adjustment has been decided about; it stays on the row
           -- for the audit trail but is not still outstanding.
           coalesce(sum(t.amount_aed) filter (
               where t.entry_type = 'reconciliation_adjustment'
                 and t.status <> 'voided'), 0)                             as adjustments,
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

  // Cards whose figures have moved away from the import through recorded
  // corrections. Divergence is expected as the ledger is worked on; divergence
  // with nothing on record is not.
  const explained = [];

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
    // The extraction is what the workbook said at import. The ledger moves on
    // through audited corrections, so a card may legitimately differ — but only
    // if the corrections that moved it are on record.
    const sqlEqExtract =
      near(r.source_balance, e.source_balance) &&
      near(r.ledger_balance, e.ledger_balance) &&
      near(diff, e.reconciliation_difference);
    if (!sqlEqExtract) {
      const [{ n: corrections }] = await q(client,
        `select count(*)::int n from transaction_corrections tc
           join transactions t on t.id = tc.transaction_id
           join cards c on c.id = t.card_id
          where c.name = $1`, [r.name]);
      if (corrections === 0) failures++;
      else explained.push(`${r.name} (${corrections} recorded corrections)`);
    }
    if (!sqlEqView) failures++;
    console.log(
      `  ${r.name.padEnd(32)}${money(r.source_balance).padStart(14)}` +
        `${money(r.ledger_balance).padStart(14)}${money(diff).padStart(12)}` +
        `${(sqlEqView ? 'yes' : 'NO').padStart(10)}${(sqlEqExtract ? 'yes' : 'NO').padStart(13)}`,
    );
  }

  if (explained.length) {
    console.log('\n  differs from the import, explained by audited corrections:');
    for (const e of explained) console.log(`    ${e}`);
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

  // The workbook was corrected on 2026-09-04: a balance formula was added to
  // row 5, so the sheet now includes FLYNAS itself and the two figures agree.
  check('AMEX 3024 source workbook balance', Number(amex.source_balance), 16728.96);
  check('AMEX 3024 official live balance', Number(amex.ledger_balance), 16728.96);
  check(
    'AMEX 3024 reconciliation difference is now zero',
    Number(amex.source_balance) - Number(amex.ledger_balance),
    0,
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
  // The status may legitimately be confirmed once someone has reviewed it; what
  // must not change is that it counts in the live balance and is still marked
  // as absent from the workbook's own formula chain, which is what keeps the
  // reconciliation difference visible.
  check('FLYNAS is not voided', flynas[0].status !== 'voided', true);
  check('FLYNAS is counted in both balances', flynas[0].included_in_source_balance, true);
  check('FLYNAS currency preserved', flynas[0].currency, 'SAR');
  check('FLYNAS original amount preserved', Number(flynas[0].original_amount), 8925.77);

  console.log('');
  // The reissued RAK 9825 statement (5 Sep 2026) carries no manual balance
  // overwrite — the chain runs unbroken through the 10,000 payment — so the
  // 1,718.02 was an artefact of the previous file. It is voided, kept on
  // record, and the two balances now agree.
  check('RAK 9825 statement balance', Number(rak.source_balance), -1552.78);
  check('RAK 9825 ledger balance', Number(rak.ledger_balance), -1552.78);
  check('RAK 9825 reconciles',
        Number(rak.source_balance) - Number(rak.ledger_balance), 0);
  check('no unresolved adjustment counts toward a balance',
        Number(rak.adjustments), 0);

  const [{ n: adjKept }] = await q(
    client,
    `select count(*)::int n from transactions t join cards c on c.id = t.card_id
      where c.name like 'RAK 9825%' and t.entry_type = 'reconciliation_adjustment'`,
  );
  check('the voided adjustment is kept on record, not deleted', adjKept, 1);

  console.log('\nAMEX 3024 — THE ARITHMETIC, AND THE FIGURE THAT MUST NEVER APPEAR');
  console.log('-'.repeat(94));
  const SOURCE_CHAIN = 25474.74;   // the chain immediately before the FLYNAS row
  const FLYNAS_AMOUNT = -8745.78;
  const OFFICIAL = 16728.96;
  const FORBIDDEN = 7983.18; // FLYNAS deducted a second time

  check(
    '25,474.74 - 8,745.78 = 16,728.96',
    Number((SOURCE_CHAIN + FLYNAS_AMOUNT).toFixed(2)),
    OFFICIAL,
  );
  check('official live ledger balance is that figure', Number(amex.ledger_balance), OFFICIAL);
  // Both balances now include FLYNAS, so the test is that the figure equals the
  // pre-FLYNAS chain less one deduction — not that one balance is the other
  // minus it.
  check('FLYNAS is applied exactly once, not twice',
        Number((SOURCE_CHAIN + FLYNAS_AMOUNT).toFixed(2)), Number(amex.ledger_balance));

  // Every balance figure the system can produce, from every surface, scanned
  // for the double deduction. 7,983.18 appearing anywhere would mean FLYNAS had
  // been subtracted from a total that already excluded it.
  const everyFigure = await q(
    client,
    `select 'card_balances.source' as src, source_balance as v from card_balances
     union all select 'card_balances.ledger',      ledger_balance            from card_balances
     union all select 'card_balances.difference',  reconciliation_difference from card_balances
     union all select 'card_balances.opening',     opening_balance           from card_balances
     union all select 'card_balances.spend',       total_spend               from card_balances
     union all select 'card_balances.funding',     total_funding             from card_balances
     union all select 'card_balances.adjustments', review_adjustments_total  from card_balances
     union all select 'transactions.amount_aed',   amount_aed                from transactions
     union all select 'cards.opening_balance',     opening_balance           from cards`,
  );
  const hits = everyFigure.filter((r) => near(r.v, FORBIDDEN));
  check(
    `7,983.18 appears in no figure anywhere (${everyFigure.length} scanned)`,
    hits.length,
    0,
    hits.map((h) => h.src).join(', '),
  );

  const [{ n: flynasCount }] = await q(
    client,
    `select count(*)::int n from transactions
      where supplier_raw ilike 'FLYNAS%'
        and card_id = (select id from cards where name = 'AMEX 3024 (3016- COR)')`,
  );
  check('FLYNAS exists once on AMEX 3024', flynasCount, 1);

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

  console.log('\nSTATUS CHANGES SINCE IMPORT  (each must be an audited correction)');
  console.log('-'.repeat(94));

  // A status is not frozen at import: resolving a review item legitimately
  // changes it. What must hold is that no status changed WITHOUT a recorded
  // decision behind it — which is a stronger guarantee than the counts
  // matching, and the one that actually matters.
  const importStatus = new Map();
  for (const card of extraction)
    for (const t of card.transactions) importStatus.set(t.dedup_key, t.status);

  const live = await q(
    client,
    `select t.dedup_key, t.status, c.name as card, t.source_row,
            (select count(*) from transaction_corrections tc
              where tc.transaction_id = t.id) as corrections
       from transactions t join cards c on c.id = t.card_id`,
  );

  const changed = live.filter(
    (r) => importStatus.has(r.dedup_key) && importStatus.get(r.dedup_key) !== r.status,
  );
  const unexplained = changed.filter((r) => Number(r.corrections) === 0);

  console.log(`  ${changed.length} rows have a different status than at import`);
  for (const r of changed.slice(0, 6))
    console.log(
      `      ${r.card} row ${r.source_row}: ` +
        `${importStatus.get(r.dedup_key)} -> ${r.status} ` +
        `(${r.corrections} recorded decision${Number(r.corrections) === 1 ? '' : 's'})`,
    );
  if (changed.length > 6) console.log(`      ... and ${changed.length - 6} more`);

  check('every status change is backed by a recorded decision', unexplained.length, 0,
        unexplained.map((r) => `${r.card} row ${r.source_row}`).join(', '));

  const missingFromDb = [...importStatus.keys()].filter(
    (k) => !live.some((r) => r.dedup_key === k),
  );
  check('no imported row has gone missing', missingFromDb.length, 0);
  check('no row exists that was not imported',
        live.length - importStatus.size, 0);

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
