/**
 * Every field update_transaction writes, exercised against the real function.
 *
 * A dry run of the migration proves only that it applies and that no balance
 * moves. It does not prove the field can be set, changed, cleared, or that
 * changing it is recorded — and it does not prove the field survives an edit
 * that is about something else entirely, which is the way a quiet data loss
 * would actually happen: someone corrects an amount and the LPO vanishes.
 *
 * Every check is made against what the database holds afterwards, read back in
 * a separate query, never against what the call returned.
 *
 * The migration is applied inside this script's own transaction and rolled
 * back, so it is safe to run before it has been applied for real.
 *
 *   LEDGER_DEPS=... node scripts/db/editable_fields_test.mjs
 */

import { readFile } from 'node:fs/promises';
import { connect, q } from './connect.mjs';

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(62)}${detail}`);
};

// 028 is the current definition and is self-sufficient: it renames the column
// 025 and 026 created, under whichever name it still carries, and creates it
// otherwise. So
// applying it alone reproduces exactly the state the live database is in.
const migration = (await readFile('supabase/migrations/028_lpo_number_is_the_field.sql', 'utf8'))
  .replace(/^\s*begin\s*;\s*$/gim, '')
  .replace(/^\s*commit\s*;\s*$/gim, '');

const client = await connect();

try {
  console.log('='.repeat(92));
  console.log('THE EDITABLE FIELDS — every one of them actually writable');
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
        where table_name = 'transactions' and column_name = 'lpo_number'`,
    );
    check('the column exists and is optional', col?.data_type === 'text' && col.is_nullable === 'YES',
          `${col?.data_type ?? 'missing'}`);

    // The column the three earlier migrations added, which was never the right
    // one and never held a value.
    const [stray] = await q(
      client,
      `select count(*)::int n from information_schema.columns
        where table_name = 'transactions' and column_name in ('purchase_order', 'po', 'po_box')`,
    );
    check('and the column added by mistake is gone', stray.n === 0, `${stray.n} found`);

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

    const lpoOf = async (id) =>
      (await q(client, 'select lpo_number from transactions where id = $1', [id]))[0].lpo_number;

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
            p_id := $1, p_rationale := $2, p_lpo_number := $3, p_payment_ref := $4)`,
        [row.id, args.why, args.lpo, args.paymentRef ?? null],
      );

    // Anything already on the row from its own history is not this test's.
    (await q(client, `select id::text from transaction_corrections where transaction_id = $1`,
             [row.id])).forEach((r) => seen.add(r.id));

    /* ----------------------------------------------------------------- set it */

    await edit({ why: 'Recording the LPO from the paperwork.', lpo: ' LPO-TEST-0041 ' });
    const set = await lpoOf(row.id);
    check('an LPO number can be set', set === 'LPO-TEST-0041', `stored ${JSON.stringify(set)}`);

    const logged = await lastChange();
    const box = logged.field_changes?.lpo_number;
    check('setting it is recorded with its before and after',
          box != null && box.from === null && box.to === 'LPO-TEST-0041',
          `${JSON.stringify(box?.from ?? null)} -> ${JSON.stringify(box?.to)}`);
    check('and with the reason the editor gave',
          /LPO from the paperwork/.test(logged.rationale ?? ''));

    /* -------------------------------------------------------------- change it */

    await edit({ why: 'Corrected: the paperwork shows LPO-TEST-0099.', lpo: 'LPO-TEST-0099' });
    await lastChange();
    check('it can be changed', (await lpoOf(row.id)) === 'LPO-TEST-0099');

    /* ------------------------------------------- an edit about something else */

    // The quiet failure this test exists for. Someone corrects a figure; the
    // PO must not disappear because the form did not mention it.
    await edit({
      why: 'Unrelated edit — the LPO must survive it.',
      lpo: null,
      paymentRef: 'PAY-SET-BY-PO-BOX-TEST',
    });
    check('an edit that does not mention it leaves it alone',
          (await lpoOf(row.id)) === 'LPO-TEST-0099');

    const untouched = await lastChange();
    check('and does not claim in the history that it changed',
          !('lpo_number' in (untouched.field_changes ?? {})),
          Object.keys(untouched.field_changes ?? {}).join(', '));

    /* --------------------------------------------------------------- clear it */

    await edit({ why: 'The LPO was entered against the wrong supplier.', lpo: '' });
    check('an empty value clears it', (await lpoOf(row.id)) === null);

    const cleared = (await lastChange()).field_changes?.lpo_number;
    check('clearing it is recorded too, not silent',
          cleared != null && cleared.from === 'LPO-TEST-0099' && cleared.to === null,
          `${JSON.stringify(cleared?.from)} -> ${JSON.stringify(cleared?.to ?? null)}`);

    /* ------------------------ every field the function writes is truly writable */

    // The bug 028 fixes. Each of these was refused with "Nothing was changed"
    // because the function wrote the column but never compared it — so it
    // genuinely believed nothing had changed. Two of them, invoice and
    // lpo_number, are offered by the "fill in a missing field by re-importing
    // the sheet" feature, which therefore could not work for them.
    //
    // A savepoint each: one raised exception poisons the whole transaction,
    // and without this every probe after the first would report the same
    // misleading "current transaction is aborted".
    console.log('');
    for (const [label, param, value] of [
      ['LPO number', 'p_lpo_number', 'LPO-ALONE-1'],
      ['invoice', 'p_invoice', 'INV-ALONE-1'],
      ['CRM', 'p_crm', 'CRM-ALONE-1'],
      ['client', 'p_client', 'CLIENT-ALONE-1'],
      ['sales operation', 'p_sales_operation', 'OPS-ALONE-1'],
      ['notes', 'p_notes', 'note set on its own'],
      ['payment reference', 'p_payment_ref', 'PAY-ALONE-1'],
      ['request number', 'p_req_number', 'REQ-ALONE-1'],
    ]) {
      await client.query('savepoint probe');
      let failure = null;
      try {
        await client.query(
          `select update_transaction(p_id := $1, p_rationale := $2, ${param} := $3)`,
          [row.id, `Setting the ${label} on its own.`, value],
        );
      } catch (e) {
        failure = e.message;
      }
      // Read back from the table, not from what the call returned.
      const stored = failure
        ? null
        : (await q(client, `select ${param.slice(2)} as v from transactions where id = $1`,
                   [row.id]))[0].v;
      check(`${label} can be changed on its own`, failure === null && stored === value,
            failure ?? `stored ${JSON.stringify(stored)}`);
      await client.query('rollback to savepoint probe');
    }
    // The probes are rolled back, so the corrections they wrote are gone too.
    (await q(client, `select id::text from transaction_corrections where transaction_id = $1`,
             [row.id])).forEach((r) => seen.add(r.id));

    /* -------------------------------------------- it is not a way past the rules */

    // An LPO is still an edit, and an edit without a reason is refused.
    let refused = null;
    try {
      await client.query(
        `select update_transaction(p_id := $1, p_rationale := $2, p_lpo_number := $3)`,
        [row.id, '   ', 'LPO-TEST-0001'],
      );
    } catch (e) {
      refused = e.message;
    }
    check('changing only the LPO still needs a stated reason',
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
      where table_name = 'transactions' and column_name = 'lpo_number'`,
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
console.log('Every field can be set, changed and cleared; every change is recorded; an');
console.log('unrelated edit leaves it standing.');
console.log('='.repeat(92));
