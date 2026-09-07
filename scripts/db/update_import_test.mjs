/**
 * Filling in a missing field by round trip, and proving nothing else moved.
 *
 * The claim being tested is narrow and the whole value is in it: exporting the
 * rows that lack a payment reference, typing the references into the sheet, and
 * bringing the file back writes THE REFERENCE AND NOTHING ELSE. No balance
 * moves, no amount changes, no row is created.
 *
 * So the balances and a full column-by-column snapshot of every affected row
 * are taken before, and compared after. A test that only checked the reference
 * arrived would pass just as happily if the import had also rewritten a date.
 *
 * Runs against the live database inside a transaction and rolls back.
 *
 *   LEDGER_DEPS=... FFLATE_DIR=... EXPORT_BUNDLE=... IMPORT_BUNDLE=... \
 *     node scripts/db/update_import_test.mjs
 */

import { pathToFileURL } from 'node:url';
import path, { resolve } from 'node:path';
import { connect, q } from './connect.mjs';

const fflate = await import(
  pathToFileURL(
    path.join(process.env.FFLATE_DIR ?? process.env.LEDGER_DEPS, 'node_modules/fflate/esm/browser.js'),
  ).href
);
const { unzipSync, zipSync, strToU8, strFromU8 } = fflate;

const load = (envVar, fallback) =>
  import(pathToFileURL(resolve(process.env[envVar] ?? fallback)).href);

const { buildXlsx, EXPORT_COLUMNS } = await load('EXPORT_BUNDLE', 'web/src/lib/export.ts');
const { parseXlsx, analyseSheet, buildUpdateRows } = await load(
  'IMPORT_BUNDLE',
  'web/src/lib/importFile.ts',
);

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(62)}${detail}`);
};
const money = (n) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const colLetter = (i) => {
  let s = '';
  let n = i;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
};

/** Types values into cells of an existing sheet, leaving everything else alone. */
function typeInto(bytes, edits) {
  const zip = unzipSync(bytes);
  const part = 'xl/worksheets/sheet1.xml';
  let xml = strFromU8(zip[part]);
  for (const { row, col, value } of edits) {
    const ref = `${col}${row}`;
    const cell = `<c r="${ref}" s="0" t="inlineStr"><is><t xml:space="preserve">${value}</t></is></c>`;
    const existing = new RegExp(`<c r="${ref}"[^>]*(?:/>|>[\\s\\S]*?</c>)`);
    if (existing.test(xml)) xml = xml.replace(existing, cell);
    else xml = xml.replace(new RegExp(`(<row r="${row}"[^>]*>)`), `$1${cell}`);
  }
  zip[part] = strToU8(xml);
  return zipSync(zip, { level: 6 });
}

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
  totalSpend: Number(row.total_spend),
  totalFunding: Number(row.total_funding),
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

/* Every column of transactions, so "nothing else changed" means all of it. */
const SNAPSHOT = `select * from transactions where id = any($1) order by id`;

const client = await connect();

try {
  const [owner] = await q(client, 'select user_id from admins where is_owner limit 1');
  if (!owner) throw new Error('no owner account to run as');

  console.log('='.repeat(96));
  console.log('FILLING IN A MISSING PAYMENT REFERENCE BY ROUND TRIP');
  console.log('='.repeat(96));

  await client.query('begin');
  await client.query('set local role authenticated');
  await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [owner.user_id]);

  const [cardRow] = await q(
    client,
    `select b.*, c.source_header_row, c.decreasing_column, c.decreasing_header,
            c.increasing_column, c.increasing_header, c.balance_formula
       from card_balances b join cards c on c.id = b.card_id
      where b.card_name = 'MASTERCARD 6404 VPAY'`,
  );
  const card = cardFromDb(cardRow);

  /* -------------------------------------------- 1. the rows missing one */

  const missing = await q(
    client,
    `select id, card_id as "cardId", entry_type, status,
            to_char(txn_date, 'YYYY-MM-DD') as txn_date,
            supplier_raw as supplier, amount_aed::float8 as amount_aed, direction,
            currency, original_amount::float8 as original_amount,
            exchange_rate::float8 as exchange_rate, req_number, payment_ref,
            source_sheet, source_row, occurrence
       from transactions
      where card_id = $1 and status <> 'voided'
        and coalesce(btrim(payment_ref), '') = ''
      order by txn_date limit 12`,
    [card.id],
  );
  check('the card has rows with no payment reference', missing.length > 0, `${missing.length}`);

  const ids = missing.map((t) => t.id);
  const before = await q(client, SNAPSHOT, [ids]);
  const balBefore = (
    await q(client, 'select ledger_balance::text l, source_balance::text s, transaction_count::int n from card_balances where card_id = $1', [card.id])
  )[0];

  /* --------------------------------------------------------- 2. export */

  const workbook = buildXlsx(missing, [card], `${missing.length} transactions — missing the payment ref`);
  const sheets = parseXlsx(workbook);
  const sheet = sheets[0];
  const headerRow = sheet.rows.findIndex((r) => r[0] === 'Ledger ID');
  check('the export carries a Ledger ID column', headerRow >= 0, `header on row ${headerRow + 1}`);

  const headers = sheet.rows[headerRow];
  const idCol = headers.indexOf('Ledger ID');
  const refCol = headers.indexOf('Payment reference');
  check('and a Payment reference column to fill in', refCol >= 0, `column ${colLetter(refCol)}`);

  /* --------------------------------------- 3. type the references in */

  const stamp = Date.now().toString().slice(-5);
  const edits = missing.map((t, i) => ({
    row: headerRow + 2 + i,
    col: colLetter(refCol),
    value: `Payment Made: #TEST${stamp}-${i + 1}`,
  }));
  const filled = typeInto(workbook, edits);

  /* --------------------------------------------------- 4. read it back */

  const reparsed = parseXlsx(filled)[0];
  const analysis = analyseSheet(reparsed, card);
  const all = await q(
    client,
    `select id, card_id as "cardId", to_char(txn_date,'YYYY-MM-DD') as txn_date,
            supplier_raw as supplier, description, amount_aed::float8 as amount_aed,
            currency, original_amount::float8 as original_amount,
            payment_ref, req_number, invoice, lpo_number
       from transactions where card_id = $1`,
    [card.id],
  );
  const rows = buildUpdateRows(reparsed, analysis.headerRow, analysis.mapping, {
    field: 'payment_ref',
    existing: all,
    cardId: card.id,
  });

  check('every line resolves to a ledger row', rows.every((r) => r.existing),
        `${rows.filter((r) => !r.existing).length} unresolved`);
  check('every line is ready to write', rows.filter((r) => r.include).length === missing.length,
        `${rows.filter((r) => r.include).length} of ${missing.length}`);
  check('none reports a conflict with the ledger',
        rows.every((r) => r.conflicts.length === 0),
        JSON.stringify(rows.flatMap((r) => r.conflicts).slice(0, 2)));

  /* ------------------------------------------------------- 5. write it */

  for (const r of rows.filter((x) => x.include)) {
    await client.query(
      `select update_transaction(p_id := $1, p_rationale := $2, p_payment_ref := $3)`,
      [r.id, `Payment reference filled in from a file, row ${r.sourceRow}.`, r.value],
    );
  }

  /* ------------------------------------ 6. what actually changed, in full */

  const after = await q(client, SNAPSHOT, [ids]);
  const balAfter = (
    await q(client, 'select ledger_balance::text l, source_balance::text s, transaction_count::int n from card_balances where card_id = $1', [card.id])
  )[0];

  // Matched by id, not by position: the snapshot is ordered by id and the sheet
  // rows are in sheet order, so comparing them index by index compares
  // different transactions and can pass or fail for no reason at all.
  const wanted = new Map(rows.filter((r) => r.include).map((r) => [r.id, r.value]));
  const wrong = after.filter((a) => a.payment_ref !== wanted.get(a.id));
  check('the reference was written on every row',
        wrong.length === 0 && wanted.size === after.length,
        wrong.length ? `${wrong.length} rows got the wrong value` : `${after.length} rows`);

  // The whole point. dedup_key is expected to move — it is a hash of the
  // content, and the content changed — and updated_at with it.
  const ALLOWED = new Set(['payment_ref', 'dedup_key', 'updated_at', 'search_text']);
  const changed = new Set();
  for (let i = 0; i < before.length; i++) {
    for (const key of Object.keys(before[i])) {
      const a = before[i][key];
      const b = after[i][key];
      if (String(a) !== String(b)) changed.add(key);
    }
  }
  const unexpected = [...changed].filter((k) => !ALLOWED.has(k));
  check(`only ${[...ALLOWED].join(', ')} changed on any row`,
        unexpected.length === 0,
        unexpected.length ? `ALSO CHANGED: ${unexpected.join(', ')}` : `${changed.size} columns`);

  check('the ledger balance is exactly what it was',
        balAfter.l === balBefore.l, `${money(balBefore.l)} -> ${money(balAfter.l)}`);
  check('the statement balance is exactly what it was',
        balAfter.s === balBefore.s, `${money(balBefore.s)} -> ${money(balAfter.s)}`);
  check('no row was created', balAfter.n === balBefore.n, `${balBefore.n} -> ${balAfter.n}`);

  // The key must now describe the row as it is, or a later import of the same
  // transaction would compute a different key and write a duplicate.
  const stale = after.filter((a, i) => a.dedup_key === before[i].dedup_key);
  check('the dedup key was recomputed to match the new content',
        stale.length === 0, `${stale.length} rows kept a stale key`);
  check('and the keys are still unique',
        new Set(after.map((a) => a.dedup_key)).size === after.length);

  /* ---------------------------------------------- 7. it is all recorded */

  const trail = await q(
    client,
    `select action, actor, changes from activity_log
      where transaction_id = any($1) and action = 'annotated'`,
    [ids],
  );
  check('every change is in the history', trail.length >= missing.length, `${trail.length} entries`);
  check('recording the before and after of the reference only',
        trail.every((t) => {
          const keys = Object.keys(t.changes ?? {});
          return keys.length === 1 && keys[0] === 'payment_ref';
        }),
        JSON.stringify(trail[0]?.changes ?? {}).slice(0, 70));

  /* ------------------------------- 8. a sheet with an edited amount is stopped */

  const tampered = typeInto(workbook, [
    { row: headerRow + 2, col: colLetter(refCol), value: 'Payment Made: #TAMPER' },
    {
      row: headerRow + 2,
      col: colLetter(headers.indexOf('AED settlement')),
      value: '-999999.99',
    },
  ]);
  const tamperedRows = buildUpdateRows(
    parseXlsx(tampered)[0],
    analysis.headerRow,
    analysis.mapping,
    { field: 'payment_ref', existing: all, cardId: card.id },
  );
  const first = tamperedRows[0];
  check('a line whose amount was edited in the spreadsheet is stopped',
        first.errors.length > 0 && !first.include,
        first.errors[0] ?? 'IT WAS ACCEPTED');
  check('and the difference is named, not just refused',
        first.conflicts.some((c) => c.field === 'AED settlement'),
        JSON.stringify(first.conflicts[0] ?? {}));

  /* --------------------------- 9. a line for another card is refused */

  const [otherCard] = await q(client, `select id from cards where id <> $1 limit 1`, [card.id]);
  const wrongCard = buildUpdateRows(reparsed, analysis.headerRow, analysis.mapping, {
    field: 'payment_ref',
    existing: all,
    cardId: otherCard.id,
  });
  check('applying the file to the wrong card writes nothing',
        wrongCard.every((r) => !r.include),
        `${wrongCard.filter((r) => r.include).length} would have been written`);

  await client.query('rollback');
  console.log('\n  Rolled back — the live ledger is untouched.');
} finally {
  await client.end();
}

console.log('\n' + '='.repeat(96));
if (failures) {
  console.log(`${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('The reference is filled in, and nothing else about the transaction moved.');
console.log('='.repeat(96));
