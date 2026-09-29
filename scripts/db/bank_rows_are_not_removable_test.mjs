/**
 * Proves that a line on a bank statement cannot be taken off the balance, and
 * that nothing else lost the ability to be resolved.
 *
 * The screens will stop drawing the button, but a button that is not drawn is
 * not a rule. What is tested here is the database refusing the call, because
 * that is the only place the refusal holds no matter where the call came from.
 *
 * Everything runs inside a transaction that is rolled back, and each attempt
 * gets its own savepoint: one raised exception poisons the whole transaction,
 * so without them the first refusal would make every later probe fail for the
 * wrong reason and the run would look like a pass.
 *
 *   LEDGER_DEPS=... node scripts/db/bank_rows_are_not_removable_test.mjs
 */

import { readFileSync } from 'node:fs';
import { connect, q } from './connect.mjs';

const MIGRATION = process.env.MIGRATION ?? 'supabase/migrations/034_a_bank_row_cannot_be_removed.sql';

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(58)}${detail}`);
};

const client = await connect();

try {
  console.log('='.repeat(100));
  console.log('A LINE ON A BANK STATEMENT CANNOT BE TAKEN OFF THE BALANCE');
  console.log('='.repeat(100) + '\n');

  const [owner] = await q(client, 'select user_id from admins where is_owner limit 1');

  // Every transaction belongs to a card. The new definition reads the card
  // alongside the row, so a row without one would now be reported as missing
  // rather than resolved — worth knowing before it is applied, not after.
  const [{ n: orphans }] = await q(
    client,
    `select count(*)::int n from transactions t
      left join cards c on c.id = t.card_id where c.id is null`,
  );
  check('every transaction belongs to a card', orphans === 0, `${orphans} without one`);

  await client.query('begin');
  await client.query(
    readFileSync(MIGRATION, 'utf8').replace(/^\s*begin;/m, '').replace(/^\s*commit;\s*$/m, ''),
  );
  await client.query('set local role authenticated');
  await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [owner.user_id]);

  const pick = async (where) =>
    (
      await q(
        client,
        `select t.id, c.name, c.card_type, t.amount_aed::float8 a, t.status
           from transactions t join cards c on c.id = t.card_id
          where ${where} and t.status <> 'voided' limit 1`,
      )
    )[0];

  const bankRow = await pick(`c.card_type = 'bank_account'`);
  const cardRow = await pick(`c.card_type <> 'bank_account'`);
  if (!bankRow || !cardRow) throw new Error('need one bank row and one card row to compare');

  console.log(`  bank row on ${bankRow.name}`);
  console.log(`  card row on ${cardRow.name}\n`);

  /** Runs one attempt on its own savepoint and says what came back. */
  const attempt = async (id, action, reason = 'testing what is allowed', question = null) => {
    await client.query('savepoint probe');
    try {
      await client.query(
        `select resolve_review_item(p_transaction_id := $1, p_action := $2,
                                   p_rationale := $3, p_review_reason := $4)`,
        [id, action, reason, question],
      );
      await client.query('rollback to savepoint probe');
      return { ok: true };
    } catch (e) {
      await client.query('rollback to savepoint probe');
      return { ok: false, message: e.message };
    }
  };

  const voidBank = await attempt(bankRow.id, 'void');
  check('removing a bank row is refused', !voidBank.ok,
        voidBank.ok ? 'it was removed' : voidBank.message.slice(0, 74));
  check('and the refusal names the account and says why',
        !voidBank.ok && voidBank.message.includes(bankRow.name) && /agree with the bank/i.test(voidBank.message),
        '');

  const voidCard = await attempt(cardRow.id, 'void');
  check('removing a card row is still allowed', voidCard.ok,
        voidCard.ok ? '' : voidCard.message.slice(0, 74));

  // The rest of the resolving a bank row needs must still work: none of it
  // moves money, and the request numbers these rows are waiting for depend on
  // being able to work through them.
  for (const [action, label] of [
    ['confirm', 'confirming'],
    ['leave_pending', 'annotating'],
  ]) {
    const r = await attempt(bankRow.id, action);
    check(`${label} a bank row still works`, r.ok, r.ok ? '' : r.message.slice(0, 74));
  }
  // Reopening has always needed the question itself, not just a reason for
  // reopening. That rule is older than this change and still holds.
  const reopen = await attempt(bankRow.id, 'reopen', 'asking a question about it',
                               'does this one have a request number?');
  check('putting a question on a bank row still works', reopen.ok,
        reopen.ok ? '' : reopen.message.slice(0, 74));

  // The reason requirement and the unknown-action guard are the rules that
  // were already there. A rewritten function that quietly dropped one would
  // pass every check above.
  const noReason = await attempt(bankRow.id, 'confirm', '   ');
  check('a resolution with no reason is still refused', !noReason.ok,
        noReason.ok ? 'it was accepted' : noReason.message.slice(0, 54));
  const nonsense = await attempt(cardRow.id, 'demolish');
  check('an action it does not recognise is still refused', !nonsense.ok,
        nonsense.ok ? 'it was accepted' : nonsense.message.slice(0, 54));

  const [{ n: stillThere }] = await q(
    client,
    `select count(*)::int n from transactions where id = $1 and status <> 'voided'`,
    [bankRow.id],
  );
  check('the bank row is still on the balance', stillThere === 1, '');

  await client.query('rollback');
  console.log('\n  Rolled back — nothing was applied.');
} finally {
  await client.end();
}

console.log('\n' + '='.repeat(100));
if (failures) { console.log(`${failures} CHECK(S) FAILED`); process.exit(1); }
console.log('Bank rows cannot be removed; everything else about them still works.');
console.log('='.repeat(100));
