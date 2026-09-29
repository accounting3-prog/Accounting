/**
 * Fills in the request numbers from the reconciliation sheet.
 *
 * The bank's own statement carries no references — it cannot, they are the
 * company's, not the bank's. They live in the sheet kept alongside it. So rows
 * imported from a statement arrive without one, and this puts them in.
 *
 * Rows are matched on the running balance, because on this account it is
 * unique: every line of a statement sits at a different balance from every
 * other, so one balance names one row and nothing else has to be guessed at.
 * The date and the amount are then checked against the row it found, and a
 * match where either disagrees is refused rather than written.
 *
 * Two things it will not do:
 *   - overwrite a reference the ledger already holds. A sheet that disagrees
 *     with the ledger is reported and left alone; changing one is a correction
 *     someone should look at, not a side effect of filling in blanks.
 *   - touch anything but the reference. The date, amount and supplier are not
 *     sent at all.
 *
 * Which column holds the reference is decided by which one is filled in, not
 * by which one is named right: on this workbook the column headed REQ is empty
 * and the one headed Customer holds the numbers.
 *
 * Dry run unless --live.
 *
 *   LEDGER_DEPS=... IMPORT_BUNDLE=... WORKBOOK=... ACCOUNT=... \
 *     node scripts/db/fill_references_from_sheet.mjs [--live]
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { connect, q } from './connect.mjs';

const { parseXlsx } = await import(
  pathToFileURL(resolve(process.env.IMPORT_BUNDLE ?? 'web/src/lib/importFile.ts')).href
);

const live = process.argv.includes('--live');
const WORKBOOK =
  process.env.WORKBOOK ?? `${process.env.USERPROFILE ?? process.env.HOME}/Downloads/sab sep.xlsx`;
const ACCOUNT = process.env.ACCOUNT ?? 'BANK KSA (SAB 7631)';

const money = (n) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const norm = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const num = (v) => {
  const t = String(v ?? '').trim();
  if (!t) return null;
  const negative = t.startsWith('-') || /^\(.*\)$/.test(t);
  const n = Number(t.replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && t.replace(/[^0-9]/g, '') !== '' ? (negative ? -n : n) : null;
};
/** Two figures are the same money if they round to the same hundredth. */
const key = (n) => Math.round(n * 100);

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(58)}${detail}`);
};

const client = await connect();

try {
  console.log('='.repeat(100));
  console.log(`${live ? 'LIVE' : 'DRY RUN'}  filling references into ${ACCOUNT}`);
  console.log('='.repeat(100));
  console.log(`\n  ${WORKBOOK}\n`);

  /* ------------------------------------------------- what the sheet carries */

  const sheet = parseXlsx(new Uint8Array(readFileSync(WORKBOOK)))[0];
  const headers = sheet.rows[0] ?? [];
  const at = (re) => headers.findIndex((h) => re.test(norm(h)));
  const dateCol = at(/^date$/i);
  const balCol = at(/^balance$/i);
  if (dateCol < 0 || balCol < 0) throw new Error('the sheet has no DATE or BALANCE column');

  // Every column that could be carrying the reference, ranked by how many of
  // its cells are actually filled in. The one named REQ is empty here; the one
  // named Customer holds the numbers. The data decides, not the heading.
  const candidates = headers
    .map((h, i) => ({ i, name: norm(h), filled: 0 }))
    .filter((c) => /^(req|customer|reference|record @ zoho system)$/i.test(c.name));
  for (const c of candidates)
    c.filled = sheet.rows.slice(1).filter((r) => norm(r[c.i])).length;
  candidates.sort((a, b) => b.filled - a.filled);
  const refCol = candidates[0];
  if (!refCol || !refCol.filled) throw new Error('no column in this sheet holds a reference');

  console.log(
    `  the reference is in the column headed "${refCol.name}" — ${refCol.filled} filled in` +
      (candidates.length > 1
        ? `, against ${candidates
            .slice(1)
            .map((c) => `"${c.name}" ${c.filled}`)
            .join(', ')}`
        : ''),
  );

  const fromSheet = [];
  for (let i = 1; i < sheet.rows.length; i++) {
    const row = sheet.rows[i];
    const balance = num(row[balCol]);
    const reference = norm(row[refCol.i]);
    if (balance === null || !reference) continue;
    fromSheet.push({ line: i + 1, date: norm(row[dateCol]), balance, reference });
  }
  console.log(`  ${fromSheet.length} lines carry one\n`);

  /* ----------------------------------------------- what the ledger holds now */

  const [card] = await q(client, 'select id, settlement_currency cur from cards where name = $1', [ACCOUNT]);
  if (!card) throw new Error(`no account named ${ACCOUNT}`);

  const held = await q(
    client,
    `select id, to_char(txn_date,'YYYY-MM-DD') d, amount_aed::float8 a,
            statement_balance::float8 sb, req_number,
            left(regexp_replace(supplier_raw, '\\s+', ' ', 'g'), 44) s
       from transactions
      where card_id = $1 and status <> 'voided' and statement_balance is not null`,
    [card.id],
  );

  const byBalance = new Map();
  const ambiguous = new Set();
  for (const r of held) {
    const k = key(r.sb);
    if (byBalance.has(k)) ambiguous.add(k);
    byBalance.set(k, r);
  }
  check(
    'each running balance names exactly one row',
    ambiguous.size === 0,
    ambiguous.size ? `${ambiguous.size} balance(s) appear twice — those are skipped` : `${held.length} rows`,
  );

  /* ------------------------------------------------------ match them up */

  const toWrite = [];
  const disagrees = [];
  const already = [];
  const notFound = [];

  for (const line of fromSheet) {
    const k = key(line.balance);
    if (ambiguous.has(k)) { notFound.push({ ...line, why: 'that balance appears on more than one row' }); continue; }
    const row = byBalance.get(k);
    if (!row) { notFound.push({ ...line, why: 'no row in the ledger sits at that balance' }); continue; }
    if (line.date && row.d !== line.date) {
      notFound.push({ ...line, why: `the ledger row at that balance is dated ${row.d}` });
      continue;
    }
    const current = norm(row.req_number);
    if (!current) toWrite.push({ ...line, row });
    else if (current.toUpperCase() === line.reference.toUpperCase()) already.push({ ...line, row });
    else disagrees.push({ ...line, row, current });
  }

  console.log('');
  console.log(`  ${already.length} already carry the same reference`);
  console.log(`  ${toWrite.length} are blank in the ledger and will be filled in`);
  console.log(`  ${disagrees.length} disagree with the ledger — left alone`);
  console.log(`  ${notFound.length} could not be matched to a row`);

  for (const d of disagrees.slice(0, 15))
    console.log(`      line ${String(d.line).padStart(4)}  ${d.date}  ledger has "${d.current}", sheet says "${d.reference}"`);
  if (disagrees.length > 15) console.log(`      … and ${disagrees.length - 15} more`);
  for (const n of notFound.slice(0, 10))
    console.log(`      line ${String(n.line).padStart(4)}  ${n.date}  ${money(n.balance)} — ${n.why}`);
  if (notFound.length > 10) console.log(`      … and ${notFound.length - 10} more`);

  if (toWrite.length) {
    console.log('\n  to be filled in:\n');
    for (const w of toWrite.slice(0, 25))
      console.log(`      ${w.row.d}  ${money(w.row.a).padStart(14)}  ${w.reference.padEnd(14)} ${w.row.s}`);
    if (toWrite.length > 25) console.log(`      … and ${toWrite.length - 25} more`);
  }

  /* ------------------------------------------------------------ write them */

  const [owner] = await q(client, 'select user_id from admins where is_owner limit 1');
  const [before] = await q(client,
    `select ledger_balance::float8 l, transaction_count::int n from card_balances where card_id = $1`,
    [card.id]);

  await client.query('begin');
  await client.query('set local role authenticated');
  await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [owner.user_id]);

  for (const w of toWrite)
    await client.query(
      `select update_transaction(p_id := $1, p_req_number := $2, p_rationale := $3)`,
      [w.row.id, w.reference, `Reference from ${WORKBOOK.split(/[\\/]/).pop()} line ${w.line}`],
    );

  const written = await q(client,
    `select id, req_number, to_char(txn_date,'YYYY-MM-DD') d, amount_aed::float8 a
       from transactions where id = any($1)`, [toWrite.map((w) => w.row.id)]);
  const wanted = new Map(toWrite.map((w) => [w.row.id, w]));

  console.log('');
  check('every blank row now carries the sheet\'s reference',
        written.every((r) => norm(r.req_number).toUpperCase() === wanted.get(r.id).reference.toUpperCase()),
        `${written.length} of ${toWrite.length}`);
  check('and none of them moved date or amount',
        written.every((r) => r.d === wanted.get(r.id).row.d && Math.abs(r.a - wanted.get(r.id).row.a) < 0.005),
        '');

  const [after] = await q(client,
    `select ledger_balance::float8 l, transaction_count::int n from card_balances where card_id = $1`,
    [card.id]);
  check('the account holds the balance it held before',
        Math.abs(after.l - before.l) < 0.005 && after.n === before.n,
        `${money(after.l)} ${card.cur}, ${after.n} rows`);

  const [{ n: stillBlank }] = await q(client,
    `select count(*)::int n from transactions
      where card_id = $1 and status <> 'voided' and amount_aed < 0
        and coalesce(btrim(req_number), '') = ''`, [card.id]);
  console.log(`\n  ${stillBlank} payments out would still have no reference afterwards`);

  if (live && failures === 0) {
    await client.query('commit');
    console.log('\n  COMMITTED.');
  } else {
    await client.query('rollback');
    console.log(failures ? '\n  Rolled back — checks failed.' : '\n  Rolled back — re-run with --live to keep it.');
  }
} finally {
  await client.end();
}

console.log('\n' + '='.repeat(100));
if (failures) { console.log(`${failures} CHECK(S) FAILED`); process.exit(1); }
console.log('Only the references were written, and only where the ledger had none.');
console.log('='.repeat(100));
