/**
 * Voids the extra copies a broken duplicate check let in.
 *
 * Six uploads of one nine-row file produced seventeen transactions, because the
 * duplicate check compared a supplier name from the sheet ("Emaar Misr 818")
 * against the same name from the ledger with its country code split off
 * ("Emaar Misr"). They never matched, so every row looked new every time.
 *
 * The earliest copy of each charge is kept and the later ones are voided —
 * never deleted. A voided row stays on the transaction, stays searchable, and
 * carries the reason; the balance excludes it. That is the difference between
 * correcting a ledger and editing one.
 *
 * Dry run by default.
 *
 *   LEDGER_DEPS=... node scripts/db/void_duplicates.mjs "MASTERCARD 6404 VPAY"
 *   LEDGER_DEPS=... node scripts/db/void_duplicates.mjs "MASTERCARD 6404 VPAY" --live
 */

import { connect, q } from './connect.mjs';

const CARD = process.argv[2];
const live = process.argv.includes('--live');
if (!CARD) {
  console.error('usage: node scripts/db/void_duplicates.mjs "<card name>" [--live]');
  process.exit(2);
}

const money = (n) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const client = await connect();

try {
  const [owner] = await q(client, 'select user_id from admins where is_owner limit 1');
  const [card] = await q(client, 'select id, name from cards where name = $1', [CARD]);
  if (!card) throw new Error(`no card called ${CARD}`);

  const [before] = await q(
    client,
    'select ledger_balance::text l, transaction_count::int n from card_balances where card_id = $1',
    [card.id],
  );

  /**
   * Groups of rows that are the same charge.
   *
   * Only rows entered since the workbook import are considered. The workbook's
   * own repeats are real — the same hotel charged twice in a day — and were
   * imported once each with their own occurrence number; touching those would
   * remove money that was genuinely spent.
   */
  const groups = await q(
    client,
    `select to_char(txn_date, 'YYYY-MM-DD') as d, amount_aed::text as a, supplier_raw as s,
            count(*)::int as copies,
            (array_agg(id order by created_at))[1] as keep,
            (array_agg(id order by created_at))[2:] as extras,
            (array_agg(created_at order by created_at))[1] as first_seen
       from transactions
      where card_id = $1 and source_sheet is null and status <> 'voided'
      group by txn_date, amount_aed, supplier_raw
     having count(*) > 1
      order by txn_date`,
    [card.id],
  );

  console.log(`\n${live ? 'LIVE' : 'DRY RUN'}  ${card.name}\n${'='.repeat(84)}`);
  console.log(`  balance now ${money(before.l)} over ${before.n} transactions\n`);

  if (!groups.length) {
    console.log('  No duplicated charge on this card. Nothing to do.');
    process.exit(0);
  }

  let toVoid = [];
  let effect = 0;
  for (const g of groups) {
    console.log(
      `  ${g.d}  ${money(g.a).padStart(13)}  ${String(g.s).slice(0, 34).padEnd(36)}` +
        `${g.copies} copies, keeping the one entered ${g.first_seen.toISOString().slice(0, 16)}`,
    );
    toVoid = toVoid.concat(g.extras);
    effect += (g.copies - 1) * Number(g.a);
  }

  // Only the copies actually IN the balance can change it. A row dated before
  // the card opened is stored and searchable but excluded by card_balances, so
  // voiding it moves nothing. Predicting otherwise made this dry run disagree
  // with its own result by 3,785.90 and sent me hunting a bug that turned out
  // to be the opening-date rule working exactly as intended.
  const [inBalance] = await q(
    client,
    `select coalesce(sum(t.amount_aed), 0)::numeric as counted, count(*)::int as n
       from transactions t join cards c on c.id = t.card_id
      where t.id = any($1)
        and (c.opening_date is null or t.txn_date >= c.opening_date)`,
    [toVoid],
  );
  const outside = toVoid.length - inBalance.n;

  console.log(`\n  ${toVoid.length} rows to void.`);
  if (outside)
    console.log(
      `  ${outside} of them are dated before the card opened, so they are not in the balance ` +
        `and voiding them moves nothing`,
    );
  console.log(`  the rest move the balance by ${money(inBalance.counted)}`);
  console.log(
    `  balance would go ${money(before.l)} -> ${money(Number(before.l) - Number(inBalance.counted))}`,
  );
  void effect;

  await client.query('begin');
  await client.query('set local role authenticated');
  await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [owner.user_id]);

  for (const id of toVoid) {
    await client.query(
      `select resolve_review_item(
         p_transaction_id := $1, p_action := 'void', p_rationale := $2)`,
      [
        id,
        'Duplicate of an identical row entered earlier from the same file. The import ' +
          'compared the sheet supplier "NAME 818" against the ledger name with its country ' +
          'code split off, so the two never matched and one file imported six times. Voided, ' +
          'not deleted: the row stays on record and out of the balance.',
      ],
    );
  }

  const [after] = await q(
    client,
    'select ledger_balance::text l, transaction_count::int n from card_balances where card_id = $1',
    [card.id],
  );
  console.log(`\n  balance after: ${money(after.l)}`);

  const [{ n: stillDup }] = await q(
    client,
    `select count(*)::int n from (
        select 1 from transactions
         where card_id = $1 and source_sheet is null and status <> 'voided'
         group by txn_date, amount_aed, supplier_raw having count(*) > 1) x`,
    [card.id],
  );
  console.log(`  duplicated charges remaining: ${stillDup}`);

  const [{ n: kept }] = await q(
    client,
    `select count(*)::int n from transactions where id = any($1) and status = 'voided'`,
    [toVoid],
  );
  console.log(`  rows voided and kept on record: ${kept} of ${toVoid.length}`);

  if (live) {
    await client.query('commit');
    console.log('\n  COMMITTED. Every void is in the history with its reason.');
  } else {
    await client.query('rollback');
    console.log('\n  Rolled back. Re-run with --live to apply.');
  }
} finally {
  await client.end();
}
