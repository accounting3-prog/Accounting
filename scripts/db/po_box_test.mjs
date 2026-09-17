/**
 * The PO Box field, exercised against the real function.
 *
 * A dry run of the migration proves only that it applies and that no balance
 * moves. It does not prove the field can be set, changed, cleared, or that
 * changing it is recorded — and it does not prove the field survives an edit
 * that is about something else entirely, which is the way a quiet data loss
 * would actually happen: someone corrects an amount and the PO Box vanishes.
 *
 * Every check is made against what the database holds afterwards, read back in
 * a separate query, never against what the call returned.
 *
 * The migration is applied inside this script's own transaction and rolled
 * back, so it is safe to run before it has been applied for real.
 *
 *   LEDGER_DEPS=... node scripts/db/po_box_test.mjs
 */

import { readFile } from 'node:fs/promises';
import { connect, q } from './connect.mjs';

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(62)}${detail}`);
};

const migration = (await readFile('supabase/migrations/025_po_box.sql', 'utf8'))
  .replace(/^\s*begin\s*;\s*$/gim, '')
  .replace(/^\s*commit\s*;\s*$/gim, '');

const client = await connect();

try {
  console.log('='.repeat(92));
  console.log('PO BOX — set, changed, cleared, and left alone');
  console.log('='.repeat(92));

  // An owner, specifically. transaction_corrections is readable only by one
  // (migration 015: an editor may change a row but may not read the history),
  // and this test has to read back what it wrote.
  const [admin] = await q(
    client,
    `select user_id, email from admins where user_id is not null and is_owner limit 1`,
  );
  if (!admin) throw new Error('no owner to act as');

  await client.query('begin');
  try {
    await client.query(migration);

    /* ------------------------------------------------ the column and the shape */

    const [col] = await q(
      client,
      `select data_type, is_nullable from information_schema.columns
        where table_name = 'transactions' and column_name = 'po_box'`,
    );
    check('the column exists and is optional', col?.data_type === 'text' && col.is_nullable === 'YES',
          `${col?.data_type ?? 'missing'}`);

    // The whole reason the old signature is dropped first. Two overloads and
    // every named-argument call from the app becomes ambiguous.
    const overloads = await q(
      client,
      `select count(*)::int n from pg_proc where proname = 'update_transaction'`,
    );
    check('exactly one update_transaction, not an overloaded pair',
          overloads[0].n === 1, `${overloads[0].n} defined`);

    // Nothing else was disturbed on the way past.
    const [search] = await q(
      client,
      `select count(*)::int n from information_schema.columns
        where table_name = 'transactions' and column_name = 'search_text'`,
    );
    check('search_text is still there, untouched', search.n === 1);
    const [view] = await q(
      client,
      `select count(*)::int n from pg_views where viewname = 'transactions_searchable'`,
    );
    check('and transactions_searchable still resolves', view.n === 1);

    /* --------------------------------------------------------------- act as one */

    await client.query('set local role authenticated');
    await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [admin.user_id]);

    // A plain confirmed row with a currency, so the conversion rules are live
    // rather than bypassed — the field has to work on a real row, not an easy one.
    const [row] = await q(
      client,
      `select t.id, t.card_id, t.amount_aed::float8 amount, t.supplier_raw, t.notes,
              t.payment_ref, t.exchange_rate::float8 rate
         from transactions t
        where t.entry_type = 'source_transaction' and t.status = 'confirmed'
          and t.currency is not null and t.original_amount is not null
        order by t.txn_date desc limit 1`,
    );
    if (!row) throw new Error('no confirmed converted row to edit');
    console.log(`\n  editing: ${row.supplier_raw} · ${row.amount} AED\n`);

    const poBoxOf = async (id) =>
      (await q(client, 'select po_box from transactions where id = $1', [id]))[0].po_box;

    // created_at defaults to now(), which is frozen for the whole transaction:
    // every correction this test writes carries the same timestamp, so "the
    // latest one" is whichever the planner happens to return. The new row is
    // identified by id instead.
    const seen = new Set();
    const lastChange = async () => {
      const rows = await q(
        client,
        `select id::text, field_changes, rationale from transaction_corrections
          where transaction_id = $1`,
        [row.id],
      );
      const fresh = rows.filter((r) => !seen.has(r.id));
      rows.forEach((r) => seen.add(r.id));
      if (fresh.length !== 1) throw new Error(`expected 1 new correction, got ${fresh.length}`);
      return fresh[0];
    };

    const edit = (args) =>
      client.query(
        `select update_transaction(
            p_id := $1, p_rationale := $2, p_po_box := $3, p_payment_ref := $4)`,
        [row.id, args.why, args.poBox, args.paymentRef ?? null],
      );

    // Anything already on the row from its own history is not this test's.
    (await q(client, `select id::text from transaction_corrections where transaction_id = $1`,
             [row.id])).forEach((r) => seen.add(r.id));

    /* ----------------------------------------------------------------- set it */

    await edit({ why: 'Recording the supplier PO Box from the invoice.', poBox: ' P.O. Box 12345, Dubai ' });
    const set = await poBoxOf(row.id);
    check('a PO Box can be set', set === 'P.O. Box 12345, Dubai', `stored ${JSON.stringify(set)}`);

    const logged = await lastChange();
    const box = logged.field_changes?.po_box;
    check('setting it is recorded with its before and after',
          box != null && box.from === null && box.to === 'P.O. Box 12345, Dubai',
          `${JSON.stringify(box?.from ?? null)} -> ${JSON.stringify(box?.to)}`);
    check('and with the reason the editor gave',
          /PO Box from the invoice/.test(logged.rationale ?? ''));

    /* -------------------------------------------------------------- change it */

    await edit({ why: 'Corrected: the invoice shows 54321.', poBox: 'P.O. Box 54321, Abu Dhabi' });
    await lastChange();
    check('it can be changed', (await poBoxOf(row.id)) === 'P.O. Box 54321, Abu Dhabi');

    /* ------------------------------------------- an edit about something else */

    // The quiet failure this test exists for. Someone corrects a figure; the
    // PO Box must not disappear because the form did not mention it.
    await edit({
      why: 'Unrelated edit — the PO Box must survive it.',
      poBox: null,
      paymentRef: 'PAY-SET-BY-PO-BOX-TEST',
    });
    check('an edit that does not mention it leaves it alone',
          (await poBoxOf(row.id)) === 'P.O. Box 54321, Abu Dhabi');

    const untouched = await lastChange();
    check('and does not claim in the history that it changed',
          !('po_box' in (untouched.field_changes ?? {})),
          Object.keys(untouched.field_changes ?? {}).join(', '));

    /* --------------------------------------------------------------- clear it */

    await edit({ why: 'The PO Box was entered against the wrong supplier.', poBox: '' });
    check('an empty value clears it', (await poBoxOf(row.id)) === null);

    const cleared = (await lastChange()).field_changes?.po_box;
    check('clearing it is recorded too, not silent',
          cleared != null && cleared.from === 'P.O. Box 54321, Abu Dhabi' && cleared.to === null,
          `${JSON.stringify(cleared?.from)} -> ${JSON.stringify(cleared?.to ?? null)}`);

    /* -------------------------------------------- it is not a way past the rules */

    // A PO Box is still an edit, and an edit without a reason is refused.
    let refused = null;
    try {
      await client.query(
        `select update_transaction(p_id := $1, p_rationale := $2, p_po_box := $3)`,
        [row.id, '   ', 'P.O. Box 1'],
      );
    } catch (e) {
      refused = e.message;
    }
    check('changing only the PO Box still needs a stated reason',
          /reason is required/i.test(refused ?? ''), refused ? '' : 'IT WAS ALLOWED');
  } catch (e) {
    // A check that cannot even run is a failure, and it should read as one
    // line saying why rather than as a stack trace. Breaking this migration
    // three different ways aborts here rather than returning a wrong answer:
    // dropping the `drop function` makes the migration itself refuse to apply,
    // and mishandling the clear makes a later edit raise 'Nothing was changed'.
    failures++;
    console.log(`
  ABORTED  ${e.message}`);
  } finally {
    await client.query('rollback').catch(() => {});
  }

  /* ------------------------------- and none of it was actually written anywhere */

  const [after] = await q(
    client,
    `select count(*)::int n from information_schema.columns
      where table_name = 'transactions' and column_name = 'po_box'`,
  );
  console.log(
    `\n  rolled back — the column is ${after.n ? 'present (already applied for real)' : 'gone again'}`,
  );
} finally {
  await client.end();
}

console.log('\n' + '='.repeat(92));
if (failures) {
  console.log(`${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('A PO Box can be set, changed and cleared; every change is recorded; an');
console.log('unrelated edit leaves it standing.');
console.log('='.repeat(92));
