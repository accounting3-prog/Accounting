/**
 * The purchase order field, exercised against the real function.
 *
 * A dry run of the migration proves only that it applies and that no balance
 * moves. It does not prove the field can be set, changed, cleared, or that
 * changing it is recorded — and it does not prove the field survives an edit
 * that is about something else entirely, which is the way a quiet data loss
 * would actually happen: someone corrects an amount and the purchase order vanishes.
 *
 * Every check is made against what the database holds afterwards, read back in
 * a separate query, never against what the call returned.
 *
 * The migration is applied inside this script's own transaction and rolled
 * back, so it is safe to run before it has been applied for real.
 *
 *   LEDGER_DEPS=... node scripts/db/purchase_order_test.mjs
 */

import { readFile } from 'node:fs/promises';
import { connect, q } from './connect.mjs';

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(62)}${detail}`);
};

// 027 is the current definition and is self-sufficient: it renames the column
// 025 and 026 created, under whichever name it still carries, and creates it
// otherwise. So
// applying it alone reproduces exactly the state the live database is in.
const migration = (await readFile('supabase/migrations/027_purchase_order.sql', 'utf8'))
  .replace(/^\s*begin\s*;\s*$/gim, '')
  .replace(/^\s*commit\s*;\s*$/gim, '');

const client = await connect();

try {
  console.log('='.repeat(92));
  console.log('PURCHASE ORDER — set, changed, cleared, and left alone');
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
        where table_name = 'transactions' and column_name = 'purchase_order'`,
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

    const purchaseOrderOf = async (id) =>
      (await q(client, 'select purchase_order from transactions where id = $1', [id]))[0].purchase_order;

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
            p_id := $1, p_rationale := $2, p_purchase_order := $3, p_payment_ref := $4)`,
        [row.id, args.why, args.purchaseOrder, args.paymentRef ?? null],
      );

    // Anything already on the row from its own history is not this test's.
    (await q(client, `select id::text from transaction_corrections where transaction_id = $1`,
             [row.id])).forEach((r) => seen.add(r.id));

    /* ----------------------------------------------------------------- set it */

    await edit({ why: 'Recording the purchase order from the invoice.', purchaseOrder: ' PO-2026-0041 ' });
    const set = await purchaseOrderOf(row.id);
    check('a purchase order can be set', set === 'PO-2026-0041', `stored ${JSON.stringify(set)}`);

    const logged = await lastChange();
    const box = logged.field_changes?.purchase_order;
    check('setting it is recorded with its before and after',
          box != null && box.from === null && box.to === 'PO-2026-0041',
          `${JSON.stringify(box?.from ?? null)} -> ${JSON.stringify(box?.to)}`);
    check('and with the reason the editor gave',
          /purchase order from the invoice/.test(logged.rationale ?? ''));

    /* -------------------------------------------------------------- change it */

    await edit({ why: 'Corrected: the invoice shows PO-2026-0099.', purchaseOrder: 'PO-2026-0099' });
    await lastChange();
    check('it can be changed', (await purchaseOrderOf(row.id)) === 'PO-2026-0099');

    /* ------------------------------------------- an edit about something else */

    // The quiet failure this test exists for. Someone corrects a figure; the
    // PO must not disappear because the form did not mention it.
    await edit({
      why: 'Unrelated edit — the purchase order must survive it.',
      purchaseOrder: null,
      paymentRef: 'PAY-SET-BY-PO-BOX-TEST',
    });
    check('an edit that does not mention it leaves it alone',
          (await purchaseOrderOf(row.id)) === 'PO-2026-0099');

    const untouched = await lastChange();
    check('and does not claim in the history that it changed',
          !('purchase_order' in (untouched.field_changes ?? {})),
          Object.keys(untouched.field_changes ?? {}).join(', '));

    /* --------------------------------------------------------------- clear it */

    await edit({ why: 'The purchase order was entered against the wrong supplier.', purchaseOrder: '' });
    check('an empty value clears it', (await purchaseOrderOf(row.id)) === null);

    const cleared = (await lastChange()).field_changes?.purchase_order;
    check('clearing it is recorded too, not silent',
          cleared != null && cleared.from === 'PO-2026-0099' && cleared.to === null,
          `${JSON.stringify(cleared?.from)} -> ${JSON.stringify(cleared?.to ?? null)}`);

    /* -------------------------------------------- it is not a way past the rules */

    // A purchase order is still an edit, and an edit without a reason is refused.
    let refused = null;
    try {
      await client.query(
        `select update_transaction(p_id := $1, p_rationale := $2, p_purchase_order := $3)`,
        [row.id, '   ', 'PO-2026-0001'],
      );
    } catch (e) {
      refused = e.message;
    }
    check('changing only the purchase order still needs a stated reason',
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
      where table_name = 'transactions' and column_name = 'purchase_order'`,
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
console.log('A purchase order can be set, changed and cleared; every change is recorded; an');
console.log('unrelated edit leaves it standing.');
console.log('='.repeat(92));
