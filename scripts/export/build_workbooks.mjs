/**
 * Builds the two export workbooks from synthetic data so that a separate
 * program can open them and check what is actually inside.
 *
 * The point of splitting this in two is that the checker must not share code
 * with the writer. This file writes .xlsx bytes using the application's own
 * builder; verify_xlsx.py opens them with openpyxl — a completely independent
 * implementation of the format — and compares what it finds against the
 * expected data, which is also written out here as plain JSON.
 *
 *   node scripts/export/build_workbooks.mjs <output-dir>
 *
 * The module under test is TypeScript importing fflate. Set EXPORT_BUNDLE to a
 * prebuilt bundle when the web workspace has no node_modules:
 *
 *   esbuild web/src/lib/export.ts --bundle --format=esm --platform=node \
 *     --outfile=/tmp/export.mjs
 *   EXPORT_BUNDLE=/tmp/export.mjs node scripts/export/build_workbooks.mjs /tmp/out
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';

const outDir = resolve(process.argv[2] ?? '.');
mkdirSync(outDir, { recursive: true });

const modulePath = process.env.EXPORT_BUNDLE
  ? resolve(process.env.EXPORT_BUNDLE)
  : resolve('web/src/lib/export.ts');
const { buildXlsx, buildXlsxByCard, buildCsv, safeSheetName } = await import(
  pathToFileURL(modulePath).href
);

/* ------------------------------------------------------------------ the data
 *
 * Chosen to break things rather than to look tidy:
 *   - a name longer than Excel's 31-character limit
 *   - a name whose first 31 characters collide with the one above
 *   - every character Excel forbids in a tab name
 *   - a card with no transactions at all
 *   - text with &, <, ", newlines and a non-Latin script
 *   - a negative amount, a zero-decimal amount, and a long decimal
 */

const card = (id, name, over) => ({
  id,
  name,
  settlementCurrency: 'AED',
  openingBalance: 0,
  openingDate: '2026-01-01',
  lastTransaction: null,
  sourceBalance: 0,
  ledgerBalance: 0,
  reconciliationDifference: 0,
  totalSpend: 0,
  totalFunding: 0,
  reviewAdjustmentsTotal: 0,
  needsReview: 0,
  excluded: 0,
  transactionCount: 0,
  sourceHeaderRow: 1,
  decreasingColumn: 'D',
  decreasingHeader: 'DEBIT',
  increasingColumn: 'E',
  increasingHeader: 'CREDIT',
  balanceFormula: '=F5-D6+E6',
  headerIsMisleading: false,
  verifiedRows: 0,
  ...over,
});

const cards = [
  card('c1', 'AMEX 3024', { openingBalance: 10000, ledgerBalance: 7500, sourceBalance: 7500 }),
  card('c2', 'MASTERCARD 5135 (4173) (7206) LONG TAIL', { ledgerBalance: -1552.78 }),
  card('c3', 'MASTERCARD 5135 (4173) (7206) OTHER TAIL', { ledgerBalance: 0 }),
  card('c4', 'RAK 9825 / 6071 [main] *test?: yes', { ledgerBalance: 42 }),
  card('c5', 'Card With No Activity', { ledgerBalance: 0, openingDate: null }),
];

const txn = (id, cardId, over) => ({
  id,
  cardId,
  entry_type: 'transaction',
  status: 'active',
  amount_aed: -100,
  direction: 'spend',
  txn_date: '2026-03-01',
  occurrence: 1,
  ...over,
});

const transactions = [
  txn('t1', 'c1', { txn_date: '2026-01-15', amount_aed: -2500, supplier: 'Smith & Sons <Travel>' }),
  txn('t2', 'c1', {
    txn_date: '2026-02-20',
    amount_aed: 1000,
    direction: 'funding',
    supplier: 'Refund "partial"',
    currency: 'USD',
    original_amount: 272.25,
    exchange_rate: 3.6725,
    normalized_exchange_rate: 3.6731,
  }),
  txn('t3', 'c1', { txn_date: '2026-03-05', amount_aed: -1000, supplier: 'مورد عربي' }),
  txn('t4', 'c2', { txn_date: '2026-04-01', amount_aed: -1552.78, supplier: 'Line\nbreak' }),
  txn('t5', 'c3', { txn_date: '2026-05-11', amount_aed: -0.01, supplier: 'Tiny' }),
  txn('t6', 'c4', { txn_date: '2026-06-30', amount_aed: 42, direction: 'funding', supplier: 'Odd/Name' }),
  txn('t7', 'c4', { txn_date: '2026-07-04', amount_aed: -0.005, supplier: 'Sub-cent' }),
];

/* ------------------------------------------------------------------- write */

writeFileSync(join(outDir, 'by_card.xlsx'), Buffer.from(buildXlsxByCard(transactions, cards)));
writeFileSync(
  join(outDir, 'single.xlsx'),
  Buffer.from(buildXlsx(transactions, cards, '7 transactions — no filters applied')),
);
writeFileSync(
  join(outDir, 'single.csv'),
  buildCsv(transactions, cards, '7 transactions — no filters applied'),
  'utf8',
);

// What the checker is entitled to expect, stated independently of the writer.
writeFileSync(
  join(outDir, 'expected.json'),
  JSON.stringify(
    {
      cards: cards.map((c) => ({
        id: c.id,
        name: c.name,
        ledgerBalance: c.ledgerBalance,
        openingDate: c.openingDate,
        count: transactions.filter((t) => t.cardId === c.id).length,
      })),
      transactions: transactions.map((t) => ({
        id: t.id,
        cardId: t.cardId,
        date: t.txn_date,
        amount: t.amount_aed,
        supplier: t.supplier,
        currency: t.currency ?? null,
      })),
    },
    null,
    2,
  ),
  'utf8',
);

// A couple of pure-function checks that need no spreadsheet reader.
let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
{
  const taken = new Set();
  const a = safeSheetName('MASTERCARD 5135 (4173) (7206) LONG TAIL', taken);
  const b = safeSheetName('MASTERCARD 5135 (4173) (7206) OTHER TAIL', taken);
  check('a sheet name is trimmed to 31 characters', a.length <= 31, a);
  check('two names that collide after trimming are made distinct', a !== b, `${a} / ${b}`);
  check('the second keeps the 31-character limit', b.length <= 31, b);
  const c = safeSheetName('RAK 9825 / 6071 [main] *test?: yes', taken);
  check('forbidden characters are removed', !/[:\/?*[\]]/.test(c), c);
  const d = safeSheetName('///', taken);
  check('a name that sanitises to nothing still gets one', d.length > 0, d);
}

console.log(`\nWrote ${outDir}`);
process.exit(failures ? 1 : 0);
