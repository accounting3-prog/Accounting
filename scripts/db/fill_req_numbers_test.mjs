/**
 * Walks the whole fill-in-the-request-numbers round trip on the real ledger,
 * using the same code the screens use, and puts nothing back.
 *
 *   Transactions → filter "No request number (money out)" → Export
 *   → type the numbers into the sheet
 *   → Import → update mode → only that column is written
 *
 * Three things have to be true for this to be safe to tell someone to do:
 *
 *   1. the filter finds exactly the rows that need a number — money going out
 *      with none, and never money coming in, which needs none
 *   2. the file that comes back is matched to the right ledger rows, and a row
 *      whose date, amount or supplier has been altered is refused rather than
 *      written
 *   3. after the update, nothing but the request numbers has moved: the
 *      balance of every account is what it was
 *
 * The update is applied inside a transaction and rolled back, so the ledger is
 * exactly as it was before.
 *
 *   LEDGER_DEPS=... IMPORT_BUNDLE=... EXPORT_BUNDLE=... SEARCH_BUNDLE=... \
 *     node scripts/db/fill_req_numbers_test.mjs
 */

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { connect, q } from './connect.mjs';

const load = (v, fallback) => import(pathToFileURL(resolve(process.env[v] ?? fallback)).href);
const { parseXlsx, analyseSheet, buildUpdateRows } = await load('IMPORT_BUNDLE', 'web/src/lib/importFile.ts');
const { buildXlsx, EXPORT_COLUMNS } = await load('EXPORT_BUNDLE', 'web/src/lib/export.ts');
const { applyFilters, EMPTY_FILTERS } = await load('SEARCH_BUNDLE', 'web/src/lib/search.ts');

const money = (n) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(60)}${detail}`);
};

const client = await connect();

try {
  console.log('='.repeat(100));
  console.log('FILLING IN THE MISSING REQUEST NUMBERS, END TO END');
  console.log('='.repeat(100) + '\n');

  const cards = await q(
    client,
    `select id, name, settlement_currency as "settlementCurrency", card_type as "cardType",
            tracks_balance as "tracksBalance", balance_sign as "balanceSign",
            opening_balance::float8 as "openingBalance",
            to_char(opening_date,'YYYY-MM-DD') as "openingDate"
       from cards order by name`,
  );
  const transactions = await q(
    client,
    `select id, card_id as "cardId", to_char(txn_date,'YYYY-MM-DD') as txn_date,
            supplier_raw as supplier, supplier_raw, amount_aed::float8 as amount_aed,
            currency, direction, entry_type, status, req_number, payment_ref,
            invoice, lpo_number, client, notes, source_sheet, source_row
       from transactions where status <> 'voided'`,
  );
  const cardName = new Map(cards.map((c) => [c.id, c.name]));
  for (const t of transactions) t.card_name = cardName.get(t.cardId);

  /* ------------------------------------------- 1. what the filter picks out */

  const wanted = applyFilters(transactions, cards, { ...EMPTY_FILTERS, missing: 'req_number' });

  // Checked against the data rather than against the same rule: every row the
  // filter returned must be money out with no number, and every row it left
  // behind must fail one of those two tests.
  const blank = (v) => !String(v ?? '').trim();
  const needsOne = (t) => t.amount_aed < 0 && blank(t.req_number);
  const strays = wanted.filter((t) => !needsOne(t));
  const overlooked = transactions.filter((t) => needsOne(t) && !wanted.includes(t));

  console.log(`  ${wanted.length} of ${transactions.length} rows are money out with no request number\n`);
  check('the filter returns only money out with no number', strays.length === 0,
        strays.length ? `${strays.length} stray, e.g. ${money(strays[0].amount_aed)}` : '');
  check('and it overlooks none of them', overlooked.length === 0,
        overlooked.length ? `${overlooked.length} missed` : '');
  check('no money coming in is asked for a number',
        wanted.every((t) => t.amount_aed < 0), '');

  const byCard = new Map();
  for (const t of wanted) {
    const b = byCard.get(t.card_name) ?? { n: 0, total: 0, cur: '' };
    b.n++; b.total += t.amount_aed;
    b.cur = cards.find((c) => c.id === t.cardId).settlementCurrency;
    byCard.set(t.card_name, b);
  }
  console.log('');
  for (const [name, b] of [...byCard].sort((a, b) => b[1].n - a[1].n))
    console.log(`    ${name.padEnd(28)}${String(b.n).padStart(5)} rows   ${money(-b.total).padStart(16)} ${b.cur}`);

  /* -------------------------------- 2. export them, type numbers in, read back */

  // One account at a time, because update mode writes to one account.
  const target = [...byCard.entries()].sort((a, b) => b[1].n - a[1].n)[0];
  if (!target) throw new Error('nothing is missing a request number — nothing to test');
  const card = cards.find((c) => c.name === target[0]);
  const mine = wanted.filter((t) => t.cardId === card.id);

  console.log(`\n  working through ${card.name} — ${mine.length} rows\n`);
  check('the export carries the ledger id, which is what matches rows back',
        EXPORT_COLUMNS.some((c) => /ledger id/i.test(c.header)), '');
  check('and a request number column to type into',
        EXPORT_COLUMNS.some((c) => /request number/i.test(c.header)), '');

  const file = buildXlsx(mine, cards);
  const sheet = parseXlsx(new Uint8Array(file))[0];

  // Type a number into every row, the way a person would.
  const headerRow = sheet.rows.findIndex((r) => r.some((c) => /Ledger id/i.test(String(c ?? ''))));
  const reqCol = sheet.rows[headerRow].findIndex((c) => /Request number/i.test(String(c ?? '')));
  const typed = new Map();
  for (let i = headerRow + 1; i < sheet.rows.length; i++) {
    const idCol = sheet.rows[headerRow].findIndex((c) => /Ledger id/i.test(String(c ?? '')));
    const id = String(sheet.rows[i][idCol] ?? '').trim();
    if (!id) continue;
    const value = `REQ-TEST-${typed.size + 1}`;
    sheet.rows[i][reqCol] = value;
    typed.set(id, value);
  }
  check('every exported row can be typed into', typed.size === mine.length,
        `${typed.size} of ${mine.length}`);

  const analysis = analyseSheet(sheet, card);
  const updates = buildUpdateRows(sheet, analysis.headerRow, analysis.mapping, {
    field: 'req_number', existing: transactions, cardId: card.id, dayFirst: analysis.dayFirst,
  });
  const ready = updates.filter((u) => u.include && !u.errors.length);
  check('every line is matched back to its own ledger row',
        ready.length === mine.length, `${ready.length} of ${mine.length}`);
  check('and each carries the number that was typed on it',
        ready.every((u) => typed.get(u.id) === u.value), '');

  /* ---------------------- an altered line must be refused, not quietly written */

  const tampered = parseXlsx(new Uint8Array(file))[0];
  // The column the ledger compares against is named for what it holds, not
  // 'Amount' — looking for the wrong header alters nothing and proves nothing.
  const amountCol = tampered.rows[headerRow].findIndex((c) => /^AED settlement$/i.test(String(c ?? '')));
  if (amountCol < 0) throw new Error('the export has no AED settlement column to alter');
  tampered.rows[headerRow + 1][reqCol] = 'REQ-TAMPERED';
  tampered.rows[headerRow + 1][amountCol] = '1.00';
  const tamperAnalysis = analyseSheet(tampered, card);
  const tamperRows = buildUpdateRows(tampered, tamperAnalysis.headerRow, tamperAnalysis.mapping, {
    field: 'req_number', existing: transactions, cardId: card.id, dayFirst: tamperAnalysis.dayFirst,
  });
  const altered = tamperRows.find((u) => u.value === 'REQ-TAMPERED');
  check('a line whose amount was altered is refused',
        Boolean(altered && (altered.errors.length || !altered.include)),
        altered?.errors[0] ?? (altered ? 'it would have been written' : 'row not found'));

  /* --------------------------------- 3. apply them, then check nothing moved */

  const [owner] = await q(client, 'select user_id from admins where is_owner limit 1');
  const balancesBefore = await q(client,
    `select card_id, ledger_balance::float8 l, transaction_count::int n from card_balances`);

  await client.query('begin');
  await client.query('set local role authenticated');
  await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [owner.user_id]);

  for (const u of ready)
    await client.query(
      `select update_transaction(p_id := $1, p_req_number := $2, p_rationale := $3)`,
      [u.id, u.value, 'Filling in request numbers from the exported sheet'],
    );

  const written = await q(client,
    `select id, req_number, to_char(txn_date,'YYYY-MM-DD') d, amount_aed::float8 a, supplier_raw
       from transactions where id = any($1)`, [ready.map((u) => u.id)]);
  check('every row now carries the number that was typed for it',
        written.every((r) => typed.get(r.id) === r.req_number),
        `${written.filter((r) => typed.get(r.id) === r.req_number).length} of ${ready.length}`);

  const original = new Map(mine.map((t) => [t.id, t]));
  const moved = written.filter((r) => {
    const o = original.get(r.id);
    return o.txn_date !== r.d || Math.abs(o.amount_aed - r.a) > 0.005 || o.supplier_raw !== r.supplier_raw;
  });
  check('no date, amount or supplier moved', moved.length === 0,
        moved.length ? `${moved.length} changed` : `${written.length} rows untouched apart from the number`);

  const balancesAfter = await q(client,
    `select card_id, ledger_balance::float8 l, transaction_count::int n from card_balances`);
  const before = new Map(balancesBefore.map((b) => [b.card_id, b]));
  const shifted = balancesAfter.filter((b) =>
    Math.abs(b.l - before.get(b.card_id).l) > 0.005 || b.n !== before.get(b.card_id).n);
  check('every account holds the balance it held before', shifted.length === 0,
        shifted.length ? `${shifted.length} account(s) moved` : `${balancesAfter.length} accounts unchanged`);

  await client.query('rollback');
  console.log('\n  Rolled back — the ledger is as it was.');
} finally {
  await client.end();
}

console.log('\n' + '='.repeat(100));
if (failures) { console.log(`${failures} CHECK(S) FAILED`); process.exit(1); }
console.log('The round trip works: the filter finds them, the sheet fills them, only the number is written.');
console.log('='.repeat(100));
