/**
 * The bank reconciliation sheet, with request numbers typed into it, brought
 * back through the Import screen's update mode.
 *
 * The workflow this makes work: export the SAB reconciliation sheet from the
 * Banks page, type request numbers into the Customer column, upload it, and
 * the numbers land on the right rows. The sheet has no Ledger ID, so each line
 * is matched by the balance the bank printed beside it — unique on a bank
 * account — and its amount is checked against the row that balance names.
 *
 * Checked on the file the Banks page actually produces, from the live ledger:
 *   - every number typed onto a blank line is matched to its own row
 *   - lines already carrying their number are left alone, as are blank lines
 *   - the opening-balance line is not mistaken for a transaction
 *   - a line whose amount was altered is stopped; a balance that is not on the
 *     account is reported
 *   - written to the database (and rolled back), only the request numbers move
 *
 * And the hand-kept September sheet (sab sep.xlsx), uploaded as it is:
 *   - its lines a day out from the bank are reported, not stopped
 *   - where it holds an older number than the ledger, the ledger's is kept
 *
 *   LEDGER_DEPS=... BANKBOOK_BUNDLE=... IMPORT_BUNDLE=... [TEMPLATE=...] \
 *     node scripts/db/bank_sheet_update_test.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { connect, q } from './connect.mjs';

const load = (v) => import(pathToFileURL(resolve(process.env[v])).href);
const { buildBankWorkbook } = await load('BANKBOOK_BUNDLE');
const { parseXlsx, analyseSheet, buildUpdateRows } = await load('IMPORT_BUNDLE');

const TEMPLATE =
  process.env.TEMPLATE ?? `${process.env.USERPROFILE ?? process.env.HOME}/Downloads/sab sep.xlsx`;

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(60)}${detail}`);
};
const n = (v) => {
  const t = String(v ?? '').replace(/[^0-9.-]/g, '');
  return t === '' ? null : Number(t);
};

const client = await connect();
let cards, transactions;
try {
  cards = await q(
    client,
    `select id, name, settlement_currency as "settlementCurrency", card_type as "cardType",
            tracks_balance as "tracksBalance", balance_sign::int as "balanceSign",
            opening_balance::float8 as "openingBalance",
            to_char(opening_date,'YYYY-MM-DD') as "openingDate",
            coalesce(decreasing_header,'') as "decreasingHeader",
            coalesce(increasing_header,'') as "increasingHeader"
       from cards where card_type = 'bank_account' and tracks_balance is not false order by name`,
  );
  transactions = await q(
    client,
    `select t.id, t.card_id as "cardId", to_char(t.txn_date,'YYYY-MM-DD') txn_date,
            t.supplier_raw, t.supplier_raw as supplier, t.amount_aed::float8 amount_aed,
            t.status, t.req_number, t.payment_ref, t.invoice, t.lpo_number, t.notes,
            t.source_sheet, t.source_row, t.statement_balance::float8 statement_balance
       from transactions t join cards c on c.id = t.card_id
      where c.card_type = 'bank_account' and c.tracks_balance is not false`,
  );
} finally {
  await client.end();
}
const sar = cards.find((c) => c.settlementCurrency === 'SAR');

console.log('='.repeat(100));
console.log('REQUEST NUMBERS TYPED INTO THE BANK SHEET, BROUGHT BACK');
console.log('='.repeat(100) + '\n');

/* ------------------------------- the sheet the Banks page hands out */

const book = parseXlsx(new Uint8Array(buildBankWorkbook(cards, transactions)));
// The riyal month with the most payments still missing a number — the tab
// someone would actually open to fill in.
const missing = (s) =>
  s.rows.slice(2).filter((r) => String(r[0] ?? '').trim() && n(r[2]) && !String(r[6] ?? '').trim()).length;
const tab = book.filter((s) => s.name.endsWith(' SAR')).sort((x, y) => missing(y) - missing(x))[0];
const sheet = { ...tab, rows: tab.rows.map((r) => r.slice()) };
console.log(`  tab "${sheet.name}" of the exported workbook\n`);

// Type a number onto every payment that has none, as someone filling it in.
const typed = new Map();
let alreadyHad = 0;
let blank = 0;
for (let i = 2; i < sheet.rows.length; i++) {
  const r = sheet.rows[i];
  if (!String(r[0] ?? '').trim()) continue;
  const out = n(r[2]);
  if (String(r[6] ?? '').trim()) alreadyHad++;
  else if (out) {
    r[6] = `REQ-TEST-${typed.size + 1}`;
    typed.set(Math.round(n(r[4]) * 100), r[6]);
  } else blank++;
}
console.log(`  typed ${typed.size} request numbers onto payments that had none`);
console.log(`  ${alreadyHad} lines already carried one, ${blank} (money in) were left blank\n`);

const analysis = analyseSheet(sheet, sar);
const header = sheet.rows[analysis.headerRow];
check('the request number is read from the Customer column',
      String(header[analysis.mapping.req_number] ?? '').trim() === 'Customer', '');
check('the balance column is found', String(header[analysis.mapping.statement_balance] ?? '').trim() === 'BALANCE', '');

const rows = buildUpdateRows(sheet, analysis.headerRow, analysis.mapping, {
  field: 'req_number', existing: transactions, cardId: sar.id,
});
const ready = rows.filter((r) => r.include);
const errors = rows.filter((r) => r.errors.length);

check('every line is matched by its balance', rows.every((r) => r.matchedBy === 'balance'),
      `${rows.filter((r) => r.matchedBy === 'balance').length} of ${rows.length}`);
check('no line is stopped', errors.length === 0, errors[0]?.errors[0] ?? '');
check('every typed number is to be written', ready.length === typed.size, `${ready.length} of ${typed.size}`);
check('each onto the row at the balance it was typed beside',
      ready.every((r) => typed.get(Math.round(r.existing.statement_balance * 100)) === r.value), '');
check('lines that already had their number are left alone',
      rows.filter((r) => r.unchanged).length === alreadyHad, `${rows.filter((r) => r.unchanged).length} of ${alreadyHad}`);
check('blank lines are left alone, not cleared', rows.filter((r) => r.empty).length === blank,
      `${rows.filter((r) => r.empty).length} of ${blank}`);
check('the opening-balance line is not taken for a transaction',
      !rows.some((r) => r.sourceRow === 2), '');

/* --------------------------------------------------- tampered lines */

const target = ready[0];
const tampered = { ...sheet, rows: sheet.rows.map((r) => r.slice()) };
tampered.rows[target.sourceRow - 1][2] = String(n(tampered.rows[target.sourceRow - 1][2]) + 100);
const t1 = buildUpdateRows(tampered, analysis.headerRow, analysis.mapping, {
  field: 'req_number', existing: transactions, cardId: sar.id,
}).find((r) => r.sourceRow === target.sourceRow);
check('a line whose amount was altered is stopped', Boolean(t1 && !t1.include && t1.conflicts.some((c) => c.field === 'Amount')),
      t1?.errors[0] ?? '');

const moved = { ...sheet, rows: sheet.rows.map((r) => r.slice()) };
moved.rows[target.sourceRow - 1][4] = '1.23';
const t2 = buildUpdateRows(moved, analysis.headerRow, analysis.mapping, {
  field: 'req_number', existing: transactions, cardId: sar.id,
}).find((r) => r.sourceRow === target.sourceRow);
check('a balance that is not on the account is reported', Boolean(t2 && !t2.include && /No row on this account/.test(t2.errors[0] ?? '')),
      t2?.errors[0] ?? '');

/* ----------------------------------- written, then rolled back */

const db = await connect();
try {
  const [owner] = await q(db, 'select user_id from admins where is_owner limit 1');
  const before = await q(db, `select card_id, ledger_balance::float8 l, transaction_count::int c from card_balances`);
  await db.query('begin');
  await db.query('set local role authenticated');
  await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [owner.user_id]);
  for (const r of ready)
    await db.query(`select update_transaction(p_id := $1, p_req_number := $2, p_rationale := 'test')`, [r.id, r.value]);
  const written = await q(db, `select id, req_number, amount_aed::float8 a, to_char(txn_date,'YYYY-MM-DD') d
                                 from transactions where id = any($1)`, [ready.map((r) => r.id)]);
  const want = new Map(ready.map((r) => [r.id, r]));
  check('every typed number is now on its row',
        written.length === ready.length && written.every((w) => w.req_number === want.get(w.id).value),
        `${written.length} rows`);
  check('no date or amount moved',
        written.every((w) => w.d === want.get(w.id).existing.txn_date && Math.abs(w.a - want.get(w.id).existing.amount_aed) < 0.005), '');
  const after = await q(db, `select card_id, ledger_balance::float8 l, transaction_count::int c from card_balances`);
  const was = new Map(before.map((b) => [b.card_id, b]));
  check('every account holds the balance it held before',
        after.every((b) => Math.abs(b.l - was.get(b.card_id).l) < 0.005 && b.c === was.get(b.card_id).c), '');
  await db.query('rollback');
} finally {
  await db.end();
}

/* ---------------------------------- the hand-kept September, as it is */

if (existsSync(TEMPLATE)) {
  const old = parseXlsx(new Uint8Array(readFileSync(TEMPLATE)))[0];
  const a = analyseSheet(old, sar);
  const r = buildUpdateRows(old, a.headerRow, a.mapping, { field: 'req_number', existing: transactions, cardId: sar.id });
  const dated = r.filter((x) => x.notes.some((nt) => /the bank and the ledger say/.test(nt)));
  console.log(`\n  sab sep.xlsx, uploaded as it is — ${r.length} lines:`);
  console.log(`    ${r.filter((x) => x.include).length} to write · ${r.filter((x) => x.unchanged).length} already set · ` +
    `${r.filter((x) => x.differs).length} differ (ledger kept) · ${r.filter((x) => x.empty).length} blank · ${r.filter((x) => x.errors.length).length} stopped\n`);
  check('its lines a day out from the bank are reported, not stopped',
        dated.length === 4 && dated.every((x) => !x.errors.length), `${dated.length} lines`);
  check('where it holds an older number, the ledger\'s is kept',
        r.filter((x) => x.differs).every((x) => !x.include), `${r.filter((x) => x.differs).length} lines`);
  for (const x of r.filter((y) => y.differs).slice(0, 4))
    console.log(`          row ${x.sourceRow}: sheet "${x.value}", ledger "${x.current}" — ledger kept`);
  check('no line of it is stopped', r.every((x) => !x.errors.length), r.find((x) => x.errors.length)?.errors[0] ?? '');
}

console.log('\n' + '='.repeat(100));
if (failures) { console.log(`${failures} CHECK(S) FAILED`); process.exit(1); }
console.log('Request numbers typed into the bank sheet come back onto the right rows, and nothing else moves.');
console.log('='.repeat(100));
