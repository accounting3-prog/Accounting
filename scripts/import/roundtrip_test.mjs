/**
 * Exports transactions to a workbook, reads that workbook back in with the
 * importer, and checks that nothing changed on the way through.
 *
 * The export and the import were written independently — one assembles XML into
 * a zip, the other pulls XML out of one — so a round trip that survives is real
 * evidence rather than two halves of the same mistake agreeing with each other.
 *
 * It also covers the case that will actually happen: someone exports a card,
 * edits it, and uploads it again. Every unchanged row must be recognised as
 * already being in the ledger, or an import doubles the balance.
 *
 *   IMPORT_BUNDLE=... EXPORT_BUNDLE=... node scripts/import/roundtrip_test.mjs
 */

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const load = async (envVar, fallback) =>
  import(pathToFileURL(resolve(process.env[envVar] ?? fallback)).href);

const { buildXlsxByCard } = await load('EXPORT_BUNDLE', 'web/src/lib/export.ts');
const { parseXlsx, analyseSheet, buildRows } = await load('IMPORT_BUNDLE', 'web/src/lib/importFile.ts');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

/* ------------------------------------------------------------------- data */

const card = {
  id: 'c1',
  name: 'AMEX 3024 (3016- COR)',
  settlementCurrency: 'AED',
  openingBalance: 26357.31,
  openingDate: '2026-01-01',
  lastTransaction: '2026-06-18',
  sourceBalance: 16728.96,
  ledgerBalance: 16728.96,
  reconciliationDifference: 0,
  totalSpend: 9628.35,
  totalFunding: 0,
  reviewAdjustmentsTotal: 0,
  needsReview: 0,
  excluded: 0,
  transactionCount: 4,
  sourceHeaderRow: 1,
  // This card's own convention: CREDIT decreases, DEBIT increases. Getting it
  // backwards on re-import would flip every sign.
  decreasingColumn: 'E',
  decreasingHeader: 'CREDIT',
  increasingColumn: 'D',
  increasingHeader: 'DEBIT',
  balanceFormula: '=F2-E3+D3',
  headerIsMisleading: true,
  verifiedRows: 3,
};

const transactions = [
  {
    id: 't1', cardId: 'c1', entry_type: 'source_transaction', status: 'confirmed',
    txn_date: '2026-01-07', supplier: 'AMTRAK INT', amount_aed: -881.57, direction: 'spend',
    currency: 'USD', original_amount: 240, exchange_rate: 3.6732083333333336,
    normalized_exchange_rate: 3.6732, req_number: 'REQ 11840',
    payment_ref: 'Payment Made: #9403', lpo_number: 'LPO-COR-12529', occurrence: 1,
  },
  {
    id: 't2', cardId: 'c1', entry_type: 'source_transaction', status: 'confirmed',
    txn_date: '2026-02-25', supplier: 'NETWORK INTL - MISCELLANEOUS', amount_aed: -1,
    direction: 'spend', req_number: 'GEN EXP', occurrence: 1,
  },
  {
    id: 't3', cardId: 'c1', entry_type: 'source_transaction', status: 'confirmed',
    txn_date: '2026-06-18', supplier: 'FLYNAS RIYADH', amount_aed: -8745.78, direction: 'spend',
    currency: 'SAR', original_amount: 8925.77, req_number: 'UAEVP488',
    payment_ref: 'Payment Made: #10483', lpo_number: 'LPO-VIP-13743', occurrence: 1,
  },
  {
    id: 't4', cardId: 'c1', entry_type: 'source_transaction', status: 'confirmed',
    txn_date: '2026-03-11', supplier: 'HOTEL REFUND', amount_aed: 1250.5,
    direction: 'funding', req_number: 'REQ 11901', payment_ref: 'Credit #221', occurrence: 1,
  },
];

/* -------------------------------------------------------- there and back */

const bytes = buildXlsxByCard(transactions, [card]);
const sheets = parseXlsx(new Uint8Array(bytes));
check('the exported workbook can be read back', sheets.length === 2, `${sheets.length} sheets`);

const sheet = sheets.find((s) => s.name.startsWith('AMEX 3024'));
check('the card tab is found by name', Boolean(sheet), sheets.map((s) => s.name).join(' | '));
if (!sheet) process.exit(1);

const analysis = analyseSheet(sheet, card);
check('the header row is found', analysis.headerRow === 4, `row ${analysis.headerRow + 1}`);
check('the date column is mapped', analysis.mapping.date !== undefined);
check('the supplier column is mapped', analysis.mapping.supplier !== undefined);
check(
  'the signed AED column is mapped',
  analysis.mapping.signed_amount !== undefined,
  analysis.headers.join(' | ').slice(0, 120),
);
check('the currency column is mapped', analysis.mapping.currency !== undefined);
check('the original amount column is mapped', analysis.mapping.original_amount !== undefined);
check('the rate column is mapped', analysis.mapping.rate !== undefined);
check('the request number column is mapped', analysis.mapping.req_number !== undefined);
check('the payment reference column is mapped', analysis.mapping.payment_ref !== undefined);

const rows = buildRows(sheet, analysis.headerRow, analysis.mapping, {
  dayFirst: analysis.dayFirst,
});

check('every transaction comes back', rows.length === transactions.length, `${rows.length}`);

for (const want of transactions) {
  const got = rows.find((r) => r.supplier === want.supplier);
  if (!got) {
    check(`${want.supplier}: found in the re-read file`, false);
    continue;
  }
  check(`${want.supplier}: the date is unchanged`, got.date === want.txn_date, `${got.date} vs ${want.txn_date}`);
  check(
    `${want.supplier}: the amount is unchanged`,
    Math.abs((got.amountAed ?? 0) - Math.abs(want.amount_aed)) < 0.005,
    `${got.amountAed} vs ${Math.abs(want.amount_aed)}`,
  );
  const wantSpend = want.direction === 'spend';
  const gotSpend = got.kind === 'purchase' || got.kind === 'fee';
  check(
    `${want.supplier}: the direction is unchanged`,
    gotSpend === wantSpend,
    `${got.kind} vs ${want.direction}`,
  );
  check(
    `${want.supplier}: the request number survives`,
    got.reqNumber === (want.req_number ?? ''),
    `"${got.reqNumber}"`,
  );
  if (want.currency) {
    check(
      `${want.supplier}: the ${want.currency} original amount survives`,
      got.currency === want.currency && Math.abs((got.originalAmount ?? 0) - want.original_amount) < 0.005,
      `${got.currency} ${got.originalAmount}`,
    );
  }
}

// The balance the file implies must equal the balance the ledger holds.
const netFromFile = rows.reduce(
  (sum, r) => sum + (r.kind === 'purchase' || r.kind === 'fee' ? -(r.amountAed ?? 0) : (r.amountAed ?? 0)),
  0,
);
const netFromLedger = transactions.reduce((s, t) => s + t.amount_aed, 0);
check(
  'the net movement is identical after the round trip',
  Math.abs(netFromFile - netFromLedger) < 0.005,
  `${netFromFile.toFixed(2)} vs ${netFromLedger.toFixed(2)}`,
);

/* ------------------------------------------- re-uploading what is already in */

const reRead = buildRows(sheet, analysis.headerRow, analysis.mapping, {
  dayFirst: analysis.dayFirst,
  existing: transactions,
  cardId: 'c1',
});
check(
  'every row of a re-uploaded export is recognised as already in the ledger',
  reRead.every((r) => Boolean(r.duplicateOf)),
  `${reRead.filter((r) => r.duplicateOf).length} of ${reRead.length}`,
);
check(
  'and none of them is ticked for import by default',
  reRead.every((r) => r.include === false),
);

/* ---------------------------------------- a genuine repeat charge is not lost */

const twiceSheet = {
  name: 'twice',
  rows: [
    ['Date', 'Supplier', 'AED settlement'],
    ['2026-04-02', 'STARBUCKS DXB', -48.5],
    ['2026-04-02', 'STARBUCKS DXB', -48.5],
  ],
};
const twice = buildRows(twiceSheet, 0, { date: 0, supplier: 1, signed_amount: 2 }, {
  dayFirst: true,
});
check('two identical rows in one file both survive', twice.length === 2, String(twice.length));
check(
  'the second is flagged as identical to the first rather than dropped',
  twice[1].warnings.some((w) => /identical to row/i.test(w)) && twice[1].errors.length === 0,
  twice[1].warnings.join('; '),
);

console.log();
if (failures) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log('All checks passed.');
