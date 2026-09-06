/**
 * Corrects one transaction from the command line, through the audited path.
 *
 * It calls update_transaction, the same function the edit dialog uses, so the
 * correction is recorded in transaction_corrections with who made it and why.
 * There is no raw UPDATE here on purpose: a figure changed without a stated
 * reason is not auditable, and a script is not a reason to lower that bar.
 *
 *   LEDGER_DEPS=... node scripts/db/correct_transaction.mjs \
 *     --card "RAK 9825" --row 29 --amount 2350.52 \
 *     --why "the reissued statement's own balance chain requires 2,350.52" \
 *     [--live]
 *
 * Without --live it runs the correction, shows the effect on the balance, and
 * rolls back.
 */

import { connect, q } from './connect.mjs';

const OWNER = 'accounting3@events-explorers.com';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const live = process.argv.includes('--live');

const cardLike = arg('card');
const sourceRow = arg('row');
const newAmount = arg('amount');
const newDate = arg('date');
const newKind = arg('kind');
const why = arg('why');

if (!cardLike || !sourceRow || !why) {
  console.error(
    'usage: correct_transaction.mjs --card <name> --row <n> --why <reason>\n' +
      '                              [--amount <positive AED>] [--date <YYYY-MM-DD>]\n' +
      '                              [--kind purchase|refund|funding|fee] [--live]',
  );
  process.exit(2);
}

const money = (n) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const client = await connect();

try {
  const [admin] = await q(client, 'select user_id from admins where email = $1', [OWNER]);
  if (!admin) throw new Error(`${OWNER} is not an admin in this database`);

  const [card] = await q(client, 'select id, name from cards where name like $1', [
    `${cardLike}%`,
  ]);
  if (!card) throw new Error(`no card matching "${cardLike}"`);

  const [before] = await q(
    client,
    `select id, to_char(txn_date,'YYYY-MM-DD') d, supplier_raw, amount_aed::text a,
            direction, currency, original_amount::text o
       from transactions
      where card_id = $1 and source_row = $2 and entry_type = 'source_transaction'`,
    [card.id, Number(sourceRow)],
  );
  if (!before) throw new Error(`no transaction at row ${sourceRow} of ${card.name}`);

  const [balBefore] = await q(
    client,
    'select ledger_balance::text l, source_balance::text s from card_balances where card_id = $1',
    [card.id],
  );

  console.log(`\n${live ? 'LIVE' : 'DRY RUN'}  ${card.name} row ${sourceRow}\n${'='.repeat(78)}`);
  console.log(`  ${before.d}  ${before.supplier_raw}`);
  console.log(`  currently ${money(before.a)} AED  (${before.direction})`);
  if (newAmount) console.log(`  amount  -> ${money(newAmount)}  as ${newKind ?? before.direction}`);
  if (newDate) console.log(`  date    -> ${newDate}`);
  console.log(`  reason:  ${why}`);

  await client.query('begin');
  try {
    await client.query('set local role authenticated');
    await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [admin.user_id]);

    await client.query(
      `select update_transaction(
         p_id := $1, p_rationale := $2, p_txn_date := $3, p_amount_aed := $4, p_kind := $5)`,
      [
        before.id,
        why,
        newDate ?? null,
        newAmount ? Number(newAmount) : null,
        newKind ?? (before.direction === 'spend' ? 'purchase' : 'refund'),
      ],
    );

    const [after] = await q(
      client,
      `select amount_aed::text a, to_char(txn_date,'YYYY-MM-DD') d from transactions where id = $1`,
      [before.id],
    );
    const [balAfter] = await q(
      client,
      'select ledger_balance::text l, source_balance::text s from card_balances where card_id = $1',
      [card.id],
    );

    console.log(`\n  amount   ${money(before.a).padStart(14)}  ->  ${money(after.a).padStart(14)}`);
    console.log(`  date     ${before.d.padStart(14)}  ->  ${after.d.padStart(14)}`);
    console.log(`  ledger   ${money(balBefore.l).padStart(14)}  ->  ${money(balAfter.l).padStart(14)}`);
    console.log(`  source   ${money(balBefore.s).padStart(14)}  ->  ${money(balAfter.s).padStart(14)}`);

    if (live) {
      await client.query('commit');
      console.log('\n  COMMITTED, and recorded in transaction_corrections.');
    } else {
      await client.query('rollback');
      console.log('\n  Rolled back — nothing was written. Re-run with --live to apply.');
    }
  } catch (e) {
    await client.query('rollback').catch(() => {});
    console.error(`\n  Refused: ${e.message}`);
    process.exit(1);
  }
} finally {
  await client.end();
}
