/**
 * The KSA account from the beginning: one sheet per month, November 2025 on.
 *
 * The account is already in the ledger from 1 September 2026. This moves its
 * opening back to where the records actually start and imports everything
 * before it, while recognising the September rows that are already there
 * rather than writing them again.
 *
 * WHAT IS CHECKED BEFORE ANYTHING IS WRITTEN
 *
 * Each month's balance chain, with DEBIT down and CREDIT up, and each month's
 * closing against the next month's opening. The year has to hold together as
 * one chain or the import does not start. August 2026 closes on 2,141,903.51,
 * which is the opening this account was created with — so the two sources
 * agree at the join without either having been told about the other.
 *
 * TWO THINGS THE FILE GETS WRONG, NEITHER SILENTLY ACCEPTED
 *
 * Four rows on the 12-2025 sheet are dated 2026-12-31 — a year into the
 * future, one of them a payroll of 141,654.82. They sit at the end of December
 * 2025 and the balance chain runs through them, so they are real transactions
 * with a mistyped year. They are imported at 2025-12-31 and flagged for
 * review, with the date the sheet actually contains recorded on the row. They
 * are not corrected quietly and they are not dropped.
 *
 * The reference lives in a different column depending on the month. 'Customer'
 * holds the reference (KSAML1427, SA 1008, #602); 'Record @ Zoho System' holds
 * a workflow status (done, no po, without payment report) — except that bank
 * charges are marked 'bac' in whichever of the two the month was using. So the
 * reference is taken from Customer, falling back to Zoho only when Zoho says
 * bac, and Zoho's other content is kept as a note rather than promoted to a
 * request number it is not.
 *
 *   LEDGER_DEPS=... IMPORT_BUNDLE=... YEARFILE=... node scripts/db/import_bank_year.mjs
 *   ... --live
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { connect, q } from './connect.mjs';

const { parseXlsx } = await import(
  pathToFileURL(resolve(process.env.IMPORT_BUNDLE ?? 'web/src/lib/importFile.ts')).href
);

const live = process.argv.includes('--live');
const YEARFILE = process.env.YEARFILE;
if (!YEARFILE) throw new Error('set YEARFILE to the reconciliation workbook');
const ACCOUNT = 'BANK KSA (SAB 7631)';
const SOURCE_NAME = YEARFILE.split(/[\/]/).pop();

const money = (n) =>
  n === null || n === undefined ? '—'
    : Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (v) => {
  const t = String(v ?? '').replace(/[^0-9.\-]/g, '');
  return t === '' ? null : Number(t);
};
const filled = (r) => r.some((c) => String(c ?? '').trim() !== '');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(56)}${detail}`);
};

/* ----------------------------------------------------------------- the file */

console.log('='.repeat(104));
console.log(`${live ? 'LIVE' : 'DRY RUN'}  ${ACCOUNT} — the year`);
console.log('='.repeat(104));

const sheets = parseXlsx(new Uint8Array(readFileSync(YEARFILE)))
  .filter((s) => /^\d{2}-\d{4}$/.test(s.name))
  .sort((a, b) => {
    const [ma, ya] = a.name.split('-');
    const [mb, yb] = b.name.split('-');
    return `${ya}${ma}`.localeCompare(`${yb}${mb}`);
  });

const months = [];
for (const s of sheets) {
  const [mm, yyyy] = s.name.split('-');
  const belongs = `${yyyy}-${mm}`;
  let opening = null;
  const rows = [];
  for (let i = 0; i < s.rows.length; i++) {
    const r = s.rows[i];
    if (!filled(r)) continue;
    const raw = String(r[0] ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) continue;
    const debit = num(r[2]) ?? 0;
    const credit = num(r[3]) ?? 0;
    const bal = num(r[4]);
    if (debit === 0 && credit === 0) {
      if (opening === null && rows.length === 0 && bal !== null) opening = bal;
      continue;
    }
    const date = raw.slice(0, 10);
    const zoho = String(r[5] ?? '').trim();
    const customer = String(r[6] ?? '').trim();
    rows.push({
      sheet: s.name, sourceRow: i + 1, rawDate: date, date, debit, credit, bal,
      narrative: String(r[1] ?? '').trim(), zoho, customer,
      // Customer is the reference column. Zoho is a workflow status, except
      // that a bank charge is marked there in the months that used it.
      reference: customer || (/^bac$/i.test(zoho) ? zoho : '') || null,
      note: customer && zoho && !/^bac$/i.test(zoho) ? zoho
            : !customer && zoho && !/^bac$/i.test(zoho) ? zoho : null,
      outOfMonth: !date.startsWith(belongs),
      // Two rows in the year carry a movement and a balance but no text at
      // all. They cannot be dropped — the running balance passes through them,
      // so losing one would break the chain from that point on — and a
      // counterparty cannot be invented for them. They go in saying exactly
      // what is true, and into the review queue so someone can read the real
      // narrative off the bank's own statement.
      noNarrative: String(r[1] ?? '').trim() === '',
    });
  }
  months.push({ name: s.name, belongs, opening, rows });
}

/* ------------------------------------------------ the chain, month by month */

console.log('\n  month      rows   from         to           opening          closing   chain');
console.log('  ' + '-'.repeat(96));
let carried = null;
let chainBreaks = 0;
let joinBreaks = 0;

for (const m of months) {
  const start = m.opening ?? carried;
  if (start === null) { console.log(`  ${m.name}  no opening balance and nothing carried in`); failures++; continue; }
  if (m.opening !== null && carried !== null && Math.abs(m.opening - carried) > 0.005) {
    console.log(`  ${m.name.padEnd(10)} JOIN BREAK: carried ${money(carried)} but the sheet opens ${money(m.opening)}`);
    joinBreaks++;
  }
  let running = start;
  let breaks = 0;
  for (const r of m.rows) {
    running = running - r.debit + r.credit;
    if (r.bal !== null && Math.abs(running - r.bal) > 0.005) { breaks++; running = r.bal; }
  }
  chainBreaks += breaks;
  console.log(
    `  ${m.name.padEnd(10)} ${String(m.rows.length).padStart(4)}   ${m.rows[0].date}   ${m.rows[m.rows.length - 1].date}   ` +
    `${money(start).padStart(14)}   ${money(running).padStart(14)}   ${breaks === 0 ? 'holds' : `${breaks} BREAKS`}`,
  );
  carried = running;
}

const allRows = months.flatMap((m) => m.rows);
const openingBalance = months[0].opening;
const openingDate = months[0].rows[0].date;

console.log('');
check('every month\'s balance chain holds', chainBreaks === 0, `${allRows.length} rows`);
check('and each month opens where the last one closed', joinBreaks === 0,
      `${months.length} months, ${joinBreaks} breaks`);
check('the year ends where the last sheet says', carried !== null,
      `${money(carried)} SAR on ${allRows[allRows.length - 1].date}`);

/* --------------------------------------------- the rows the file gets wrong */

const wrongMonth = allRows.filter((r) => r.outOfMonth);
console.log(`\n  rows dated outside the sheet they are on: ${wrongMonth.length}`);
for (const r of wrongMonth) {
  // Its neighbours prove where it belongs: the chain runs through it and the
  // sheet is a single month.
  const corrected = `${r.sheet.split('-')[1]}-${r.sheet.split('-')[0]}-${r.rawDate.slice(8, 10)}`;
  r.date = corrected;
  r.repaired = true;
  console.log(`      ${r.sheet} row ${r.sourceRow}: sheet says ${r.rawDate} -> imported as ${corrected}, flagged for review`);
  console.log(`         ${r.narrative.split(/\r?\n/)[0].slice(0, 50)}  ${r.debit ? '-' + money(r.debit) : '+' + money(r.credit)}`);
}

const blank = allRows.filter((r) => r.noNarrative);
console.log(`
  rows with a movement but no description: ${blank.length}`);
for (const r of blank) {
  r.narrative = `(no description on the ${r.sheet} sheet, row ${r.sourceRow})`;
  console.log(`      ${r.sheet} row ${r.sourceRow}: ${r.date}  ${r.debit ? '-' + money(r.debit) : '+' + money(r.credit)}  -> flagged for review`);
}

/* ------------------------------------------------------- the reference rule */

const withRef = allRows.filter((r) => r.reference).length;
const bacRows = allRows.filter((r) => /^bac$/i.test(r.reference ?? ''));
const withNote = allRows.filter((r) => r.note).length;
console.log(`\n  references: ${withRef} of ${allRows.length} rows carry one`);
console.log(`  of those, ${bacRows.length} are bank charges (bac in either column)`);
console.log(`  workflow notes kept rather than promoted to a reference: ${withNote}`);

if (failures) {
  console.log('\n  The file does not hold together. Nothing was imported.');
  process.exit(1);
}

/* ------------------------------------------------------------------ import */

const client = await connect();
try {
  const [owner] = await q(client, 'select user_id from admins where is_owner limit 1');
  const [card] = await q(client, 'select id, opening_balance::float8 ob, to_char(opening_date,\'YYYY-MM-DD\') od from cards where name = $1', [ACCOUNT]);
  if (!card) throw new Error(`${ACCOUNT} does not exist — run import_bank_ksa.mjs first`);

  console.log(`\n  the account opens today on ${card.od} at ${money(card.ob)}`);
  check('and August closes on exactly that figure, from a different file',
        Math.abs(months.find((m) => m.name === '08-2026')?.rows.slice(-1)[0].bal - card.ob) < 0.005,
        `${money(months.find((m) => m.name === '08-2026')?.rows.slice(-1)[0].bal)}`);

  await client.query('begin');
  await client.query('set local role authenticated');
  await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [owner.user_id]);

  const before = (await q(client,
    `select count(*)::int n from transactions where card_id = $1 and status <> 'voided'`,
    [card.id]))[0].n;

  /* the opening moves back to where the records start */
  await client.query(
    `update cards set opening_balance = $2, opening_date = $3, updated_at = now() where id = $1`,
    [card.id, openingBalance, openingDate],
  );
  await client.query(
    `insert into card_audit (card_id, card_name, action, detail)
     values ($1, $2, 'updated', $3::jsonb)`,
    [card.id, ACCOUNT, JSON.stringify({
      opening_balance: { from: card.ob, to: openingBalance },
      opening_date: { from: card.od, to: openingDate },
      reason:
        'The account was created from the September workbook, whose opening was the ' +
        'balance carried in. The full reconciliation workbook goes back to November 2025, ' +
        'and its August closing is exactly the figure this account opened with, so the two ' +
        'join without contradiction. The opening moves back to where the records start.',
    })],
  );
  console.log(`  opening moved: ${card.od} ${money(card.ob)}  ->  ${openingDate} ${money(openingBalance)}`);

  /* --------------------------------------- what is already here, counted */

  // create_transaction does NOT do this for us. Its duplicate guard has a
  // two-minute window — it exists to absorb a double-clicked form — and its
  // dedup key includes an occurrence number that is computed as "one more than
  // the rows already matching", so offering an existing row back produces a
  // key for occurrence 2 and inserts a second copy. Proved directly: a row
  // created 80 minutes earlier, offered again unchanged, was written again.
  //
  // So the caller has to decide what is new, and it decides by COUNT, not by
  // existence — the same rule the Import screen uses. If the ledger holds two
  // identical charges and the file offers two, both are already present; if
  // the file offers three, exactly one is new. Deciding by existence alone
  // would silently drop a genuine repeat.
  const already = new Map();
  for (const row of await q(
    client,
    `select id, to_char(txn_date, 'YYYY-MM-DD') d, amount_aed::float8 a,
            upper(coalesce(supplier_raw, '')) s, upper(coalesce(req_number, '')) r,
            source_sheet
       from transactions where card_id = $1 and status <> 'voided'
       order by created_at, id`,
    [card.id],
  )) {
    const k = `${row.d}|${row.a.toFixed(2)}|${row.s}|${row.r}`;
    if (!already.has(k)) already.set(k, []);
    already.get(k).push(row);
  }

  /* the rows */
  let recognised = 0;
  let backfilled = 0;
  const offered = new Map();
  for (const r of allRows) {
    const signed = r.credit - r.debit;
    const key =
      `${r.date}|${signed.toFixed(2)}|${r.narrative.trim().toUpperCase()}|` +
      `${(r.reference ?? '').trim().toUpperCase()}`;
    const seen = (offered.get(key) ?? 0) + 1;
    offered.set(key, seen);
    const existing = already.get(key) ?? [];
    if (seen <= existing.length) {
      recognised++;
      // These rows were imported before create_transaction could record where
      // they came from, so they carry no sheet and no row number — and with
      // created_at identical across a whole import, that leaves rows sharing a
      // date in no defined order at all. The origin is known here, so it is
      // filled in. Nothing about the money is touched.
      const row = existing[seen - 1];
      if (!row.source_sheet) {
        await client.query(
          `update transactions set source_sheet = $2, source_row = $3 where id = $1`,
          [row.id, `${r.sheet} (${SOURCE_NAME})`, r.sourceRow],
        );
        backfilled++;
      }
      continue;
    }
    const noteParts = [];
    if (r.note) noteParts.push(`sheet note: ${r.note}`);
    if (r.repaired) noteParts.push(`the sheet dated this ${r.rawDate}`);
    const [res] = await q(
      client,
      // allow_duplicate, because the decision has already been made above and
      // by a better rule. Left off, create_transaction's two-minute guard sees
      // the identical row this import wrote seconds earlier and returns it
      // instead of writing the second one — so a charge the bank genuinely
      // levied twice on the same day, for the same amount, with the same
      // narrative, silently becomes one. The year contains such a pair, and
      // the missing 1.15 showed up as the closing balance being 1.15 too high.
      `select create_transaction(
          p_card_id := $1, p_txn_date := $2, p_kind := $3, p_amount_aed := $4,
          p_supplier := $5, p_req_number := $6, p_payment_ref := null,
          p_notes := $7, p_statement_balance := $8,
          p_needs_review := $9, p_review_reason := $10,
          p_allow_duplicate := true,
          p_source_sheet := $11, p_source_row := $12) as id`,
      [
        card.id, r.date, signed < 0 ? 'purchase' : 'funding', Math.abs(signed),
        r.narrative, r.reference, noteParts.join(' — ') || null, r.bal,
        Boolean(r.repaired || r.noNarrative),
        r.repaired
          ? `The ${r.sheet} sheet dates this ${r.rawDate}, a year later than the month it sits in. ` +
            `Imported as ${r.date} because the sheet's running balance passes through it in sequence. ` +
            'Confirm the date.'
          : r.noNarrative
          ? `The ${r.sheet} sheet records this movement and its balance but no description at all. ` +
            'It is imported because the running balance passes through it; read the narrative off ' +
            'the bank statement for this date and amount, and put it on the row.'
          : null,
        // Where this row is, in the file it came from. Without it rows sharing
        // a date have no defined order, because created_at is one value for
        // the whole import.
        `${r.sheet} (${SOURCE_NAME})`,
        r.sourceRow,
      ],
    );
    if (!res.id) failures++;
  }

  const after = (await q(client,
    `select count(*)::int n from transactions where card_id = $1 and status <> 'voided'`,
    [card.id]))[0].n;
  const written = after - before;

  console.log(`\n  ${allRows.length} rows offered, ${written} written, ${recognised} already present`);
  // Counted independently on both sides: what this script decided to skip, and
  // what the table actually grew by. If those disagree, something was written
  // that should not have been, or swallowed that should not have been.
  check('the September rows already in the ledger were recognised, not repeated',
        recognised === before, `${recognised} recognised, ${before} were already there`);
  check('and every row this import judged new was actually written',
        written === allRows.length - recognised,
        `${written} written, ${allRows.length - recognised} expected`);
  if (backfilled)
    console.log(`  ${backfilled} rows imported earlier were given the source they came from`);

  /* ------------------------------------------------------------ the result */

  const [bal] = await q(client,
    `select ledger_balance::float8 l, transaction_count::int n from card_balances where card_id = $1`,
    [card.id]);
  check('the ledger balance is where the year ends', Math.abs(bal.l - carried) < 0.005,
        `${money(bal.l)} vs ${money(carried)}`);

  const perRow = await q(client,
    `select count(*)::int n from (
       select t.statement_balance
              - ($2::numeric + sum(t.amount_aed) over (
                  -- The FILE's order, not the date's. The 06-2026 sheet lists a
                  -- 2 June row at row 13 and three 1 June rows at 15-17, and the
                  -- bank's running balance follows the sheet down the page. Sorting
                  -- by date first reorders them and every balance after the first
                  -- swap looks wrong. The month comes from the sheet name reversed
                  -- to YYYYMM, because '01-2026' sorts before '11-2025' as text.
                  order by substring(t.source_sheet from 4 for 4) || substring(t.source_sheet from 1 for 2),
                           t.source_row, t.created_at
                  rows between unbounded preceding and current row)) as diff
         from transactions t
        where t.card_id = $1 and t.status <> 'voided' and t.statement_balance is not null
     ) x where abs(diff) > 0.005`,
    [card.id, openingBalance]);
  check('every printed balance matches the running total to that point',
        perRow[0].n === 0, `${perRow[0].n} of ${bal.n} rows disagree`);

  if (perRow[0].n > 0) {
    // Naming them, because "7 rows disagree" is not something anyone can act
    // on. Either the file's stated balance is wrong at that point, or the rows
    // are being compared in an order the sheet did not put them in.
    const offenders = await q(
      client,
      `select * from (
         select to_char(t.txn_date, 'YYYY-MM-DD') d, t.source_sheet, t.source_row,
                t.amount_aed::float8 amt, t.statement_balance::float8 says,
                ($2::numeric + sum(t.amount_aed) over (
                   order by substring(t.source_sheet from 4 for 4) || substring(t.source_sheet from 1 for 2),
                            t.source_row, t.created_at
                   rows between unbounded preceding and current row))::float8 computed,
                left(coalesce(t.supplier_raw, ''), 44) what
           from transactions t
          where t.card_id = $1 and t.status <> 'voided' and t.statement_balance is not null
       ) x where abs(says - computed) > 0.005 order by d limit 10`,
      [card.id, openingBalance],
    );
    console.log('\n      the rows that disagree:\n');
    for (const o of offenders)
      console.log(`        ${o.d}  ${String(o.source_sheet ?? '—').slice(0, 9).padEnd(10)} row ${String(o.source_row ?? '—').padStart(4)}  ` +
        `amount ${money(o.amt).padStart(13)}   sheet says ${money(o.says).padStart(14)}   computed ${money(o.computed).padStart(14)}   ${o.what}`);
  }

  const [{ n: outside }] = await q(client,
    `select count(*)::int n from rows_before_opening where card_id = $1`, [card.id]);
  check('no row is stranded before the opening date', outside === 0, `${outside}`);

  const [{ n: flagged }] = await q(client,
    `select count(*)::int n from transactions where card_id = $1 and status = 'needs_review'`,
    [card.id]);
  check('what the file gets wrong is in the review queue, not silently accepted',
        flagged === wrongMonth.length + blank.length,
        `${flagged} awaiting a decision (${wrongMonth.length} mistyped dates, ${blank.length} with no description)`);

  const [bac] = await q(client,
    `select count(*)::int n, sum(-amount_aed)::float8 total from transactions
      where card_id = $1 and status <> 'voided' and upper(btrim(req_number)) = 'BAC'`,
    [card.id]);
  check('BAC totals as one group however it was spelled', bac.n > 0,
        `${bac.n} rows, ${money(bac.total)} SAR of charges`);

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

console.log('\n' + '='.repeat(104));
if (failures) { console.log(`${failures} CHECK(S) FAILED`); process.exit(1); }
console.log('The year imports as one chain, and September was not written twice.');
console.log('='.repeat(104));
