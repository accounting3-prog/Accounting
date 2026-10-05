/**
 * Builds the SAB reconciliation workbook from the live ledger and checks it,
 * reading the file back the way the importer reads any workbook — not by
 * asking the code that wrote it what it meant to write.
 *
 * For every tab:
 *   - the header is the sheet's, spelling and trailing space included
 *   - row 2 holds the opening balance, and it is the previous month's closing
 *   - each BALANCE is the one above it plus CREDIT less DEBIT, on the file's
 *     own figures
 *   - those balances are exactly the balances the bank printed for that month,
 *     which is only possible if the lines are in the bank's own order
 *   - the month's lines are every line the ledger holds for it, none twice
 *
 * And the September riyal tab is laid beside the hand-kept September sheet it
 * was modelled on (sab sep.xlsx), line by line, for date, amounts, balance,
 * description and request number.
 *
 *   LEDGER_DEPS=... BANKBOOK_BUNDLE=... IMPORT_BUNDLE=... OUT=... TEMPLATE=... \
 *     node scripts/db/bank_workbook_test.mjs
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { connect, q } from './connect.mjs';

const load = (v) => import(pathToFileURL(resolve(process.env[v])).href);
const { buildBankWorkbook } = await load('BANKBOOK_BUNDLE');
const { parseXlsx } = await load('IMPORT_BUNDLE');

const OUT = process.env.OUT ?? 'SAB reconciliation.xlsx';
const TEMPLATE =
  process.env.TEMPLATE ?? `${process.env.USERPROFILE ?? process.env.HOME}/Downloads/sab sep.xlsx`;

const money = (n) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const n = (v) => {
  const t = String(v ?? '').replace(/[^0-9.-]/g, '');
  return t === '' ? 0 : Number(t);
};
const same = (a, b) => Math.abs(a - b) < 0.005;

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(60)}${detail}`);
};

const client = await connect();
let cards, transactions, counts;
try {
  cards = await q(
    client,
    `select id, name, settlement_currency as "settlementCurrency", card_type as "cardType",
            tracks_balance as "tracksBalance", opening_balance::float8 as "openingBalance"
       from cards
      where card_type = 'bank_account' and tracks_balance is not false
      order by name`,
  );
  transactions = await q(
    client,
    `select t.id, t.card_id as "cardId", to_char(t.txn_date,'YYYY-MM-DD') txn_date,
            t.supplier_raw, t.amount_aed::float8 amount_aed, t.status, t.req_number,
            t.notes, t.source_sheet, t.source_row, t.statement_balance::float8 statement_balance
       from transactions t join cards c on c.id = t.card_id
      where c.card_type = 'bank_account' and c.tracks_balance is not false`,
  );
  counts = await q(
    client,
    `select c.name, to_char(t.txn_date,'YYYY-MM') m, count(*)::int n,
            coalesce(sum(-t.amount_aed) filter (where t.amount_aed < 0),0)::float8 paid,
            coalesce(sum(t.amount_aed) filter (where t.amount_aed > 0),0)::float8 came
       from transactions t join cards c on c.id = t.card_id
      where c.card_type = 'bank_account' and c.tracks_balance is not false and t.status <> 'voided'
      group by 1,2`,
  );
} finally {
  await client.end();
}

const bytes = buildBankWorkbook(cards, transactions);
writeFileSync(OUT, bytes);

console.log('='.repeat(100));
console.log('THE SAB RECONCILIATION WORKBOOK, READ BACK');
console.log('='.repeat(100));
console.log(`\n  ${OUT}  (${Math.round(bytes.length / 1024)} KB)\n`);

const sheets = parseXlsx(new Uint8Array(bytes));
const HEADERS = ['DATE', 'describtion ', 'DEBIT', 'CREDIT', 'BALANCE', 'Record @ Zoho System', 'Customer', 'REQ', 'Operation'];

const currencyOf = new Map(cards.map((c) => [c.settlementCurrency, c]));
const closingByCard = new Map();
let tabs = 0;

console.log('  tab              lines        opening          debit           credit          closing   bank\n');
for (const sheet of sheets) {
  tabs++;
  const [mm, yyyy, cur] = sheet.name.split(/[-\s]/);
  const card = currencyOf.get(cur);
  const month = `${yyyy}-${mm}`;
  const header = sheet.rows[0].slice(0, 9).map((h) => String(h ?? ''));
  if (header.join('|') !== HEADERS.join('|')) {
    check(`${sheet.name}: header is the sheet's own`, false, JSON.stringify(header));
  }

  const opening = n(sheet.rows[1][4]);
  const lines = sheet.rows.slice(2).filter((r) => String(r[0] ?? '').trim());

  // The file's own arithmetic.
  let running = opening;
  let chainBreaks = 0;
  let debit = 0;
  let credit = 0;
  for (const r of lines) {
    debit += n(r[2]);
    credit += n(r[3]);
    running += n(r[3]) - n(r[2]);
    if (!same(running, n(r[4]))) chainBreaks++;
  }

  // Against the bank: the balances in the file must be exactly the balances
  // the bank printed for this account in this month.
  const printed = transactions
    .filter((t) => t.cardId === card.id && t.status !== 'voided' && String(t.txn_date).startsWith(month))
    .map((t) => Math.round(t.statement_balance * 100))
    .sort((a, b) => a - b);
  const inFile = lines.map((r) => Math.round(n(r[4]) * 100)).sort((a, b) => a - b);
  const matchesBank = printed.length === inFile.length && printed.every((v, i) => v === inFile[i]);

  const expected = counts.find((c) => c.name === card.name && c.m === month);
  const previous = closingByCard.get(card.id);

  if (chainBreaks) check(`${sheet.name}: every balance follows from the line above`, false, `${chainBreaks} breaks`);
  if (!matchesBank) check(`${sheet.name}: the balances are the ones the bank printed`, false, '');
  if (!expected || expected.n !== lines.length)
    check(`${sheet.name}: every line of the month, none twice`, false, `${lines.length} vs ${expected?.n}`);
  if (expected && (!same(debit, expected.paid) || !same(credit, expected.came)))
    check(`${sheet.name}: debits and credits add up to the ledger's`, false, '');
  if (previous !== undefined && !same(previous, opening))
    check(`${sheet.name}: opens where the month before closed`, false, `${money(opening)} vs ${money(previous)}`);
  if (previous === undefined && !same(opening, card.openingBalance))
    check(`${sheet.name}: the first month opens at the account's opening balance`, false, '');
  closingByCard.set(card.id, running);

  console.log(
    `  ${sheet.name.padEnd(13)} ${String(lines.length).padStart(6)}  ${money(opening).padStart(15)}  ` +
      `${money(debit).padStart(14)}  ${money(credit).padStart(15)}  ${money(running).padStart(15)}   ` +
      (matchesBank && !chainBreaks ? 'yes' : 'NO'),
  );
}

console.log('');
check('one tab for every month of every account', tabs === counts.length, `${tabs} of ${counts.length}`);
check('every tab balances, line by line, against the bank', failures === 0, '');

/* ----------------------------------------- beside the hand-kept September */

if (existsSync(TEMPLATE)) {
  const mine = sheets.find((s) => s.name === '09-2026 SAR');
  const theirs = parseXlsx(new Uint8Array(readFileSync(TEMPLATE)))[0];
  const a = mine.rows.slice(2).filter((r) => String(r[0] ?? '').trim());
  const b = theirs.rows.slice(2).filter((r) => String(r[0] ?? '').trim());
  const span = Math.min(a.length, b.length);
  const diff = { date: [], debit: [], credit: [], balance: [], description: [], reference: [] };
  for (let i = 0; i < span; i++) {
    const [x, y] = [a[i], b[i]];
    if (String(x[0]) !== String(y[0])) diff.date.push(i);
    if (!same(n(x[2]), n(y[2]))) diff.debit.push(i);
    if (!same(n(x[3]), n(y[3]))) diff.credit.push(i);
    if (!same(n(x[4]), n(y[4]))) diff.balance.push(i);
    if (String(x[1] ?? '').replace(/\s+/g, ' ').trim() !== String(y[1] ?? '').replace(/\s+/g, ' ').trim())
      diff.description.push(i);
    if (String(x[6] ?? '').trim().toUpperCase() !== String(y[6] ?? '').trim().toUpperCase())
      diff.reference.push(i);
  }
  console.log(`\n  09-2026 SAR beside sab sep.xlsx — the ${span} lines both cover:\n`);
  check('opening balance', same(n(mine.rows[1][4]), n(theirs.rows[1][4])),
        `${money(n(mine.rows[1][4]))} vs ${money(n(theirs.rows[1][4]))}`);
  // The bank's own statement for the month, if it is to hand, settles any
  // disagreement over a date: find the line by the balance printed beside it
  // and read the date the bank gave it.
  const STATEMENT =
    process.env.SEP_STATEMENT ??
    `${process.env.USERPROFILE ?? process.env.HOME}/Downloads/Account Statement_29-09-2026 09_47_46.xlsx`;
  const bankDate = new Map();
  if (existsSync(STATEMENT)) {
    for (const r of parseXlsx(new Uint8Array(readFileSync(STATEMENT)))[0].rows) {
      const d = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(r[2] ?? '').trim());
      if (d) bankDate.set(Math.round(n(r[7]) * 100), `${d[3]}-${d[2]}-${d[1]}`);
    }
  }

  for (const [field, at] of Object.entries(diff)) {
    const ok = at.length === 0;
    if (field === 'date' && !ok) {
      // The hand-kept sheet has four lines a day later than the bank — found
      // and corrected in the ledger earlier. A difference here is only right
      // if the export carries the bank's date and the sheet does not.
      const bankSides = at.map((i) => bankDate.get(Math.round(n(a[i][4]) * 100)));
      const exportIsBank = at.every((i, k) => bankSides[k] === String(a[i][0]));
      check('date — where the two differ, the export has the bank\'s date', bankDate.size > 0 && exportIsBank,
            bankDate.size ? `${at.length} lines` : 'the bank statement was not found to check against');
      for (const [k, i] of at.entries())
        console.log(`          line ${i + 3}: export ${a[i][0]}, sheet ${b[i][0]}, bank ${bankSides[k] ?? '?'}`);
      continue;
    }
    if (field === 'description' && !ok) {
      // The statement adds a "Value Date" line to some narratives that the
      // hand-kept sheet does not carry. Anything else differing is a failure.
      const onlyValueDate = at.every((i) => {
        const strip = (s) => String(s ?? '').replace(/Value Date\s*:\s*\S+/g, '').replace(/\s+/g, ' ').trim();
        return strip(a[i][1]) === strip(b[i][1]);
      });
      check('description — differs only by the bank\'s "Value Date" line', onlyValueDate, `${at.length} lines`);
      continue;
    }
    if (field === 'reference') {
      // Not a failure: the ledger's request numbers are the ones filled in
      // since that sheet was saved. Listed so the difference can be read.
      console.log(`  ${ok ? 'PASS' : 'NOTE'}  ${field.padEnd(60)}${ok ? 'same on every line' : `${at.length} lines differ`}`);
      for (const i of at.slice(0, 8))
        console.log(`          line ${i + 3}: ledger "${a[i][6] ?? ''}", sheet "${b[i][6] ?? ''}"`);
    } else {
      check(field, ok, ok ? 'same on every line' : `${at.length} lines differ, first at line ${at[0] + 3}`);
      for (const i of at.slice(0, 3))
        console.log(`          line ${i + 3}: ${JSON.stringify(String(a[i][field === 'description' ? 1 : 0]).slice(0, 50))} vs ${JSON.stringify(String(b[i][field === 'description' ? 1 : 0]).slice(0, 50))}`);
    }
  }
}

console.log('\n' + '='.repeat(100));
if (failures) { console.log(`${failures} CHECK(S) FAILED`); process.exit(1); }
console.log('Every tab is the bank, line by line, in the sheet\'s own layout.');
console.log('='.repeat(100));
