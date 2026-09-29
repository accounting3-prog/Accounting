/**
 * Does the ledger date every transaction the way the bank dates it?
 *
 * The bank is the authority on when a transaction happened. Where the ledger
 * disagrees, the ledger is wrong — and a date that is a day out is invisible:
 * the balance still reconciles at the end of the month, the row is still
 * there, and it only shows up as a row the next statement cannot recognise
 * and offers to import again.
 *
 * Matched on what does NOT depend on the date: the amount, and the bank's own
 * voucher reference out of the narrative. A row whose amount and voucher match
 * exactly one statement line is the same transaction, whatever date it carries
 * — so a difference in the date is a difference to be reported, not a reason
 * to call them different rows.
 *
 * Read-only unless --live is passed, and it prints every change first.
 *
 *   LEDGER_DEPS=... IMPORT_BUNDLE=... STATEMENT=... node scripts/db/statement_date_audit.mjs [--live]
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { connect, q } from './connect.mjs';

const { parseXlsx } = await import(
  pathToFileURL(resolve(process.env.IMPORT_BUNDLE ?? 'web/src/lib/importFile.ts')).href
);

const live = process.argv.includes('--live');
const STATEMENT =
  process.env.STATEMENT ??
  `${process.env.USERPROFILE ?? process.env.HOME}/Downloads/Account Statement_29-09-2026 09_47_46.xlsx`;
const ACCOUNT = 'BANK KSA (SAB 7631)';

const money = (n) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (v) => {
  const t = String(v ?? '').replace(/[^0-9.\-]/g, '');
  return t === '' ? null : Number(t);
};
const dmy = (v) => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(v ?? '').trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};
/** The bank's own voucher on a narrative: letters then digits, on its own line. */
const voucherOf = (text) =>
  [...String(text ?? '').split(/\r?\n/).map((l) => l.trim())]
    .reverse()
    .find((l) => /^[A-Z]{3,5}\d{4,6}$/.test(l)) ?? null;

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(60)}${detail}`);
};

const client = await connect();

try {
  console.log('='.repeat(100));
  console.log(`${live ? 'LIVE' : 'DRY RUN'}  every date checked against the bank`);
  console.log('='.repeat(100));
  console.log(`\n  ${STATEMENT}\n`);

  /* ------------------------------------------------------- the bank's own rows */

  const sheet = parseXlsx(new Uint8Array(readFileSync(STATEMENT)))[0];
  const head = sheet.rows.findIndex((r) => String(r[1] ?? '').trim() === 'Sr. No');
  const bankRows = sheet.rows
    .slice(head + 1)
    .filter((r) => num(r[6]) !== null && /^(debit|credit)$/i.test(String(r[5] ?? '').trim()))
    .map((r) => ({
      date: dmy(r[2]),
      signed: (/^debit$/i.test(String(r[5]).trim()) ? -1 : 1) * Math.abs(num(r[6])),
      voucher: voucherOf(r[4]),
      text: String(r[4] ?? ''),
    }));

  const from = bankRows.reduce((a, r) => (r.date < a ? r.date : a), '9999');
  const to = bankRows.reduce((a, r) => (r.date > a ? r.date : a), '0000');
  console.log(`  the statement covers ${from} to ${to}, ${bankRows.length} transactions`);

  /* ------------------------------------------------ the ledger over that period */

  const [card] = await q(client, 'select id from cards where name = $1', [ACCOUNT]);
  const ledger = await q(
    client,
    `select id, to_char(txn_date,'YYYY-MM-DD') d, amount_aed::float8 amt, supplier_raw
       from transactions
      where card_id = $1 and status <> 'voided'
        and txn_date between $2::date - 7 and $3::date + 7`,
    [card.id, from, to],
  );
  console.log(`  the ledger holds ${ledger.length} rows in that window\n`);

  /* --------------------------------- matched on amount and voucher, not on date */

  const byKey = new Map();
  for (const b of bankRows) {
    if (!b.voucher) continue;
    const k = `${b.voucher}|${b.signed.toFixed(2)}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(b);
  }

  const claimed = new Map();
  const wrong = [];
  let agreed = 0;
  let unmatched = 0;

  for (const row of ledger) {
    const v = voucherOf(row.supplier_raw);
    if (!v) { unmatched++; continue; }
    const k = `${v}|${row.amt.toFixed(2)}`;
    const list = byKey.get(k);
    if (!list || !list.length) { unmatched++; continue; }
    // One statement line per ledger row, so two identical charges are compared
    // one to one rather than both against the first.
    const taken = claimed.get(k) ?? 0;
    if (taken >= list.length) { unmatched++; continue; }
    const bank = list[taken];
    claimed.set(k, taken + 1);
    if (bank.date === row.d) agreed++;
    else wrong.push({ ...row, bankDate: bank.date, voucher: v });
  }

  console.log(`  matched to a statement line by amount and voucher : ${agreed + wrong.length}`);
  console.log(`  no voucher, or no line to match                   : ${unmatched}`);
  console.log(`  dated exactly as the bank dates them              : ${agreed}`);
  console.log(`  dated differently                                 : ${wrong.length}\n`);

  if (wrong.length) {
    console.log('  the ledger and the bank disagree on these dates:\n');
    for (const w of wrong.slice(0, 25))
      console.log(
        `    ledger ${w.d}  ->  bank ${w.bankDate}   ${money(w.amt).padStart(13)}   ` +
        `${w.voucher}  ${String(w.supplier_raw).split(/\r?\n/)[0].slice(0, 34)}`,
      );
    if (wrong.length > 25) console.log(`    … and ${wrong.length - 25} more`);
  }

  /* ------------------------------------------------------------------- the fix */

  if (wrong.length) {
    await client.query('begin');
    const [{ l: before }] = await q(
      client, 'select ledger_balance::text l from card_balances where card_id = $1', [card.id],
    );
    for (const w of wrong) {
      await client.query(
        `update transactions set txn_date = $2::date,
                date_repaired = true,
                date_repair_note = $3,
                updated_at = now()
          where id = $1`,
        [w.id, w.bankDate,
         `Dated ${w.d} in the ledger; the bank's own statement dates it ${w.bankDate}. ` +
         `Matched on the amount and the bank's voucher ${w.voucher}, neither of which depends on the date.`],
      );
    }
    const [{ l: after }] = await q(
      client, 'select ledger_balance::text l from card_balances where card_id = $1', [card.id],
    );
    check('moving a date does not move the balance', before === after, `${money(before)}`);

    // The point of the exercise: they were the rows the next statement could
    // not recognise.
    const stillWrong = await q(
      client,
      `select count(*)::int n from transactions where id = any($1) and to_char(txn_date,'YYYY-MM-DD') <> any($2)`,
      [wrong.map((w) => w.id), wrong.map((w) => w.bankDate)],
    );
    check('every date now matches the bank', stillWrong[0].n === 0, `${wrong.length} corrected`);

    if (live && failures === 0) {
      await client.query('commit');
      console.log('\n  COMMITTED.');
    } else {
      await client.query('rollback');
      console.log(failures ? '\n  Rolled back — checks failed.' : '\n  Rolled back — re-run with --live to apply.');
    }
  } else {
    check('the ledger dates every matched transaction as the bank does', true, `${agreed} rows`);
  }
} finally {
  await client.end();
}

console.log('\n' + '='.repeat(100));
if (failures) { console.log(`${failures} CHECK(S) FAILED`); process.exit(1); }
console.log('The bank decides the date, and the ledger says the same.');
console.log('='.repeat(100));
