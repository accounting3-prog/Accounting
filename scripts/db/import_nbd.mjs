/**
 * The NBD payment account: what was paid, in what currency, and its cost in AED.
 *
 * Not a statement and not a balance. Each row is one payment sent through the
 * rail — the beneficiary, the currency it was paid in, the amount, the dirham
 * equivalent the bank charged, and the request it belongs to. Nothing is
 * reconciled because there is nothing to reconcile it against.
 *
 * WHAT IS CHECKED BEFORE ANYTHING IS WRITTEN
 *
 * The file's own arithmetic. Every row where the payment currency is AED must
 * have an identical dirham figure, or the two columns do not mean what they
 * say. Every other row implies a rate, and rates within one currency must sit
 * in a believable band — a EUR row implying 0.4 would mean the columns had
 * been swapped. The implied rate is stored per row, as the ledger does for
 * every converted transaction, rather than recomputed later from a rate table
 * that did not exist on the day.
 *
 *   LEDGER_DEPS=... IMPORT_BUNDLE=... NBDFILE=... node scripts/db/import_nbd.mjs [--live]
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { connect, q } from './connect.mjs';

const { parseXlsx } = await import(
  pathToFileURL(resolve(process.env.IMPORT_BUNDLE ?? 'web/src/lib/importFile.ts')).href
);

const live = process.argv.includes('--live');
const FILE =
  process.env.NBDFILE ??
  `${process.env.USERPROFILE ?? process.env.HOME}/Downloads/NBD Bank Transactions.xlsx`;

const ACCOUNT = {
  name: 'NBD (payments)',
  currency: 'AED',
  issuer: 'Emirates NBD',
};

const money = (n) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (v) => {
  const t = String(v ?? '').replace(/[^0-9.\-]/g, '');
  return t === '' ? null : Number(t);
};

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(60)}${detail}`);
};

/* ----------------------------------------------------------------- the file */

const sheet = parseXlsx(new Uint8Array(readFileSync(FILE)))[0];
const rows = sheet.rows
  .map((r, i) => ({ r, sourceRow: i + 1 }))
  .filter(({ r }) => String(r[1] ?? '').trim() && num(r[4]) !== null)
  .map(({ r, sourceRow }) => {
    const [, dmy, who, ccy, amount, ref, local, aed] = r;
    const d = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(dmy).trim());
    return {
      sourceRow,
      rawDate: String(dmy).trim(),
      date: d ? `${d[3]}-${d[2]}-${d[1]}` : null,
      who: String(who ?? '').trim(),
      currency: String(ccy ?? '').trim().toUpperCase(),
      amount: num(amount),
      reference: String(ref ?? '').trim(),
      localCurrency: String(local ?? '').trim().toUpperCase(),
      aed: num(aed),
    };
  });

console.log('='.repeat(100));
console.log(`${live ? 'LIVE' : 'DRY RUN'}  ${ACCOUNT.name}  —  ${FILE}`);
console.log('='.repeat(100));
console.log(`\n  ${rows.length} payments, ${rows[0]?.rawDate} to ${rows[rows.length - 1]?.rawDate}\n`);

check('every row has a date that reads', rows.every((r) => r.date),
      `${rows.filter((r) => !r.date).length} unreadable`);
check('every row names who was paid', rows.every((r) => r.who));
check('every row carries a request number', rows.every((r) => r.reference),
      `${rows.filter((r) => !r.reference).length} without one`);
check('every row states its dirham cost', rows.every((r) => r.aed !== null));
check('the local currency is AED on every row',
      rows.every((r) => r.localCurrency === 'AED'),
      [...new Set(rows.map((r) => r.localCurrency))].join(', '));

// An AED payment must cost exactly itself, or the two amount columns do not
// mean what their headers say.
const aedRows = rows.filter((r) => r.currency === 'AED');
const mismatched = aedRows.filter((r) => Math.abs(r.amount - r.aed) > 0.005);
check('a payment made in AED costs exactly itself', mismatched.length === 0,
      `${aedRows.length} AED rows, ${mismatched.length} disagree`);

/* the rate each row implies, and whether it is believable */

const byCurrency = new Map();
for (const r of rows) {
  if (!byCurrency.has(r.currency)) byCurrency.set(r.currency, []);
  byCurrency.get(r.currency).push(r);
}
console.log('\n  currency    rows          paid              AED        implied rate');
console.log('  ' + '-'.repeat(78));
let wild = 0;
for (const [ccy, list] of [...byCurrency.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const rates = list.filter((r) => r.amount).map((r) => r.aed / r.amount);
  const lo = Math.min(...rates), hi = Math.max(...rates);
  // Within one currency over nine months a rate moves; it does not double.
  // A row outside that is a swapped column, not a market.
  if (hi / lo > 1.5) wild++;
  console.log(
    `  ${ccy.padEnd(10)} ${String(list.length).padStart(4)} ` +
    `${money(list.reduce((a, r) => a + r.amount, 0)).padStart(15)} ` +
    `${money(list.reduce((a, r) => a + r.aed, 0)).padStart(16)}   ` +
    `${lo.toFixed(4)} – ${hi.toFixed(4)}`,
  );
}
check('no currency implies a rate that moved by half', wild === 0, `${wild} suspicious`);

const totalAed = rows.reduce((a, r) => a + r.aed, 0);
console.log(`\n  total cost: ${money(totalAed)} AED across ${byCurrency.size} currencies\n`);

if (failures) {
  console.log('  The file does not hold together. Nothing was imported.');
  process.exit(1);
}

/* ------------------------------------------------------------------ import */

const client = await connect();
try {
  const [owner] = await q(client, 'select user_id from admins where is_owner limit 1');
  let [card] = await q(client, 'select id, tracks_balance from cards where name = $1', [ACCOUNT.name]);

  await client.query('begin');
  await client.query('set local role authenticated');
  await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [owner.user_id]);

  if (!card) {
    const [created] = await q(
      client,
      `select create_card(
          p_name := $1, p_opening_balance := 0, p_opening_date := null,
          p_card_type := 'payment_account', p_status := 'active',
          p_settlement_currency := $2, p_bank_issuer := $3,
          p_tracks_balance := false, p_notes := $4) as id`,
      [
        ACCOUNT.name, ACCOUNT.currency, ACCOUNT.issuer,
        'A record of payments sent through NBD, not a balance. Each row is what was paid, ' +
          'in the currency it was paid in, and what it cost in dirhams. There is no opening ' +
          'figure and nothing to reconcile.',
      ],
    );
    card = { id: created.id, tracks_balance: false };
    console.log(`  account created: ${ACCOUNT.name} — no balance tracked\n`);
  } else {
    console.log(`  account already exists (tracks_balance = ${card.tracks_balance})\n`);
  }

  /* what is already here, counted rather than merely present */
  const already = new Map();
  for (const row of await q(
    client,
    `select to_char(txn_date,'YYYY-MM-DD') d, amount_aed::float8 a,
            upper(coalesce(supplier_raw,'')) s, upper(coalesce(req_number,'')) r
       from transactions where card_id = $1 and status <> 'voided'`,
    [card.id],
  )) {
    const k = `${row.d}|${row.a.toFixed(2)}|${row.s}|${row.r}`;
    already.set(k, (already.get(k) ?? 0) + 1);
  }

  const before = (await q(client,
    `select count(*)::int n from transactions where card_id = $1 and status <> 'voided'`,
    [card.id]))[0].n;

  let recognised = 0;
  const offered = new Map();
  for (const r of rows) {
    const key = `${r.date}|${(-r.aed).toFixed(2)}|${r.who.toUpperCase()}|${r.reference.toUpperCase()}`;
    const seen = (offered.get(key) ?? 0) + 1;
    offered.set(key, seen);
    if (seen <= (already.get(key) ?? 0)) { recognised++; continue; }

    await client.query(
      `select create_transaction(
          p_card_id := $1, p_txn_date := $2, p_kind := 'purchase', p_amount_aed := $3,
          p_supplier := $4, p_req_number := $5, p_payment_ref := null,
          p_currency := $6, p_original_amount := $7, p_exchange_rate := $8,
          p_allow_duplicate := true,
          p_source_sheet := $9, p_source_row := $10)`,
      [
        card.id, r.date, r.aed, r.who, r.reference,
        // An AED payment is not a conversion of anything, so it carries no
        // currency detail and no rate — the ledger refuses a rate on an AED row.
        r.currency === 'AED' ? null : r.currency,
        r.currency === 'AED' ? null : r.amount,
        r.currency === 'AED' || !r.amount ? null : Number((r.aed / r.amount).toFixed(10)),
        `${sheet.name} (${FILE.split(/[\\/]/).pop()})`,
        r.sourceRow,
      ],
    );
  }

  const after = (await q(client,
    `select count(*)::int n from transactions where card_id = $1 and status <> 'voided'`,
    [card.id]))[0].n;

  console.log(`  ${rows.length} offered, ${after - before} written, ${recognised} already present\n`);
  check('every payment the file holds is in the ledger', after === rows.length,
        `${after} rows`);

  /* ------------------------------------------------------- what it now says */

  const [sum] = await q(
    client,
    `select count(*)::int n, sum(-amount_aed)::float8 aed,
            count(distinct currency)::int currencies
       from transactions where card_id = $1 and status <> 'voided'`,
    [card.id],
  );
  check('the dirham cost matches the file', Math.abs(sum.aed - totalAed) < 0.02,
        `${money(sum.aed)} vs ${money(totalAed)}`);

  const perCcy = await q(
    client,
    `select coalesce(currency, 'AED') c, count(*)::int n,
            sum(coalesce(original_amount, -amount_aed))::float8 orig,
            sum(-amount_aed)::float8 aed
       from transactions where card_id = $1 and status <> 'voided'
      group by 1 order by count(*) desc`,
    [card.id],
  );
  console.log('\n  as the ledger now holds it:\n');
  for (const p of perCcy)
    console.log(`    ${p.c.padEnd(6)} ${String(p.n).padStart(4)} payments  ${money(p.orig).padStart(16)} ${p.c}  =  ${money(p.aed).padStart(15)} AED`);

  // The reason tracks_balance exists.
  const [{ tracks }] = await q(client, 'select tracks_balance as tracks from cards where id = $1', [card.id]);
  check('the account holds no balance, by its own setting', tracks === false);

  if (live && failures === 0) {
    await client.query('commit');
    console.log('\n  COMMITTED.');
  } else {
    await client.query('rollback');
    console.log(failures ? '\n  Rolled back — checks failed.' : '\n  Rolled back — re-run with --live.');
  }
} finally {
  await client.end();
}

console.log('\n' + '='.repeat(100));
if (failures) { console.log(`${failures} CHECK(S) FAILED`); process.exit(1); }
console.log('Every payment carries its own currency, its cost, who was paid and the request.');
console.log('='.repeat(100));
