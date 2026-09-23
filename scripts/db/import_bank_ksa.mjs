/**
 * The KSA bank account, from the workbook that records it.
 *
 * Creates the account if it is not there, then imports every dated row of
 * BANK ksa.xlsx through create_transaction — the same door the Import screen
 * uses, so the same dedup, the same audit trail, the same refusals.
 *
 * WHAT THIS DOES NOT GUESS
 *
 * Direction. Not from the words DEBIT and CREDIT, which are a column heading
 * and not a fact, but from the sheet's own running balance: the chain is
 * walked first and the import refuses to start if a DEBIT-lowers-it reading
 * does not reproduce every balance in the file.
 *
 * The counterparty. A bank narrative has no fixed shape — the other party is
 * on line 3 of an outgoing transfer, line 2 of a SADAD payment, and absent
 * from a charge — so no line is singled out as "the supplier". The whole
 * narrative is stored as written. That is also what makes a row identifiable:
 * date, amount and type alone collide 17 times in a single fortnight, once six
 * ways, while date + amount + narrative is distinct across all of them.
 *
 * The reference. Whatever sits in the Customer column — KSAML2325, BAC, 872 —
 * is carried across verbatim into the request number, where the search totals
 * already net and sum it. Nothing is reclassified on the way.
 *
 * Dry run unless --live is passed, and the dry run reports exactly what the
 * live run would write.
 *
 *   LEDGER_DEPS=... IMPORT_BUNDLE=... WORKBOOK=... node scripts/db/import_bank_ksa.mjs
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
const WORKBOOK =
  process.env.WORKBOOK ??
  `${process.env.USERPROFILE ?? process.env.HOME}/Downloads/BANK ksa.xlsx`;

const ACCOUNT = {
  name: 'BANK KSA (SAB 7631)',
  currency: 'SAR',
  // The last four, not the IBAN. create_card refuses a full account number and
  // is right to: the ledger has no use for one, and storing it would put a
  // payable account number in front of everyone who can read the ledger.
  reference: '7631',
  issuer: 'Saudi Awwal Bank (SAB)',
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
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(58)}${detail}`);
};

/* ------------------------------------------------------------ read the file */

const sheet = parseXlsx(new Uint8Array(readFileSync(WORKBOOK)))[0];
const opening = num(sheet.rows[1]?.[4]);
const rows = sheet.rows
  .map((r, i) => ({ r, sourceRow: i + 1 }))
  // Row 0 is the header and its first cell is the word DATE, which is not
  // blank and so survives a "has a date" filter. Row 1 carries the opening
  // balance and no transaction. Both are dropped by requiring a real date.
  .filter(({ r }) => /^\d{4}-\d{2}-\d{2}/.test(String(r[0] ?? '').trim()))
  .map(({ r, sourceRow }) => ({
    sourceRow,
    date: String(r[0]).trim().slice(0, 10),
    debit: num(r[2]) ?? 0,
    credit: num(r[3]) ?? 0,
    balance: num(r[4]),
    narrative: String(r[1] ?? '').trim(),
    reference: String(r[6] ?? '').trim(),
  }));

console.log('='.repeat(98));
console.log(`${live ? 'LIVE' : 'DRY RUN'}  ${ACCOUNT.name}  —  ${WORKBOOK}`);
console.log('='.repeat(98));
console.log(`\n  ${rows.length} dated rows, opening ${money(opening)} ${ACCOUNT.currency}`);
console.log(`  ${rows[0].date} to ${rows[rows.length - 1].date}\n`);

/* ------------------------- the direction, proved before anything is written */

let running = opening;
let breaks = 0;
for (const row of rows) {
  running = running - row.debit + row.credit;
  if (row.balance !== null && Math.abs(running - row.balance) > 0.005) {
    if (breaks < 3)
      console.log(`  CHAIN BREAK at row ${row.sourceRow} (${row.date}): computed ${money(running)} vs sheet ${money(row.balance)}`);
    breaks++;
    running = row.balance;
  }
}
check('DEBIT lowers the balance and CREDIT raises it', breaks === 0,
      `${rows.length} rows, ${breaks} breaks`);
const closing = rows[rows.length - 1].balance;
check('and the chain ends where the sheet says', Math.abs(running - closing) < 0.005,
      `${money(closing)} ${ACCOUNT.currency}`);

const totalDebit = rows.reduce((a, r) => a + r.debit, 0);
const totalCredit = rows.reduce((a, r) => a + r.credit, 0);
check('opening + credits - debits reaches the closing balance',
      Math.abs(opening + totalCredit - totalDebit - closing) < 0.005,
      `${money(opening)} + ${money(totalCredit)} - ${money(totalDebit)}`);

const noNarrative = rows.filter((r) => !r.narrative).length;
check('every row has a narrative to identify it by', noNarrative === 0,
      noNarrative ? `${noNarrative} without one` : `${rows.length} rows`);

if (failures) {
  console.log('\n  The file does not hold together. Nothing was imported.');
  process.exit(1);
}

/* ------------------------------------------------------------------ import */

const client = await connect();
try {
  const [owner] = await q(client, 'select user_id, email from admins where is_owner limit 1');
  if (!owner) throw new Error('no owner account to run as');

  await client.query('begin');
  await client.query('set local role authenticated');
  await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [owner.user_id]);

  /* the account */
  let [card] = await q(client, 'select id, settlement_currency from cards where name = $1', [
    ACCOUNT.name,
  ]);
  if (!card) {
    // The opening date is the first row in this file. The account is older
    // than that — earlier statements are still to come — so this is where the
    // RECORDS start, not where the account did. When the earlier months
    // arrive, the opening date moves back and those rows count, exactly as
    // MASTERCARD 6404's did. Until then rows_before_opening will show anything
    // dated earlier rather than letting it sit in no balance unnoticed.
    const [created] = await q(
      client,
      `select create_card(
          p_name := $1, p_opening_balance := $2, p_opening_date := $3,
          p_card_type := 'bank_account', p_status := 'active',
          p_settlement_currency := $4, p_bank_issuer := $5,
          p_account_reference := $6, p_balance_sign := 1::smallint,
          p_notes := $7) as id`,
      [
        ACCOUNT.name, opening, rows[0].date, ACCOUNT.currency, ACCOUNT.issuer, ACCOUNT.reference,
        'Current account in SAR. The opening balance is the statement opening for ' +
          `${rows[0].date}; earlier months are still to be loaded, so this is where the records ` +
          'start and not where the account did.',
      ],
    );
    card = { id: created.id, settlement_currency: ACCOUNT.currency };
    console.log(`\n  account created: ${ACCOUNT.name}  ${ACCOUNT.currency}  opening ${money(opening)} on ${rows[0].date}`);
  } else {
    console.log(`\n  account already exists (${card.settlement_currency})`);
    if (card.settlement_currency !== ACCOUNT.currency)
      throw new Error(`the account settles in ${card.settlement_currency}, not ${ACCOUNT.currency}`);
  }

  /* the rows */
  const countRows = async () =>
    (await q(client,
      `select count(*)::int n from transactions where card_id = $1 and status <> 'voided'`,
      [card.id]))[0].n;

  const importRows = async (batch) => {
    const before = await countRows();
    for (const row of batch) {
      const signed = row.credit - row.debit;
      if (signed === 0) continue;
      await client.query(
        `select create_transaction(
            p_card_id := $1, p_txn_date := $2, p_kind := $3, p_amount_aed := $4,
            p_supplier := $5, p_req_number := $6, p_payment_ref := null,
            p_statement_balance := $7)`,
        [
          card.id,
          row.date,
          signed < 0 ? 'purchase' : 'funding',
          Math.abs(signed),
          row.narrative,
          row.reference || null,
          row.balance,
        ],
      );
    }
    // Counted from the table, not from what the calls returned.
    // create_transaction hands back the existing row's id when the content and
    // occurrence already match, so an overlapping upload adds nothing and the
    // count is the only honest measure of what was written.
    return (await countRows()) - before;
  };

  // The thing worth proving, proved on the real file rather than a fixture:
  // upload part of it, then upload the whole thing over the top. This is the
  // case that was asked about — a statement covering two days when only the
  // first half day was recorded.
  const PART = 120;
  const firstPass = await importRows(rows.slice(0, PART));
  const secondPass = await importRows(rows);
  const onCard = await countRows();

  console.log(`\n  first upload  (rows 1-${PART}):   ${firstPass} written`);
  console.log(`  second upload (all ${rows.length}):    ${secondPass} written — the overlap added nothing`);
  console.log(`  on the account in all:        ${onCard}\n`);

  check(`re-uploading the overlap wrote only what was new`,
        firstPass === PART && secondPass === rows.length - PART,
        `${firstPass} + ${secondPass} = ${firstPass + secondPass}`);
  check('and the account holds each row exactly once',
        onCard === rows.length, `${onCard} of ${rows.length}`);

  const [{ n: dupeKeys }] = await q(
    client,
    `select count(*)::int n from (
       select dedup_key from transactions where card_id = $1
        group by dedup_key having count(*) > 1) x`,
    [card.id],
  );
  check('no two rows share an identity', dupeKeys === 0, `${dupeKeys} shared keys`);

  /* ------------------------------------------- what the ledger now says */

  const [bal] = await q(
    client,
    `select ledger_balance::float8 l, source_balance::float8 s, transaction_count::int n
       from card_balances where card_id = $1`,
    [card.id],
  );
  check('the ledger balance is the sheet\'s closing balance',
        Math.abs(bal.l - closing) < 0.005, `${money(bal.l)} vs ${money(closing)}`);

  const [daily] = await q(client, 'select * from bank_daily_check where card_id = $1', [card.id]);
  check('the bank\'s own last stated balance agrees with the ledger',
        daily && Math.abs(Number(daily.difference)) < 0.005,
        daily ? `bank ${money(daily.bank_says)} vs ledger ${money(daily.ledger_says)}` : 'no row');
  check('and every row carries the balance the bank printed',
        daily && Number(daily.rows_without_a_stated_balance) === 0,
        daily ? `${daily.rows_without_a_stated_balance} without one` : '');

  // The per-row check, which is what catches a row missing from the middle.
  const perRow = await q(
    client,
    `select count(*)::int n from (
       select t.statement_balance
              - ($2::numeric + sum(t.amount_aed) over (
                  order by t.txn_date, t.source_row, t.created_at
                  rows between unbounded preceding and current row)) as diff
         from transactions t
        where t.card_id = $1 and t.status <> 'voided' and t.statement_balance is not null
     ) x where abs(diff) > 0.005`,
    [card.id, opening],
  );
  check('every printed balance matches the running total to that point',
        perRow[0].n === 0, `${perRow[0].n} rows disagree`);

  /* --------------------------------------------- what a filter would give */

  const refs = await q(
    client,
    `select coalesce(nullif(btrim(req_number), ''), '(none)') as ref,
            count(*)::int n,
            sum(case when amount_aed < 0 then -amount_aed else 0 end)::float8 out,
            sum(case when amount_aed > 0 then  amount_aed else 0 end)::float8 inn
       from transactions where card_id = $1 and status <> 'voided'
      group by 1 order by count(*) desc limit 8`,
    [card.id],
  );
  console.log('\n  filtering by reference would total:\n');
  for (const r of refs)
    console.log(`    ${r.ref.padEnd(22)} ${String(r.n).padStart(4)} rows   out ${money(r.out).padStart(13)}   in ${money(r.inn).padStart(13)}`);

  const [bac] = await q(
    client,
    `select count(*)::int n, sum(-amount_aed)::float8 total from transactions
      where card_id = $1 and status <> 'voided' and upper(btrim(req_number)) = 'BAC'`,
    [card.id],
  );
  check('BAC is searchable as one group', bac.n > 0,
        `${bac.n} rows, ${money(bac.total)} ${ACCOUNT.currency} of bank charges`);

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

console.log('\n' + '='.repeat(98));
if (failures) {
  console.log(`${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('The account agrees with the bank on every row, not just at the end.');
console.log('='.repeat(98));
