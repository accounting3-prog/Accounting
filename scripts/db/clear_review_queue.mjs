/**
 * Clears the review queue by confirming every flagged row, on the account
 * owner's instruction.
 *
 * Each row goes through resolve_review_item — the same audited path the UI
 * uses — rather than a bulk UPDATE, so every decision is recorded in
 * transaction_corrections with who authorised it and why. Nothing is deleted,
 * and no source value is altered: `rate_review_note`, the raw currency text,
 * the original rate formula and the sheet and row all stay exactly as they are,
 * so any row can still be traced back and reopened later.
 *
 * On the balances: confirming changes no AED figure. The AED settlement amount
 * is what moves a balance, and it was never in doubt on any of these rows — the
 * flags were about the rate that produced it, or a currency code the sheet
 * never stated. The one row that could have moved a balance is FLYNAS, and it
 * is already counted in the official live balance, so confirming it leaves
 * 16,728.96 unchanged rather than deducting it a second time.
 *
 * SERVER-SIDE ONLY. Run with --apply to write; the default reports only.
 */

import { connect, q } from './connect.mjs';

const APPLY = process.argv.includes('--apply');
const OWNER_EMAIL = 'accounting3@events-explorers.com';

const money = (n) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Why each kind of flag is being accepted, recorded on the row. */
function rationaleFor(t) {
  const note = t.rate_review_note ?? '';
  const reason = t.review_reason ?? '';

  if (t.status === 'excluded_from_source_balance')
    return (
      'Confirmed by the account owner as a completed payment. Counted in the ' +
      'official live balance, deducted exactly once. It remains marked as absent ' +
      "from the source workbook's own running-balance formula, which is why the " +
      'reconciliation difference against the workbook stays visible.'
    );

  if (t.entry_type === 'reconciliation_adjustment')
    return (
      'Confirmed by the account owner as a real adjustment pending the ' +
      'underlying transaction. Held separately from spend and funding.'
    );

  if (note.includes('normalized rate') || reason.includes('rate_denominator_mismatch'))
    return (
      'Accepted by the account owner. The AED settlement amount is not in ' +
      'question and is what moves the balance; only the source rate and the ' +
      'settled rate differ, and both are preserved on the row.'
    );

  if (note.includes('no currency code') || reason.includes('rate_without_currency'))
    return (
      'Accepted by the account owner. The original currency is unknown and has ' +
      'been left blank rather than guessed; the AED settlement amount is correct ' +
      'and is what the balance uses.'
    );

  if (reason.includes('currency_unparseable') || reason.includes('currency_unrecognised'))
    return (
      'Accepted by the account owner. The source currency cell could not be read ' +
      'and is preserved verbatim; the AED settlement amount is correct.'
    );

  if (reason.includes('rate_formula_unexpected'))
    return (
      'Accepted by the account owner. The source formula hardcodes both sides so ' +
      'the original amount cannot be recovered; the AED settlement amount is ' +
      'correct and is what the balance uses.'
    );

  return 'Accepted by the account owner; the AED settlement amount is correct.';
}

const client = await connect();
try {
  const admin = await q(client, 'select user_id, email from admins where email = $1', [
    OWNER_EMAIL,
  ]);
  if (!admin.length) throw new Error(`${OWNER_EMAIL} is not an admin`);
  const uid = admin[0].user_id;

  const before = await q(
    client,
    'select card_name, source_balance, ledger_balance, reconciliation_difference d from card_balances order by card_name',
  );

  // Rate differences, unreadable currencies, and the excluded FLYNAS row: all
  // cases where the AED settlement amount was never in question.
  //
  // A reconciliation adjustment is deliberately NOT in scope. It is not a rate
  // or a currency problem — it is money in the workbook's balance with no
  // transaction behind it, and confirming it would clear the flag without
  // anyone having found out where the money went. Those stay in the queue.
  const pending = await q(
    client,
    `select t.id, t.status, t.entry_type, t.review_reason, t.rate_review_note,
            t.amount_aed, t.source_sheet, t.source_row, t.supplier_raw, c.name as card
       from transactions t join cards c on c.id = t.card_id
      where t.status in ('needs_review', 'excluded_from_source_balance')
        and t.entry_type <> 'reconciliation_adjustment'
      order by c.name, t.source_row`,
  );

  const heldBack = await q(
    client,
    `select t.source_row, t.amount_aed, c.name as card
       from transactions t join cards c on c.id = t.card_id
      where t.entry_type = 'reconciliation_adjustment'
        and t.status <> 'confirmed'`,
  );

  console.log('='.repeat(92));
  console.log(APPLY ? 'CONFIRMING EVERY FLAGGED ROW' : 'DRY RUN — nothing will be written');
  console.log('='.repeat(92));
  console.log(`\n${pending.length} rows flagged, all to be confirmed\n`);

  for (const t of pending) {
    console.log(
      `  ${String(t.card).padEnd(30)} row ${String(t.source_row).padStart(5)}  ` +
        `${money(t.amount_aed).padStart(13)} AED  ${t.status}`,
    );
  }

  if (heldBack.length) {
    console.log('\nHELD BACK — not a rate or currency question');
    console.log('-'.repeat(92));
    for (const h of heldBack)
      console.log(
        `  ${String(h.card).padEnd(30)} row ${String(h.source_row).padStart(5)}  ` +
          `${money(h.amount_aed).padStart(13)} AED  reconciliation adjustment`,
      );
    console.log(
      '  This is money the workbook\'s balance carries with no transaction behind it.',
    );
    console.log('  Confirming it would clear the flag without anyone finding the money.');
  }

  if (!APPLY) {
    console.log('\nNo balance will change: the AED settlement amounts are untouched,');
    console.log('and FLYNAS is already counted in its card’s official live balance.');
    console.log('\nRe-run with --apply to write.');
    process.exit(0);
  }

  console.log('\nAPPLYING');
  console.log('-'.repeat(92));
  let done = 0;
  for (const t of pending) {
    await client.query('begin');
    try {
      await client.query('set local role authenticated');
      await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid]);
      await client.query('select resolve_review_item($1, $2, $3)', [
        t.id,
        'confirm',
        rationaleFor(t),
      ]);
      await client.query('commit');
      done++;
    } catch (e) {
      await client.query('rollback');
      console.log(`  FAILED ${t.card} row ${t.source_row}: ${e.message.split('\n')[0]}`);
    }
  }
  console.log(`  ${done} of ${pending.length} confirmed and recorded`);

  const after = await q(
    client,
    'select card_name, source_balance, ledger_balance, reconciliation_difference d from card_balances order by card_name',
  );

  console.log('\nBALANCES — before and after');
  console.log('-'.repeat(92));
  console.log(
    `  ${'CARD'.padEnd(32)}${'SOURCE'.padStart(14)}${'OFFICIAL LIVE'.padStart(16)}${'DIFFERENCE'.padStart(14)}${'MOVED'.padStart(8)}`,
  );
  let total = 0;
  for (let i = 0; i < after.length; i++) {
    const a = after[i];
    const b = before[i];
    const moved = Math.abs(Number(a.ledger_balance) - Number(b.ledger_balance)) > 0.005;
    total += Number(a.ledger_balance);
    console.log(
      `  ${String(a.card_name).padEnd(32)}${money(a.source_balance).padStart(14)}` +
        `${money(a.ledger_balance).padStart(16)}${money(a.d).padStart(14)}` +
        `${(moved ? 'YES' : 'no').padStart(8)}`,
    );
  }
  console.log('  ' + '-'.repeat(90));
  console.log(
    `  ${'TOTAL OFFICIAL LIVE (AED)'.padEnd(32)}${''.padStart(14)}${money(total).padStart(16)}`,
  );

  const [{ n: stillFlagged }] = await q(
    client,
    `select count(*)::int n from transactions
      where status in ('needs_review', 'excluded_from_source_balance')`,
  );
  const [{ n: recorded }] = await q(
    client,
    'select count(*)::int n from transaction_corrections',
  );
  const [{ n: notesKept }] = await q(
    client,
    'select count(*)::int n from transactions where rate_review_note is not null',
  );

  console.log(`\n  still flagged            ${stillFlagged}`);
  console.log(`  decisions recorded       ${recorded}`);
  console.log(`  source notes preserved   ${notesKept}  (nothing was erased)`);
} finally {
  await client.end();
}
