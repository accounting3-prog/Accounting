/**
 * Every reference that can be typed in can be taken out again — and taking one
 * out leaves the rest of the row alone.
 *
 * The bug this covers: clearing a request number was answered with "Nothing
 * was changed" while the field was plainly empty on screen and the value was
 * plainly still in the ledger. Two faults met there. The database folded "not
 * supplied" and "supplied as empty" into one, so an emptied box was
 * indistinguishable from a box nobody touched; and the edit screen sent null
 * for an emptied box, so even the two fields that could be cleared were not
 * clearable from the screen built to clear them.
 *
 * So each field is tested three ways — set it, clear it, leave it out — and
 * the third is what keeps the fix from becoming a new bug: a field that is not
 * sent must still be left exactly as it was, or filling in a request number
 * through the import would wipe every other reference on the row.
 *
 * Each probe runs on its own savepoint: one raised exception poisons the whole
 * transaction, so without them the first refusal would make every later probe
 * fail for the wrong reason.
 *
 *   LEDGER_DEPS=... node scripts/db/clearing_a_reference_test.mjs
 */

import { readFileSync } from 'node:fs';
import { connect, q } from './connect.mjs';

const MIGRATION = process.env.MIGRATION ?? 'supabase/migrations/035_a_reference_can_be_removed.sql';

/** Each editable reference, and the column it lands in. */
const FIELDS = [
  ['p_req_number', 'req_number'],
  ['p_payment_ref', 'payment_ref'],
  ['p_lpo_number', 'lpo_number'],
  ['p_invoice', 'invoice'],
  ['p_crm', 'crm'],
  ['p_client', 'client'],
  ['p_sales_operation', 'sales_operation'],
  ['p_notes', 'notes'],
];

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(56)}${detail}`);
};

const client = await connect();

try {
  console.log('='.repeat(100));
  console.log('A REFERENCE THAT CAN BE TYPED IN CAN BE TAKEN OUT AGAIN');
  console.log('='.repeat(100) + '\n');

  const [owner] = await q(client, 'select user_id from admins where is_owner limit 1');

  await client.query('begin');
  await client.query(
    readFileSync(MIGRATION, 'utf8').replace(/^\s*begin;/m, '').replace(/^\s*commit;\s*$/m, ''),
  );
  await client.query('set local role authenticated');
  await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [owner.user_id]);

  // A card row, so nothing here depends on the bank rules added alongside it.
  const [row] = await q(
    client,
    `select t.id, c.name from transactions t join cards c on c.id = t.card_id
      where c.card_type <> 'bank_account' and t.status <> 'voided'
        and t.entry_type = 'source_transaction' limit 1`,
  );
  if (!row) throw new Error('no ordinary card transaction to test against');
  console.log(`  working on one row of ${row.name}\n`);

  /** One call, on its own savepoint, reporting what came back. */
  const edit = async (args) => {
    const names = Object.keys(args);
    const call = `select update_transaction(p_id := $1, p_rationale := $2${names
      .map((n, i) => `, ${n} := $${i + 3}`)
      .join('')})`;
    await client.query('savepoint probe');
    try {
      await client.query(call, [row.id, 'testing that references can be cleared',
                                ...names.map((n) => args[n])]);
      return { ok: true };
    } catch (e) {
      await client.query('rollback to savepoint probe');
      return { ok: false, message: e.message };
    }
  };

  const read = async () =>
    (
      await q(
        client,
        `select ${FIELDS.map(([, c]) => c).join(', ')},
                to_char(txn_date,'YYYY-MM-DD') d, amount_aed::float8 a, supplier_raw
           from transactions where id = $1`,
        [row.id],
      )
    )[0];

  const before = await read();

  for (const [param, column] of FIELDS) {
    const value = `TEST-${column.toUpperCase()}`;

    const set = await edit({ [param]: value });
    const afterSet = set.ok ? await read() : null;
    check(`${column}: a value can be written`,
          set.ok && afterSet[column] === value,
          set.ok ? '' : set.message.slice(0, 50));

    // The point of the whole exercise.
    const cleared = await edit({ [param]: '' });
    const afterClear = cleared.ok ? await read() : null;
    check(`${column}: and taken out again`,
          cleared.ok && afterClear[column] === null,
          cleared.ok ? '' : cleared.message.slice(0, 50));

    // Clearing it twice is genuinely no change, and saying so is right.
    const again = await edit({ [param]: '' });
    check(`${column}: clearing an empty one says nothing changed`,
          !again.ok && /Nothing was changed/i.test(again.message ?? ''),
          again.ok ? 'it reported a change' : '');
  }

  /* ------------------ a field that is not sent must not be touched */

  const seeded = {};
  for (const [param, column] of FIELDS) seeded[param] = `KEEP-${column}`;
  await edit(seeded);
  const full = await read();
  check('every reference can be set at once',
        FIELDS.every(([, c]) => full[c] === `KEEP-${c}`), '');

  // This is how the import fills in request numbers: one field, nothing else.
  const single = await edit({ p_req_number: 'ONLY-THIS-ONE' });
  const after = await read();
  check('sending one field changes only that field',
        single.ok && after.req_number === 'ONLY-THIS-ONE' &&
          FIELDS.filter(([, c]) => c !== 'req_number').every(([, c]) => after[c] === `KEEP-${c}`),
        single.ok ? '' : single.message.slice(0, 50));

  check('and it moves no date, amount or supplier',
        after.d === before.d && Math.abs(after.a - before.a) < 0.005 &&
          after.supplier_raw === before.supplier_raw,
        '');

  /* --------------------------------- the removal is in the history */

  const history = await q(
    client,
    `select field_changes from transaction_corrections
      where transaction_id = $1 order by created_at desc limit 40`,
    [row.id],
  );
  const recordedRemoval = history.some((h) =>
    Object.values(h.field_changes ?? {}).some((c) => c.to === null && c.from !== null),
  );
  check('a removal is recorded with a "to" of nothing', recordedRemoval,
        recordedRemoval ? 'as traceable as setting one' : 'no removal was written down');

  await client.query('rollback');
  console.log('\n  Rolled back — the row is as it was.');
} finally {
  await client.end();
}

console.log('\n' + '='.repeat(100));
if (failures) { console.log(`${failures} CHECK(S) FAILED`); process.exit(1); }
console.log('Every reference can be set, cleared, and left alone when it is not sent.');
console.log('='.repeat(100));
