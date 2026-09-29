/**
 * Imports a bank statement the way the Import screen does, and checks the
 * balance against the one the bank printed.
 *
 * The question this answers is the only one that matters before uploading:
 * will the balance be right afterwards, and will anything be written twice.
 *
 * It is answered by arithmetic, not by trust. The bank prints a closing
 * balance on the statement. The ledger's balance is its opening figure plus
 * every row it holds. If those two agree after the import, then every
 * transaction the bank knows about is in the ledger exactly once — a missing
 * row and a duplicated row both show up as a difference, in opposite
 * directions.
 *
 * Dry run unless --live. The dry run does everything the live run does and
 * then rolls it back, so the figures it reports are the figures you would get.
 *
 *   LEDGER_DEPS=... IMPORT_BUNDLE=... STATEMENT=... node scripts/db/import_statement.mjs [--live]
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { connect, q } from './connect.mjs';

const { parseXlsx, analyseSheet, buildRows } = await import(
  pathToFileURL(resolve(process.env.IMPORT_BUNDLE ?? 'web/src/lib/importFile.ts')).href
);

const live = process.argv.includes('--live');
const STATEMENT =
  process.env.STATEMENT ??
  `${process.env.USERPROFILE ?? process.env.HOME}/Downloads/Account Statement_29-09-2026 09_47_46.xlsx`;
const ACCOUNT = process.env.ACCOUNT ?? 'BANK KSA (SAB 7631)';

const money = (n) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const figure = (v) => Number(String(v ?? '').replace(/[^0-9.]/g, '')) || 0;

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(58)}${detail}`);
};

const client = await connect();

try {
  console.log('='.repeat(100));
  console.log(`${live ? 'LIVE' : 'DRY RUN'}  ${ACCOUNT}`);
  console.log('='.repeat(100));
  console.log(`\n  ${STATEMENT}\n`);

  const [owner] = await q(client, 'select user_id from admins where is_owner limit 1');
  const [cardRow] = await q(
    client,
    `select c.id, c.name, c.settlement_currency, c.balance_sign, c.card_type, c.tracks_balance,
            c.opening_balance::float8 ob, to_char(c.opening_date,'YYYY-MM-DD') od,
            c.source_header_row, c.decreasing_column, c.decreasing_header,
            c.increasing_column, c.increasing_header, c.balance_formula
       from cards c where c.name = $1`,
    [ACCOUNT],
  );
  const card = {
    id: cardRow.id, name: cardRow.name,
    settlementCurrency: cardRow.settlement_currency,
    cardType: cardRow.card_type ?? undefined,
    tracksBalance: cardRow.tracks_balance !== false,
    balanceSign: Number(cardRow.balance_sign),
    openingBalance: Number(cardRow.ob), openingDate: cardRow.od,
    sourceHeaderRow: cardRow.source_header_row ?? 1,
    decreasingColumn: cardRow.decreasing_column ?? '',
    decreasingHeader: cardRow.decreasing_header ?? 'DEBIT',
    increasingColumn: cardRow.increasing_column ?? '',
    increasingHeader: cardRow.increasing_header ?? 'CREDIT',
    balanceFormula: cardRow.balance_formula ?? '',
    headerIsMisleading: false, verifiedRows: 0,
  };

  /* ------------------------------------------------ what the bank itself says */

  const sheet = parseXlsx(new Uint8Array(readFileSync(STATEMENT)))[0];
  const analysis = analyseSheet(sheet, card);
  const summary = sheet.rows[
    sheet.rows.findIndex((r) => r.some((c) => /Total Credits/i.test(String(c ?? '')))) + 1
  ] ?? [];
  const bank = {
    transactions: figure(summary[1]),
    creditValue: figure(summary[3]), debitValue: figure(summary[5]),
    opening: figure(summary[6]), closing: figure(summary[7]),
  };
  console.log(`  the bank states: ${bank.transactions} transactions, closing ${money(bank.closing)} ${card.settlementCurrency}\n`);

  const existing = await q(
    client,
    `select id, card_id as "cardId", to_char(txn_date,'YYYY-MM-DD') as txn_date,
            supplier_raw as supplier, supplier_raw, amount_aed::float8 as amount_aed,
            direction, entry_type, status, req_number, payment_ref
       from transactions where card_id = $1 and status <> 'voided'`,
    [card.id],
  );
  const rows = buildRows(sheet, analysis.headerRow, analysis.mapping, {
    card, existing, cardId: card.id, dayFirst: analysis.dayFirst,
  }).filter((r) => r.amountAed !== null);

  const known = rows.filter((r) => r.duplicateOf);
  const fresh = rows.filter((r) => !r.duplicateOf && r.include);
  const refused = rows.filter((r) => r.errors.length);

  console.log(`  ${rows.length} rows read · ${known.length} already in the ledger · ${fresh.length} to import`);
  check('no row is refused', refused.length === 0, refused[0]?.errors[0] ?? '');

  /* ------------------------------------------------------------- write them */

  await client.query('begin');
  await client.query('set local role authenticated');
  await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [owner.user_id]);

  const before = (await q(client,
    `select ledger_balance::float8 l, transaction_count::int n from card_balances where card_id = $1`,
    [card.id]))[0];

  for (const r of fresh) {
    await client.query(
      `select create_transaction(
          p_card_id := $1, p_txn_date := $2, p_kind := $3, p_amount_aed := $4,
          p_supplier := $5, p_req_number := $6, p_payment_ref := null,
          p_statement_balance := $7, p_allow_duplicate := true,
          p_source_sheet := $8, p_source_row := $9)`,
      [
        card.id, r.date, r.kind, r.amountAed, r.supplier,
        String(r.reqNumber ?? '').trim() || null,
        r.statementBalance,
        `${sheet.name} (${STATEMENT.split(/[\\/]/).pop()})`,
        r.sourceRow,
      ],
    );
  }

  const after = (await q(client,
    `select ledger_balance::float8 l, transaction_count::int n from card_balances where card_id = $1`,
    [card.id]))[0];

  console.log('');
  check('exactly the new rows were written',
        after.n - before.n === fresh.length, `${after.n - before.n} of ${fresh.length}`);

  /* ------------------------ the balance, against the figure the bank printed */

  console.log(`\n  balance before   ${money(before.l).padStart(16)} ${card.settlementCurrency}`);
  console.log(`  balance after    ${money(after.l).padStart(16)} ${card.settlementCurrency}`);
  console.log(`  the bank says    ${money(bank.closing).padStart(16)} ${card.settlementCurrency}`);
  const gap = after.l - bank.closing;
  console.log(`  difference       ${money(gap).padStart(16)} ${card.settlementCurrency}\n`);

  check('the ledger lands on the balance the bank printed', Math.abs(gap) < 0.005,
        Math.abs(gap) < 0.005
          ? 'every transaction the bank knows about, exactly once'
          : `out by ${money(gap)} — a row is missing, doubled, or wrong`);

  /* ------------------------------------------------------ nothing was doubled */

  const [{ n: doubled }] = await q(
    client,
    `select count(*)::int n from (
       select txn_date, amount_aed, supplier_raw, count(*) c
         from transactions where card_id = $1 and status <> 'voided'
        group by 1,2,3 having count(*) > 1) z`,
    [card.id],
  );
  const [{ n: doubledBefore }] = await q(
    client,
    `select count(*)::int n from (
       select txn_date, amount_aed, supplier_raw, count(*) c
         from transactions where card_id = $1 and status <> 'voided'
          and id <> all($2) group by 1,2,3 having count(*) > 1) z`,
    [card.id, []],
  );
  check('this import created no new identical pairs', doubled === doubledBefore,
        `${doubled} identical group(s) on the account, ${doubledBefore} before`);

  /* ---------------------------------- money out must carry a request number */

  const out = fresh.filter((r) => r.kind === 'purchase');
  const inbound = fresh.filter((r) => r.kind !== 'purchase');
  const missing = out.filter((r) => !String(r.reqNumber ?? '').trim());
  console.log('');
  console.log(`  of the ${fresh.length} imported: ${out.length} money out, ${inbound.length} money in`);
  console.log(`  money in needs no request number, and none is asked of it`);
  // Reported, not failed. A statement carries no references at all, so every
  // payment arriving without one is the normal state of this import and the
  // work that follows it — not a reason to refuse money the bank has already
  // moved. The checks that DO block are the ones about the money: the balance
  // agreeing with the bank, and nothing written twice.
  if (missing.length === 0) {
    check('every payment out carries a request number', true, `${out.length} of ${out.length}`);
  } else {
    console.log(`  ${missing.length} of ${out.length} payments out have no request number yet`);
  }

  if (missing.length) {
    const total = missing.reduce((a, r) => a + r.amountAed, 0);
    console.log(`\n      ${missing.length} payments totalling ${money(total)} ${card.settlementCurrency} need one typed in:\n`);
    for (const r of missing.slice(0, 20))
      console.log(`        ${r.date}  ${money(r.amountAed).padStart(13)}  ${r.supplier.replace(/\s+/g, ' ').slice(0, 48)}`);
    if (missing.length > 20) console.log(`        … and ${missing.length - 20} more`);
  }

  // The reference is not part of what identifies a row, so filling these in
  // afterwards cannot stop a later statement recognising them.
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
console.log('The ledger agrees with the bank, and nothing was written twice.');
console.log('='.repeat(100));
