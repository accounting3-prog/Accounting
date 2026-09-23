/**
 * Bank charges carry BAC without anyone typing it.
 *
 * A charge is the bank billing the account for moving money — every transfer
 * is followed by one — and it is classified the same way every time. Typing
 * BAC 900 times is not a decision anyone is making; it is a fact of the row,
 * and it is what "filter by BAC and see what the bank cost us" depends on.
 *
 * WHAT IT WILL NOT DO
 *
 * Overwrite a reference someone already put there. Three charge rows carry a
 * real request number, which means a person looked at them and decided; that
 * decision stands. Only rows with no reference at all are filled in.
 *
 * WHICH ROWS COUNT AS A CHARGE
 *
 * The first line of the bank's own narrative, which is the transaction type it
 * assigns: CHARGES, or CHARGES AND FEES. The workbook also contains rows whose
 * first character was lost in a paste — HARGES, RANSFER, ADAD PAYMENT — so the
 * leading C is optional. Nothing else is treated as a charge: a transfer that
 * happens to mention a fee in its body is not one.
 *
 *   LEDGER_DEPS=... node scripts/db/mark_bank_charges.mjs [--live]
 */

import { connect, q } from './connect.mjs';

const live = process.argv.includes('--live');
const money = (n) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(58)}${detail}`);
};

// The same expression the importer uses, so a row imported tomorrow is
// classified exactly as one imported today.
const CHARGE_FIRST_LINE = "split_part(supplier_raw, E'\\n', 1) ~* '^\\s*c?harges( and fees)?\\s*$'";

const client = await connect();

try {
  console.log('='.repeat(96));
  console.log(`${live ? 'LIVE' : 'DRY RUN'}  bank charges marked BAC`);
  console.log('='.repeat(96));

  const [owner] = await q(client, 'select user_id from admins where is_owner limit 1');
  const accounts = await q(
    client,
    `select id, name, settlement_currency from cards where card_type = 'bank_account'`,
  );
  if (!accounts.length) throw new Error('no bank accounts in the ledger');

  await client.query('begin');
  await client.query('set local role authenticated');
  await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [owner.user_id]);

  for (const account of accounts) {
    const before = await q(
      client,
      `select
         count(*) filter (where ${CHARGE_FIRST_LINE})::int charges,
         count(*) filter (where ${CHARGE_FIRST_LINE} and upper(coalesce(req_number,'')) = 'BAC')::int marked,
         count(*) filter (where ${CHARGE_FIRST_LINE} and coalesce(btrim(req_number),'') = '')::int blank,
         count(*) filter (where ${CHARGE_FIRST_LINE} and coalesce(btrim(req_number),'') <> ''
                          and upper(req_number) <> 'BAC')::int already_referenced
       from transactions where card_id = $1 and status <> 'voided'`,
      [account.id],
    );
    const b = before[0];
    console.log(`\n  ${account.name}`);
    console.log(`    ${b.charges} charge rows: ${b.marked} already BAC, ${b.blank} unmarked, ` +
                `${b.already_referenced} carrying a reference of their own`);

    // Left alone, and said out loud rather than passed over.
    if (b.already_referenced) {
      console.log('\n    these keep the reference a person gave them:');
      for (const r of await q(
        client,
        `select to_char(txn_date,'YYYY-MM-DD') d, amount_aed::float8 a, req_number
           from transactions where card_id = $1 and status <> 'voided' and ${CHARGE_FIRST_LINE}
            and coalesce(btrim(req_number),'') <> '' and upper(req_number) <> 'BAC'`,
        [account.id],
      )) console.log(`      ${r.d}  ${money(r.a).padStart(12)}  ${r.req_number}`);
    }

    const updated = await q(
      client,
      `update transactions set req_number = 'BAC', updated_at = now()
        where card_id = $1 and status <> 'voided'
          and ${CHARGE_FIRST_LINE}
          and coalesce(btrim(req_number), '') = ''
        returning id`,
      [account.id],
    );
    console.log(`\n    ${updated.length} rows marked`);

    const after = await q(
      client,
      `select
         count(*) filter (where ${CHARGE_FIRST_LINE} and coalesce(btrim(req_number),'') = '')::int still_blank,
         count(*) filter (where upper(coalesce(req_number,'')) = 'BAC')::int bac_rows,
         coalesce(sum(-amount_aed) filter (where upper(coalesce(req_number,'')) = 'BAC'), 0)::float8 bac_total,
         count(*) filter (where not (${CHARGE_FIRST_LINE}) and upper(coalesce(req_number,'')) = 'BAC')::int bac_not_charges
       from transactions where card_id = $1 and status <> 'voided'`,
      [account.id],
    );
    const a = after[0];
    check('every charge row now carries BAC', a.still_blank === 0, `${a.still_blank} still blank`);
    check('filtering BAC gives the bank\'s cost for this account', a.bac_rows > 0,
          `${a.bac_rows} rows, ${money(a.bac_total)} ${account.settlement_currency}`);
    console.log(`    (${a.bac_not_charges} rows marked BAC are not charge rows — marked by hand in the source, left as they are)`);

    // The classification is a label. It must not have moved any money.
    const [bal] = await q(
      client,
      `select ledger_balance::text l, transaction_count::int n from card_balances where card_id = $1`,
      [account.id],
    );
    console.log(`    balance ${bal.l} ${account.settlement_currency} over ${bal.n} rows`);
  }

  const [{ n: cardRowsTouched }] = await q(
    client,
    `select count(*)::int n from transactions t join cards c on c.id = t.card_id
      where coalesce(c.card_type,'') <> 'bank_account' and upper(coalesce(t.req_number,'')) = 'BAC'`,
  );
  check('no payment card was touched', cardRowsTouched === 0, `${cardRowsTouched} card rows say BAC`);

  if (live && failures === 0) {
    await client.query('commit');
    console.log('\n  COMMITTED.');
  } else {
    await client.query('rollback');
    console.log(failures ? '\n  Rolled back — checks failed.' : '\n  Rolled back — re-run with --live.');
  }
} finally {
  await client.end();
}

console.log('\n' + '='.repeat(96));
if (failures) { console.log(`${failures} CHECK(S) FAILED`); process.exit(1); }
console.log('Every bank charge is labelled, and nothing a person decided was overwritten.');
console.log('='.repeat(96));
