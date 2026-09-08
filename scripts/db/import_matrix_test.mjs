/**
 * Every shape of import data I can think of, on both kinds of card, each one
 * checked against a balance worked out independently of the code being tested.
 *
 * Written after four separate faults reached a real balance: a rate in
 * scientific notation the parser could not read, genuine repeat charges eaten
 * by the double-submit guard, those same repeats then set aside as duplicates
 * of themselves, and a payment reference that was required when 30% of the
 * ledger has none. Each was found by a person noticing a wrong number, which is
 * the most expensive way to find anything.
 *
 * THE RULE THIS FILE FOLLOWS
 *
 * Every scenario states, by hand, what the net effect on the balance must be.
 * That figure is written in the scenario, not derived from the parser, the
 * importer, or the database — so a bug in any of them cannot quietly agree with
 * itself. If the parser drops a row, the expected net still includes it and the
 * check fails.
 *
 * Each scenario runs inside a savepoint and is rolled back, so they cannot
 * affect each other or the live ledger.
 *
 *   LEDGER_DEPS=... FFLATE_DIR=... EXPORT_BUNDLE=... IMPORT_BUNDLE=... \
 *     node scripts/db/import_matrix_test.mjs
 */

import { pathToFileURL } from 'node:url';
import path, { resolve } from 'node:path';
import { connect, q } from './connect.mjs';

const load = (envVar, fallback) =>
  import(pathToFileURL(resolve(process.env[envVar] ?? fallback)).href);

const { buildXlsxWorkbook } = await load('EXPORT_BUNDLE', 'web/src/lib/export.ts');
const { parseXlsx, analyseSheet, buildRows } = await load(
  'IMPORT_BUNDLE',
  'web/src/lib/importFile.ts',
);

let failures = 0;
let checks = 0;
const check = (label, ok, detail = '') => {
  checks++;
  if (!ok) failures++;
  console.log(`    ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(56)}${detail}`);
};
const money = (n) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const near = (a, b, t = 0.005) => Math.abs(Number(a) - Number(b)) < t;

/* ------------------------------------------------------------ the test file
 *
 * Built with the app's own workbook writer, in the shape the blank sheet takes:
 * three lines of preamble, a header row, then the transactions. The column
 * order follows the card, exactly as the template does.
 */

const HEADERS = (card) => {
  const spend = card.decreasingHeader.trim();
  const received = card.increasingHeader.trim();
  const spendFirst = card.decreasingColumn <= card.increasingColumn;
  return [
    'TRANSACTION DATE', 'DETAILS', 'ORIGINAL CURRENCY', 'AMOUNT',
    ...(spendFirst ? [spend, received] : [received, spend]),
    'BALANCE', 'CONVERSION', 'REQ NUMBER', 'LPO NUMBER', 'INVOICE',
    'PAYMENT REFERENCE NUMBER', 'CRM', 'CLIENT', 'SALES OPERATION', 'NOTES',
  ];
};

/**
 * One line of a test file.
 *
 * `spend` and `received` are put in whichever column that card uses for each,
 * so a scenario says what happened in money terms and never has to know which
 * header the card calls it.
 */
function buildFile(card, lines) {
  const headers = HEADERS(card);
  const spend = card.decreasingHeader.trim();
  const received = card.increasingHeader.trim();
  const at = (name) => headers.indexOf(name);

  const rows = [
    [`${card.name} — test sheet`],
    ['built by import_matrix_test'],
    ['one transaction per row'],
    headers,
  ];
  for (const line of lines) {
    if (line === 'BLANK') {
      rows.push(headers.map(() => null));
      continue;
    }
    const r = headers.map(() => null);
    r[at('TRANSACTION DATE')] = line.date ?? null;
    r[at('DETAILS')] = line.supplier ?? null;
    r[at('ORIGINAL CURRENCY')] = line.currency ?? null;
    r[at('AMOUNT')] = line.original ?? null;
    if (line.spend !== undefined) r[at(spend)] = line.spend;
    if (line.received !== undefined) r[at(received)] = line.received;
    r[at('CONVERSION')] = line.rate ?? null;
    r[at('REQ NUMBER')] = line.req ?? 'MATRIX-REQ';
    r[at('PAYMENT REFERENCE NUMBER')] = line.ref ?? null;
    r[at('NOTES')] = line.notes ?? null;
    rows.push(r);
  }
  return buildXlsxWorkbook([{ name: 'Sheet1', rows, headerRowIndex: 3 }]);
}

const cardFromDb = (row) => ({
  id: row.card_id,
  name: row.card_name,
  settlementCurrency: row.settlement_currency,
  openingBalance: Number(row.opening_balance),
  openingDate: row.opening_date ? String(row.opening_date).slice(0, 10) : null,
  lastTransaction: null,
  sourceBalance: Number(row.source_balance),
  ledgerBalance: Number(row.ledger_balance),
  reconciliationDifference: 0,
  balanceSign: Number(row.balance_sign) === -1 ? -1 : 1,
  totalSpend: 0, totalFunding: 0, reviewAdjustmentsTotal: 0,
  needsReview: 0, excluded: 0,
  transactionCount: Number(row.transaction_count),
  sourceHeaderRow: row.source_header_row ?? 1,
  decreasingColumn: row.decreasing_column ?? 'D',
  decreasingHeader: row.decreasing_header ?? 'DEBIT',
  increasingColumn: row.increasing_column ?? 'E',
  increasingHeader: row.increasing_header ?? 'CREDIT',
  balanceFormula: row.balance_formula ?? '',
  headerIsMisleading: /credit/i.test(row.decreasing_header ?? ''),
  verifiedRows: 0,
});

const client = await connect();

/* ------------------------------------------------------------- the scenarios
 *
 * `expect` is the net movement in money terms: negative for spending, positive
 * for money in, BEFORE the card's own convention is applied. Written by hand.
 */

const scenarios = [
  {
    name: 'the ordinary case',
    lines: [
      { date: '25/09/2026', supplier: 'ORDINARY ONE', spend: 100 },
      { date: '25/09/2026', supplier: 'ORDINARY TWO', spend: 250.5 },
      { date: '26/09/2026', supplier: 'MONEY IN', received: 1000 },
    ],
    expectRows: 3,
    expect: -100 - 250.5 + 1000,
  },
  {
    name: 'a rate in scientific notation, on a row nothing else excuses',
    // The date is unambiguous and the currency is known, so this row carries no
    // warning and is NOT sent as needs_review. That matters: needs_review turns
    // off the database's insistence on a rate, and every scenario here used to
    // trip it through an ambiguous date — which is how a reverted
    // scientific-notation fix went unnoticed by this very file.
    lines: [
      { date: '25/09/2026', supplier: 'TURKISH VISA STRICT', currency: 'TRY',
        original: 1304.68, spend: 99.63, rate: '7.6363552748566696E-2' },
    ],
    expectRows: 1,
    expect: -99.63,
    expectNoWarnings: true,
  },
  {
    name: 'a rate in scientific notation',
    lines: [
      { date: '25/09/2026', supplier: 'TURKISH VISA', currency: 'TRY',
        original: 1304.68, spend: 99.63, rate: '7.6363552748566696E-2' },
      { date: '25/09/2026', supplier: 'JAPAN RAIL', currency: 'JPY',
        original: 83820, spend: 1978.12, rate: '2.3599E-2' },
    ],
    expectRows: 2,
    expect: -99.63 - 1978.12,
  },
  {
    name: 'the same charge twice on one day',
    lines: [
      { date: '25/09/2026', supplier: 'TWICE HOTEL', spend: 995.91 },
      { date: '25/09/2026', supplier: 'TWICE HOTEL', spend: 995.91 },
    ],
    expectRows: 2,
    expect: -995.91 * 2,
  },
  {
    name: 'the same charge five times on one day',
    lines: Array.from({ length: 5 }, () => ({
      date: '25/09/2026', supplier: 'FIVE TIMES', spend: 48890,
    })),
    expectRows: 5,
    expect: -48890 * 5,
  },
  {
    name: 'blank rows scattered through the file',
    lines: [
      { date: '25/09/2026', supplier: 'BEFORE BLANK', spend: 10 },
      'BLANK',
      'BLANK',
      { date: '26/09/2026', supplier: 'AFTER BLANK', spend: 20 },
    ],
    expectRows: 2,
    expect: -30,
  },
  {
    name: 'no payment reference anywhere',
    lines: [
      { date: '25/09/2026', supplier: 'NO REF ONE', spend: 15 },
      { date: '25/09/2026', supplier: 'NO REF TWO', spend: 25, ref: '' },
    ],
    expectRows: 2,
    expect: -40,
  },
  {
    name: 'an amount below one fils, and a very large one',
    lines: [
      { date: '25/09/2026', supplier: 'SUB CENT', spend: 0.004 },
      { date: '25/09/2026', supplier: 'VERY LARGE', spend: 2000000 },
    ],
    expectRows: 2,
    expect: -0.004 - 2000000,
  },
  {
    name: 'a date past the twelfth settles the whole column as day-first',
    lines: [
      { date: '28/01/2026', supplier: 'UNAMBIGUOUS DAY', spend: 109 },
      { date: '03/04/2026', supplier: 'AMBIGUOUS, READ DAY FIRST', spend: 50 },
    ],
    expectRows: 2,
    expect: -159,
    expectDates: ['2026-01-28', '2026-04-03'],
  },
  {
    name: 'an ISO date and an Excel date side by side',
    lines: [
      { date: '2026-09-05', supplier: 'ISO DATE', spend: 11 },
      { date: '5 Sep 2026', supplier: 'WRITTEN DATE', spend: 22 },
    ],
    expectRows: 2,
    expect: -33,
    expectDates: ['2026-09-05', '2026-09-05'],
  },
  {
    name: 'foreign currency with everything present',
    lines: [
      { date: '25/09/2026', supplier: 'EUR SUPPLIER', currency: 'EUR',
        original: 1210, spend: 5182.05, rate: 4.2826859504132235 },
      { date: '25/09/2026', supplier: 'GBP SUPPLIER', currency: 'GBP',
        original: 200, spend: 995.91, rate: 4.97955 },
    ],
    expectRows: 2,
    expect: -5182.05 - 995.91,
  },
  {
    name: 'AED rows carrying no rate, as the workbook writes them',
    lines: [
      { date: '25/09/2026', supplier: 'AED NO RATE', currency: 'AED', spend: 5290 },
      { date: '25/09/2026', supplier: 'NO CURRENCY AT ALL', spend: 461.16 },
    ],
    expectRows: 2,
    expect: -5290 - 461.16,
  },
  {
    name: 'unicode, quotes, ampersands and long names',
    lines: [
      { date: '25/09/2026', supplier: 'مورد عربي', spend: 30 },
      { date: '25/09/2026', supplier: 'Smith & Sons "Travel" <Ltd>', spend: 40 },
      { date: '25/09/2026', supplier: 'A'.repeat(180), spend: 50 },
    ],
    expectRows: 3,
    expect: -120,
  },
  {
    name: 'amounts written the way people type them',
    lines: [
      { date: '25/09/2026', supplier: 'THOUSANDS COMMA', spend: '1,234.56' },
      { date: '25/09/2026', supplier: 'CURRENCY PREFIX', spend: 'AED 500.00' },
      { date: '25/09/2026', supplier: 'SPACE PADDED', spend: '  75.25  ' },
    ],
    expectRows: 3,
    expect: -1234.56 - 500 - 75.25,
  },
  {
    name: 'money out and money in on the same reference',
    lines: [
      { date: '25/09/2026', supplier: 'PAID THEN REFUNDED', spend: 600, ref: 'PR-1' },
      { date: '26/09/2026', supplier: 'PAID THEN REFUNDED', received: 600, ref: 'PR-1' },
    ],
    expectRows: 2,
    expect: 0,
  },
  {
    name: 'a refund names itself, a top-up does not',
    lines: [
      { date: '25/09/2026', supplier: 'REFUND FROM SUPPLIER', received: 300 },
      { date: '25/09/2026', supplier: 'PAYMENT RECD.-INTERNET BANKING', received: 700 },
    ],
    expectRows: 2,
    expect: 1000,
    expectKinds: ['refund', 'funding'],
  },

  /* ------------------------------------------------------------------------
   * Rows that must NOT reach the ledger.
   *
   * A matrix of things that work proves the happy path and nothing else. These
   * check the refusals, because a parser that accepts a row with no date is
   * worse than one that accepts nothing: the money goes in and the row cannot
   * be found again. `expect` counts only the good rows, so if a bad one slips
   * through the balance check fails on its own.
   * -------------------------------------------------------------------------
   */
  {
    name: 'a supplier whose name ends in a country code, already in the ledger',
    // The exact shape that let one file import six times. The sheet writes
    // "Emaar Misr 818"; the ledger splits the 818 off and returns "Emaar Misr".
    // Keyed as they stand the two never match and every row looks new.
    preload: [
      { date: '25/09/2026', supplier: 'Emaar Misr 818', spend: 23403.76 },
      { date: '25/09/2026', supplier: 'CCA*VASCO TOURISM LLC 784', spend: 1078 },
    ],
    lines: [
      { date: '25/09/2026', supplier: 'Emaar Misr 818', spend: 23403.76 },
      { date: '25/09/2026', supplier: 'CCA*VASCO TOURISM LLC 784', spend: 1078 },
      { date: '25/09/2026', supplier: 'Millennium Airport Hot 784', spend: 3690 },
    ],
    expectRows: 3,
    expectReady: 1,
    expect: -3690,
  },
  {
    name: 'a second copy arrives after the first is already in the ledger',
    // The case that lost 64,197.54 AED. The ledger holds one of a charge the
    // statement lists twice, so the second copy is the missing one and must
    // still be offered. Nothing else in this file may import again.
    preload: [
      { date: '25/09/2026', supplier: 'ARRIVES TWICE', spend: 995.91 },
      { date: '25/09/2026', supplier: 'ARRIVES ONCE', spend: 100 },
    ],
    lines: [
      { date: '25/09/2026', supplier: 'ARRIVES TWICE', spend: 995.91 },
      { date: '25/09/2026', supplier: 'ARRIVES TWICE', spend: 995.91 },
      { date: '25/09/2026', supplier: 'ARRIVES ONCE', spend: 100 },
    ],
    expectRows: 3,
    expectReady: 1,
    expect: -995.91,
  },
  {
    name: 'a third copy when the ledger already holds two',
    preload: [
      { date: '25/09/2026', supplier: 'THREE TIMES', spend: 48890 },
      { date: '25/09/2026', supplier: 'THREE TIMES', spend: 48890 },
    ],
    lines: Array.from({ length: 3 }, () => ({
      date: '25/09/2026', supplier: 'THREE TIMES', spend: 48890,
    })),
    expectRows: 3,
    expectReady: 1,
    expect: -48890,
  },
  {
    name: 'the ledger already holds every copy the file lists',
    preload: [
      { date: '25/09/2026', supplier: 'ALREADY BOTH', spend: 250 },
      { date: '25/09/2026', supplier: 'ALREADY BOTH', spend: 250 },
    ],
    lines: [
      { date: '25/09/2026', supplier: 'ALREADY BOTH', spend: 250 },
      { date: '25/09/2026', supplier: 'ALREADY BOTH', spend: 250 },
    ],
    expectRows: 2,
    expectReady: 0,
    expect: 0,
  },
  {
    name: 'a row with no date is stopped, the good one still imports',
    lines: [
      { date: '', supplier: 'NO DATE AT ALL', spend: 500 },
      { date: '25/09/2026', supplier: 'PERFECTLY FINE', spend: 60 },
    ],
    expectRows: 2,
    expectReady: 1,
    expect: -60,
  },
  {
    name: 'a row with no supplier is stopped',
    lines: [
      { date: '25/09/2026', supplier: '', spend: 400 },
      { date: '25/09/2026', supplier: 'HAS A NAME', spend: 70 },
    ],
    expectRows: 2,
    expectReady: 1,
    expect: -70,
  },
  {
    name: 'a row with no amount in either column is stopped',
    lines: [
      { date: '25/09/2026', supplier: 'NO AMOUNT' },
      { date: '25/09/2026', supplier: 'HAS AN AMOUNT', spend: 80 },
    ],
    expectRows: 2,
    expectReady: 1,
    expect: -80,
  },
  {
    name: 'words where a number belongs are stopped, not read as zero',
    lines: [
      { date: '25/09/2026', supplier: 'AMOUNT IS TEXT', spend: 'not a number' },
      { date: '25/09/2026', supplier: 'AMOUNT IS A NUMBER', spend: 90 },
    ],
    expectRows: 2,
    expectReady: 1,
    expect: -90,
  },
  {
    name: 'a currency nobody recognises is carried through for review',
    lines: [
      { date: '25/09/2026', supplier: 'MADE UP CURRENCY', currency: 'XYZ',
        original: 100, spend: 370, rate: 3.7 },
      { date: '25/09/2026', supplier: 'REAL CURRENCY', currency: 'USD',
        original: 100, spend: 367.25, rate: 3.6725 },
    ],
    expectRows: 2,
    expect: -370 - 367.25,
    expectWarning: /is not one of the \d+ known currencies/i,
  },
  {
    name: 'an amount in BOTH columns at once',
    lines: [
      { date: '25/09/2026', supplier: 'BOTH COLUMNS', spend: 100, received: 40 },
      { date: '25/09/2026', supplier: 'ONE COLUMN', spend: 10 },
    ],
    expectRows: 2,
    // Stopped, and rightly. A line claiming money went out AND came in on the
    // same charge cannot be resolved by picking one, so the reviewer is asked.
    //
    // The message is asserted, not just the refusal. Without its own guard the
    // row is still stopped — the amount ends up null and it fails as "no amount
    // in either column" — which is true of the data and useless to the person
    // holding the file. A stopped row that misdescribes itself costs an
    // afternoon.
    expectReady: 1,
    expect: -10,
    expectError: /both the decreasing and the increasing/i,
  },
  {
    name: 'a date before the card existed is stored but moves no balance',
    lines: [
      { date: '01/01/2010', supplier: 'BEFORE THE CARD OPENED', spend: 99999 },
      { date: '25/09/2026', supplier: 'AFTER IT OPENED', spend: 45 },
    ],
    expectRows: 2,
    expect: -45,
    expectStoredButNotCounted: 1,
  },
];

/* ------------------------------------------------------------------- the run */

try {
  const [owner] = await q(client, 'select user_id from admins where is_owner limit 1');
  if (!owner) throw new Error('no owner account to run as');

  console.log('='.repeat(96));
  console.log('IMPORT MATRIX — every shape of data, on both kinds of card');
  console.log('='.repeat(96));

  const cards = await q(
    client,
    `select b.*, c.source_header_row, c.decreasing_column, c.decreasing_header,
            c.increasing_column, c.increasing_header, c.balance_formula
       from card_balances b join cards c on c.id = b.card_id
      where b.card_name in ('MASTERCARD 6404 VPAY', 'AMEX 4000 VPAY', 'RAK 9825 (6071)')
      order by b.card_name`,
  );

  await client.query('begin');
  await client.query('set local role authenticated');
  await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [owner.user_id]);

  let sp = 0;
  for (const cardRow of cards) {
    const card = cardFromDb(cardRow);
    console.log(
      `\n${card.name}  —  ${card.decreasingHeader.trim()} is spending, ` +
        `balance ${card.balanceSign === -1 ? 'RISES when you spend' : 'falls when you spend'}`,
    );
    console.log('-'.repeat(96));

    for (const s of scenarios) {
      const name = `sp${++sp}`;
      await client.query(`savepoint ${name}`);
      console.log(`\n  ${s.name}`);

      // Rows put into the ledger before the file is read, so a scenario can
      // describe a card that already holds some of what the file lists.
      if (s.preload) {
        for (const line of s.preload) {
          await client.query(
            `select create_transaction(
               p_card_id := $1, p_txn_date := $2, p_kind := 'purchase', p_amount_aed := $3,
               p_supplier := $4, p_req_number := 'PRELOAD', p_payment_ref := null,
               p_allow_duplicate := true)`,
            [card.id, '2026-09-25', Math.abs(line.spend), line.supplier],
          );
        }
      }

      // Read after any preload, so the expected movement is measured from the
      // card as the file will actually find it.
      const before = Number(
        (await q(client, 'select ledger_balance::text l from card_balances where card_id = $1',
                 [card.id]))[0].l,
      );

      const bytes = buildFile(card, s.lines);
      const sheet = parseXlsx(bytes)[0];
      const analysis = analyseSheet(sheet, card);
      // Shaped exactly as api.ts shapes it, country code split off the name.
      // Handing over supplier_raw instead would hide the very mismatch that let
      // one file import six times.
      const existing = await q(
        client,
        `select id, card_id as "cardId", to_char(txn_date,'YYYY-MM-DD') as txn_date,
                regexp_replace(supplier_raw, '\\s\\d{3}\\s*$', '') as supplier,
                supplier_raw, amount_aed::float8 as amount_aed,
                payment_ref, req_number
           from transactions where card_id = $1 and status <> 'voided'`,
        [card.id],
      );
      const rows = buildRows(sheet, analysis.headerRow, analysis.mapping, {
        dayFirst: analysis.dayFirst,
        existing,
        cardId: card.id,
      }).filter((r) => r.date || r.amountAed !== null);

      check('the file parses to the rows it holds', rows.length === s.expectRows,
            `${rows.length} of ${s.expectRows}`);
      const ready = rows.filter((r) => r.errors.length === 0 && r.include !== false);
      const wantReady = s.expectReady ?? s.expectRows;
      check(
        s.expectReady === undefined
          ? 'every row is ready to import'
          : `${wantReady} of ${s.expectRows} are ready, the rest stopped`,
        ready.length === wantReady,
        ready.length === wantReady ? '' :
        `${ready.length} ready — ${rows.filter((r) => r.errors.length).map((r) => r.errors[0]).join('; ')}`,
      );
      if (s.expectError)
        check('the stopped row says what is actually wrong with it',
              rows.some((r) => r.errors.some((e) => s.expectError.test(e))),
              rows.flatMap((r) => r.errors).join(' | ').slice(0, 70));
      if (s.expectReady !== undefined)
        check('each stopped row says why',
              rows.filter((r) => r.errors.length).every((r) => r.errors[0]?.length > 5),
              rows.filter((r) => r.errors.length).map((r) => r.errors[0]).join(' | '));
      if (s.expectNoWarnings)
        check('this row carries no warning, so nothing excuses a bad parse',
              rows.every((r) => r.warnings.length === 0),
              rows.flatMap((r) => r.warnings).join(' | ').slice(0, 80));
      if (s.expectWarning)
        // Named, not counted. A day/month-ambiguous date warns on every row of
        // a file, so "how many rows have a warning" measures nothing.
        check('the doubtful row is flagged for what is actually doubtful',
              rows.some((r) => r.warnings.some((w) => s.expectWarning.test(w))),
              rows.flatMap((r) => r.warnings).join(' | ').slice(0, 110));

      if (s.expectDates)
        check('the dates read as intended',
              JSON.stringify(rows.map((r) => r.date)) === JSON.stringify(s.expectDates),
              rows.map((r) => r.date).join(', '));
      if (s.expectKinds)
        check('money in is called what it is',
              JSON.stringify(rows.map((r) => r.kind)) === JSON.stringify(s.expectKinds),
              rows.map((r) => r.kind).join(', '));

      let wrote = 0;
      const seen = new Set();
      let swallowed = 0;
      const refusals = [];
      for (const row of ready) {
        const inner = `${name}_r${wrote + swallowed + refusals.length}`;
        await client.query(`savepoint ${inner}`);
        try {
          const r = await client.query(
            `select create_transaction(
               p_card_id := $1, p_txn_date := $2, p_kind := $3, p_amount_aed := $4,
               p_supplier := $5, p_req_number := $6, p_payment_ref := $7,
               p_currency := $8, p_original_amount := $9, p_exchange_rate := $10,
               p_needs_review := $11, p_allow_duplicate := $12) as id`,
            [
              card.id, row.date, row.kind, Math.abs(row.amountAed), row.supplier,
              row.reqNumber, row.paymentRef?.trim() || null,
              row.currency, row.originalAmount, row.rate,
              row.warnings.length > 0,
              Boolean(row.duplicateOf || row.repeatOfRow),
            ],
          );
          await client.query(`release savepoint ${inner}`);
          const id = r.rows[0].id;
          if (seen.has(id)) swallowed++;
          else { seen.add(id); wrote++; }
        } catch (e) {
          await client.query(`rollback to savepoint ${inner}`);
          refusals.push(`row ${row.sourceRow}: ${e.message.split('\n')[0]}`);
        }
      }

      check('nothing was refused', refusals.length === 0, refusals[0] ?? '');
      check('no row reported success without writing', swallowed === 0,
            swallowed ? `${swallowed} swallowed` : '');
      check('a transaction exists for every row that should import',
            wrote === wantReady, `${wrote} of ${wantReady}`);

      const after = Number(
        (await q(client, 'select ledger_balance::text l from card_balances where card_id = $1',
                 [card.id]))[0].l,
      );
      // The card decides which way its own balance moves; the scenario states
      // the movement in money terms and this applies the card's rule to it.
      const expected = Number((before + card.balanceSign * s.expect).toFixed(2));
      check('the balance lands exactly where the file says', near(after, expected),
            `${money(before)} -> ${money(after)}, wanted ${money(expected)}`);

      if (s.expectStoredButNotCounted) {
        const [{ n }] = await q(
          client,
          `select count(*)::int n from transactions
            where card_id = $1 and txn_date < (select opening_date from cards where id = $1)`,
          [card.id],
        );
        check('the pre-opening row is stored and searchable',
              n >= s.expectStoredButNotCounted, `${n} row(s) before the opening date`);
      }

      /* the same file again must add nothing */
      const secondPass = buildRows(sheet, analysis.headerRow, analysis.mapping, {
        dayFirst: analysis.dayFirst,
        existing: await q(
          client,
          `select id, card_id as "cardId", to_char(txn_date,'YYYY-MM-DD') as txn_date,
                  regexp_replace(supplier_raw, '\\s\\d{3}\\s*$', '') as supplier,
                  supplier_raw, amount_aed::float8 as amount_aed,
                  payment_ref, req_number
             from transactions where card_id = $1 and status <> 'voided'`,
          [card.id],
        ),
        cardId: card.id,
      }).filter((r) => (r.date || r.amountAed !== null) && r.errors.length === 0 && r.include !== false);
      check('uploading the same file again offers nothing', secondPass.length === 0,
            secondPass.length ? `${secondPass.length} would import again` : '');

      await client.query(`rollback to savepoint ${name}`);
    }
  }

  await client.query('rollback');
  console.log('\n  Rolled back — the live ledger is untouched.');
} finally {
  await client.end();
}

console.log('\n' + '='.repeat(96));
console.log(`${checks} checks, ${failures} failed`);
if (failures) process.exit(1);
console.log('Every shape imports whole, and every balance lands where the file says.');
console.log('='.repeat(96));
