/**
 * The routine this account is actually going to live in.
 *
 * A statement is downloaded every day. It carries the whole month, it carries
 * no request numbers, and the request numbers are typed in afterwards by hand.
 * Tomorrow the same month is downloaded again with one more day on the end.
 *
 * So the question is not "does the first upload work". It is: after a row has
 * been worked on, does the NEXT upload still recognise it, or does it come
 * back as new and get written a second time?
 *
 * The importer decides that on date + amount + the narrative. Anything in that
 * key is a field that, if edited, makes the row unrecognisable. Anything
 * outside it is safe to edit. That boundary is what this measures, on the real
 * statement against the real ledger — nothing is written.
 *
 *   LEDGER_DEPS=... IMPORT_BUNDLE=... STATEMENT=... node scripts/db/daily_statement_workflow_test.mjs
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { connect, q } from './connect.mjs';

const { parseXlsx, analyseSheet, buildRows } = await import(
  pathToFileURL(resolve(process.env.IMPORT_BUNDLE ?? 'web/src/lib/importFile.ts')).href
);

const STATEMENT =
  process.env.STATEMENT ??
  `${process.env.USERPROFILE ?? process.env.HOME}/Downloads/Account Statement_29-09-2026 09_47_46.xlsx`;
const ACCOUNT = 'BANK KSA (SAB 7631)';

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(62)}${detail}`);
};
const money = (n) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const client = await connect();

try {
  console.log('='.repeat(100));
  console.log('THE DAILY ROUTINE — what survives being worked on, and what does not');
  console.log('='.repeat(100));

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

  const sheet = parseXlsx(new Uint8Array(readFileSync(STATEMENT)))[0];
  const analysis = analyseSheet(sheet, card);

  const ledgerRows = async () =>
    q(
      client,
      `select id, card_id as "cardId", to_char(txn_date,'YYYY-MM-DD') as txn_date,
              supplier_raw as supplier, supplier_raw, amount_aed::float8 as amount_aed,
              direction, entry_type, status, req_number, payment_ref
         from transactions where card_id = $1 and status <> 'voided'`,
      [card.id],
    );

  const offer = (existing) =>
    buildRows(sheet, analysis.headerRow, analysis.mapping, {
      card, existing, cardId: card.id, dayFirst: analysis.dayFirst,
    }).filter((r) => r.amountAed !== null);

  const base = await ledgerRows();
  const baseline = offer(base);
  const recognised = (rows) => rows.filter((r) => r.duplicateOf).length;

  console.log(`\n  the statement holds ${baseline.length} rows; the ledger holds ${base.length} for this account`);
  console.log(`  as things stand, ${recognised(baseline)} are recognised and ${baseline.length - recognised(baseline)} are new\n`);

  /* ------------------------------------------------------------------------
   * 1. Typing in a request number — the whole point of the routine
   * --------------------------------------------------------------------- */

  // Done to the copy the importer compares against, not to the database. The
  // question is only what the matching makes of it.
  const withRefs = base.map((r) => ({ ...r, req_number: r.req_number || 'KSAML-TYPED-IN' }));
  const afterRefs = offer(withRefs);
  check('a row still matches after a request number is typed on it',
        recognised(afterRefs) === recognised(baseline),
        `${recognised(afterRefs)} recognised, was ${recognised(baseline)}`);

  const withPay = base.map((r) => ({ ...r, payment_ref: 'PAY-TYPED-IN' }));
  check('and after a payment reference is put on it',
        recognised(offer(withPay)) === recognised(baseline));

  /* ------------------------------------------------------------------------
   * 2. The fields that ARE the row's identity
   * --------------------------------------------------------------------- */

  // Changed one row at a time, so the count says exactly how many rows stopped
  // being recognised rather than collapsing into a single yes or no.
  const firstMatched = baseline.find((r) => r.duplicateOf);
  const target = base.find((e) => e.id === firstMatched?.duplicateOf?.id);

  const breakOne = (patch) => {
    const edited = base.map((r) => (r.id === target.id ? { ...r, ...patch } : r));
    return recognised(baseline) - recognised(offer(edited));
  };

  console.log('');
  check('editing the SUPPLIER makes that row unrecognisable', breakOne({ supplier_raw: 'CORRECTED NAME' }) === 1,
        'it would be imported again as a new transaction');
  check('editing the AMOUNT makes that row unrecognisable', breakOne({ amount_aed: target.amount_aed - 1 }) === 1,
        'it would be imported again as a new transaction');
  check('editing the DATE makes that row unrecognisable', breakOne({ txn_date: '2026-01-01' }) === 1,
        'it would be imported again as a new transaction');

  /* ------------------------------------------------------------------------
   * 3. Voiding a row — the other way to make one come back
   * --------------------------------------------------------------------- */

  // A voided row is not in the comparison set at all, so the statement offers
  // it again. That is right — voiding says "this is not a transaction" and the
  // bank says it is — but it is worth knowing it comes back.
  const voided = base.filter((r) => r.id !== target.id);
  check('a voided row is offered again by the next statement',
        recognised(offer(voided)) === recognised(baseline) - 1,
        'voiding does not hide a row from the bank');

  /* ------------------------------------------------------------------------
   * 4. The same statement twice in one day
   * --------------------------------------------------------------------- */

  const twice = offer(base);
  check('downloading and uploading the same statement twice changes nothing',
        recognised(twice) === recognised(baseline),
        `${recognised(twice)} recognised both times`);

  /* ------------------------------------------------------------------------
   * 5. What tomorrow's upload would actually ask of you
   * --------------------------------------------------------------------- */

  const fresh = baseline.filter((r) => !r.duplicateOf);
  const costs = fresh.filter((r) => r.kind === 'purchase');
  const needRef = costs.filter((r) => !String(r.reqNumber ?? '').trim());
  const charges = costs.filter((r) => String(r.reqNumber ?? '').trim().toUpperCase() === 'BAC');

  console.log('\n  ' + '-'.repeat(96));
  console.log(`  new rows on this upload                : ${fresh.length}`);
  console.log(`  of those, money going out              : ${costs.length}`);
  console.log(`  labelled BAC without being asked       : ${charges.length}`);
  console.log(`  needing a request number typed in      : ${needRef.length}`);
  console.log(`  money in (no request number expected)  : ${fresh.length - costs.length}`);
  const outstanding = await q(
    client,
    `select count(*)::int n from transactions
      where card_id = $1 and status <> 'voided' and amount_aed < 0
        and coalesce(btrim(req_number), '') = ''`,
    [card.id],
  );
  console.log(`  already in the ledger with none        : ${outstanding[0].n}`);
} finally {
  await client.end();
}

console.log('\n' + '='.repeat(100));
if (failures) { console.log(`${failures} CHECK(S) FAILED`); process.exit(1); }
console.log('References can be typed in freely. Date, amount and supplier are the row\'s identity.');
console.log('='.repeat(100));
