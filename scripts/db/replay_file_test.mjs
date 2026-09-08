/**
 * Replays a real uploaded file through the real import path, and checks that
 * the ledger ends up on the balance the sheet itself computed.
 *
 * Built from a file that went wrong: 36 rows in, 31 transactions out, and a
 * balance 64,297.17 above the 838,390.25 the sheet's own formulas reached. The
 * five rows that vanished did so silently — every one of them was reported to
 * the browser as a success.
 *
 * The check that matters is the last one. Not "did the rows import" but "does
 * the ledger now say what the sheet says", because that is the question the
 * person uploading it is actually asking.
 *
 *   LEDGER_DEPS=... FFLATE_DIR=... IMPORT_BUNDLE=... \
 *     node scripts/db/replay_file_test.mjs "<path to .xlsx>" <expected closing balance>
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path, { resolve } from 'node:path';
import { connect, q } from './connect.mjs';

const FILE =
  process.argv[2] ??
  'C:\\Users\\LE.Andrew\\Downloads\\AMEX 4000 VPAY — blank sheet (1) (1).xlsx';
const EXPECTED = Number(process.argv[3] ?? 838390.25);
const CARD = process.env.REPLAY_CARD ?? 'AMEX 4000 VPAY';

const { parseXlsx, analyseSheet, buildRows } = await import(
  pathToFileURL(resolve(process.env.IMPORT_BUNDLE ?? 'web/src/lib/importFile.ts')).href
);

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(58)}${detail}`);
};
const money = (n) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const cardFromDb = (row) => ({
  id: row.card_id,
  name: row.card_name,
  settlementCurrency: row.settlement_currency,
  openingBalance: Number(row.opening_balance),
  openingDate: row.opening_date ? String(row.opening_date).slice(0, 10) : null,
  lastTransaction: null,
  sourceBalance: Number(row.source_balance),
  ledgerBalance: Number(row.ledger_balance),
  reconciliationDifference: Number(row.reconciliation_difference),
  balanceSign: Number(row.balance_sign) === -1 ? -1 : 1,
  totalSpend: 0,
  totalFunding: 0,
  reviewAdjustmentsTotal: 0,
  needsReview: 0,
  excluded: 0,
  transactionCount: Number(row.transaction_count),
  sourceHeaderRow: row.source_header_row ?? 1,
  decreasingColumn: row.decreasing_column ?? 'D',
  decreasingHeader: row.decreasing_header ?? 'DEBIT',
  increasingColumn: row.increasing_column ?? 'E',
  increasingHeader: row.increasing_header ?? 'CREDIT',
  balanceFormula: row.balance_formula ?? '',
  headerIsMisleading: /credit/i.test(row.decreasing_header ?? ''),
  verifiedRows: 0,
});

const client = await connect();

try {
  const [owner] = await q(client, 'select user_id from admins where is_owner limit 1');
  const [cardRow] = await q(
    client,
    `select b.*, c.source_header_row, c.decreasing_column, c.decreasing_header,
            c.increasing_column, c.increasing_header, c.balance_formula
       from card_balances b join cards c on c.id = b.card_id where b.card_name = $1`,
    [CARD],
  );
  const card = cardFromDb(cardRow);

  console.log('='.repeat(92));
  console.log(`REPLAYING ${path.basename(FILE)}`);
  console.log('='.repeat(92));

  const sheets = parseXlsx(new Uint8Array(readFileSync(FILE)));
  const sheet = sheets[0];
  const analysis = analyseSheet(sheet, card);

  await client.query('begin');

  // A clean run: the card as it was before this file was ever uploaded. Done
  // as the table owner, because the history is append-only to everyone else —
  // the authenticated role has no delete policy on it, which is the point.
  // The whole transaction is rolled back at the end regardless.
  await client.query(
    `delete from transaction_corrections where transaction_id in
       (select id from transactions where card_id = $1 and source_sheet is null)`,
    [card.id],
  );
  await client.query(
    'delete from transactions where card_id = $1 and source_sheet is null',
    [card.id],
  );

  await client.query('set local role authenticated');
  await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [owner.user_id]);
  const [{ ledger_balance: startBal }] = await q(
    client,
    'select ledger_balance::text from card_balances where card_id = $1',
    [card.id],
  );
  console.log(`  card starts at ${money(startBal)} AED\n`);

  const existing = await q(
    client,
    `select id, card_id as "cardId", to_char(txn_date,'YYYY-MM-DD') as txn_date,
            supplier_raw as supplier, amount_aed::float8 as amount_aed, payment_ref, req_number
       from transactions where card_id = $1 and status <> 'voided'`,
    [card.id],
  );
  const rows = buildRows(sheet, analysis.headerRow, analysis.mapping, {
    dayFirst: analysis.dayFirst,
    existing,
    cardId: card.id,
  });
  const real = rows.filter((r) => r.date || r.amountAed !== null);
  check('the file parses to the rows it contains', real.length === 36, `${real.length} rows`);

  const ready = real.filter((r) => r.errors.length === 0 && r.include !== false);
  check('all of them are ready to import', ready.length === real.length,
        `${ready.length} of ${real.length}`);

  /* --------------------------------------------------- import them, in order */

  const seenIds = new Map();
  const dropped = new Set();
  const outcomes = [];
  let n = 0;
  for (const row of ready) {
    // Each row gets a savepoint. In the browser every call is its own
    // transaction, so one refusal does not stop the next row; here they share
    // one, and without this the first refusal would poison the rest and the
    // run would look far worse than it really is.
    const sp = `row_${++n}`;
    await client.query(`savepoint ${sp}`);
    try {
      const r = await client.query(
        `select create_transaction(
           p_card_id := $1, p_txn_date := $2, p_kind := $3, p_amount_aed := $4,
           p_supplier := $5, p_req_number := $6, p_payment_ref := $7,
           p_currency := $8, p_original_amount := $9, p_exchange_rate := $10,
           p_notes := $11, p_needs_review := $12, p_allow_duplicate := $13) as id`,
        [
          card.id, row.date, row.kind, Math.abs(row.amountAed), row.supplier,
          row.reqNumber, row.paymentRef?.trim() || null,
          row.currency, row.originalAmount, row.rate,
          `replayed row ${row.sourceRow}`,
          row.warnings.length > 0,
          Boolean(row.duplicateOf || row.repeatOfRow),
        ],
      );
      const id = r.rows[0].id;
      await client.query(`release savepoint ${sp}`);
      outcomes.push({ row, ok: true, id, reused: seenIds.has(id) });
      if (!seenIds.has(id)) seenIds.set(id, row.sourceRow);
    } catch (e) {
      await client.query(`rollback to savepoint ${sp}`);
      outcomes.push({ row, ok: false, error: e.message.split('\n')[0] });
    }
  }

  const wrote = outcomes.filter((o) => o.ok && !o.reused);
  const reused = outcomes.filter((o) => o.ok && o.reused);
  const refused = outcomes.filter((o) => !o.ok);

  console.log(`  attempted ${ready.length}   wrote ${wrote.length}   ` +
              `returned an existing row ${reused.length}   refused ${refused.length}\n`);

  for (const o of reused)
    console.log(`    row ${String(o.row.sourceRow).padStart(2)}  ${o.row.supplier.slice(0, 30).padEnd(32)}` +
                `${money(o.row.amountAed).padStart(12)}  -> reported success, wrote nothing ` +
                `(same row as sheet row ${seenIds.get(o.id)})`);
  for (const o of refused)
    console.log(`    row ${String(o.row.sourceRow).padStart(2)}  ${o.row.supplier.slice(0, 30).padEnd(32)}` +
                `${money(o.row.amountAed).padStart(12)}  -> ${o.error}`);

  /* ------------------------------------------------------------- the verdict */

  console.log('');
  check('nothing was silently swallowed', reused.length === 0,
        `${reused.length} row(s) reported as imported that wrote nothing`);
  check('nothing was refused', refused.length === 0, refused[0]?.error ?? '');
  check('a transaction exists for every row of the file',
        wrote.length === real.length, `${wrote.length} of ${real.length}`);

  const [{ ledger_balance: endBal }] = await q(
    client,
    'select ledger_balance::text from card_balances where card_id = $1',
    [card.id],
  );
  check(
    `the ledger lands on the balance the sheet computed`,
    Math.abs(Number(endBal) - EXPECTED) < 0.005,
    `ledger ${money(endBal)}, sheet ${money(EXPECTED)}, out by ${money(Number(endBal) - EXPECTED)}`,
  );

  /* ------------------------------------- 2. the same file, uploaded again */

  console.log('\n  the same file a second time, against the ledger it just filled');
  console.log('  ' + '-'.repeat(88));

  const nowInLedger = async () =>
    q(
      client,
      `select id, card_id as "cardId", to_char(txn_date,'YYYY-MM-DD') as txn_date,
              supplier_raw as supplier, amount_aed::float8 as amount_aed, payment_ref, req_number
         from transactions where card_id = $1 and status <> 'voided'`,
      [card.id],
    );

  const second = buildRows(sheet, analysis.headerRow, analysis.mapping, {
    dayFirst: analysis.dayFirst,
    existing: await nowInLedger(),
    cardId: card.id,
  }).filter((r) => r.date || r.amountAed !== null);

  check(
    'not one row is offered a second time',
    second.filter((r) => r.errors.length === 0 && r.include !== false).length === 0,
    `${second.filter((r) => r.include !== false).length} would have been imported again`,
  );
  check(
    'and every row says it is already there',
    second.every((r) => r.duplicateOf),
    `${second.filter((r) => !r.duplicateOf).length} did not`,
  );

  /* ------------- 3. the file against a ledger holding only one of each repeat */

  console.log('\n  the file against a ledger missing the second copy of each repeat');
  console.log('  ' + '-'.repeat(88));

  // Exactly the situation this file left behind: the four charges the statement
  // lists twice are in the ledger once. Nothing else is missing.
  const repeats = second.filter((r) => r.repeatOfRow);
  check('the file does contain repeated charges', repeats.length === 4, `${repeats.length}`);

  const partial = (await nowInLedger()).filter((t) => {
    const isSecondCopy = repeats.some(
      (r) =>
        r.date === t.txn_date &&
        Math.abs(Math.abs(r.amountAed) - Math.abs(t.amount_aed)) < 0.005 &&
        r.supplier.toLowerCase() === String(t.supplier ?? '').toLowerCase(),
    );
    if (!isSecondCopy) return true;
    // Drop one of each pair, leaving the ledger one copy short.
    const key = `${t.txn_date}|${Math.abs(t.amount_aed).toFixed(2)}`;
    if (dropped.has(key)) return true;
    dropped.add(key);
    return false;
  });

  const third = buildRows(sheet, analysis.headerRow, analysis.mapping, {
    dayFirst: analysis.dayFirst,
    existing: partial,
    cardId: card.id,
  }).filter((r) => r.date || r.amountAed !== null);
  const offered = third.filter((r) => r.errors.length === 0 && r.include !== false);

  check(
    'exactly the four missing copies are offered',
    offered.length === 4,
    offered.map((r) => `row ${r.sourceRow}`).join(', ') || 'none',
  );
  const net = offered.reduce(
    (sum, r) => sum + (r.kind === 'purchase' || r.kind === 'fee' ? -r.amountAed : r.amountAed),
    0,
  );
  check(
    'and importing them closes the gap exactly',
    Math.abs(net - -64197.54) < 0.005,
    `${money(net)}`,
  );
  check(
    'each one says why it is being offered',
    offered.every((r) => r.warnings.some((w) => /ledger holds/.test(w))),
    offered[0]?.warnings.join(' | ') ?? '',
  );

  await client.query('rollback');
  console.log('\n  Rolled back — the live ledger is untouched.');
} finally {
  await client.end();
}

console.log('\n' + '='.repeat(92));
if (failures) {
  console.log(`${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('The file imports whole, and the ledger agrees with the sheet.');
console.log('='.repeat(92));
