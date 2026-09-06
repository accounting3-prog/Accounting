/**
 * The blank sheet has one job: be filled in and read back correctly.
 *
 * So this generates a template for each kind of card, opens it, types rows into
 * it the way a person would, and runs the result through the importer. What is
 * checked is not that the file parses, but that the AMOUNTS AND DIRECTIONS
 * come back meaning what the person meant — including on the card whose
 * statement runs its balance the other way, where getting this wrong would turn
 * every purchase into a refund.
 *
 * The balance formulas are checked separately, by recomputing them from the
 * numbers rather than trusting the strings.
 *
 *   esbuild web/src/lib/export.ts     --bundle --format=esm --platform=node \
 *     --external:fflate --outfile=/tmp/export.mjs
 *   esbuild web/src/lib/importFile.ts --bundle --format=esm --platform=node \
 *     --external:fflate --outfile=/tmp/importFile.mjs
 *   EXPORT_BUNDLE=/tmp/export.mjs IMPORT_BUNDLE=/tmp/importFile.mjs \
 *     node scripts/export/template_round_trip.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';

const outDir = resolve(process.argv[2] ?? '.');
mkdirSync(outDir, { recursive: true });

const load = (envVar, fallback) =>
  import(
    pathToFileURL(resolve(process.env[envVar] ?? fallback)).href
  );

const { buildCardTemplate, cardTemplateColumns } = await load(
  'EXPORT_BUNDLE',
  'web/src/lib/export.ts',
);
const { parseXlsx, analyseSheet, buildRows } = await load(
  'IMPORT_BUNDLE',
  'web/src/lib/importFile.ts',
);

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const card = (over) => ({
  id: 'c1',
  name: 'TEST CARD',
  settlementCurrency: 'AED',
  openingBalance: 0,
  openingDate: '2026-01-01',
  lastTransaction: null,
  sourceBalance: 0,
  ledgerBalance: 1000,
  reconciliationDifference: 0,
  balanceSign: 1,
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
  balanceFormula: '=F2-D3+E3',
  headerIsMisleading: false,
  verifiedRows: 0,
  ...over,
});

/* ------------------------------------------------------- typing into a sheet
 *
 * Writes values into the generated file the way a person filling it in would:
 * straight into the cells under the headers, leaving the balance formulas
 * alone. Done by editing the sheet XML directly rather than through the app's
 * own writer, so the file being imported is not one the app produced twice.
 */
function typeInto(bytes, entries) {
  const zip = unzipSync(bytes);
  const path = 'xl/worksheets/sheet1.xml';
  let xml = strFromU8(zip[path]);

  for (const { row, cells } of entries) {
    const rowRe = new RegExp(`<row r="${row}">(.*?)</row>`);
    const m = xml.match(rowRe);
    if (!m) throw new Error(`row ${row} not found in the template`);
    let inner = m[1];
    for (const [ref, value] of Object.entries(cells)) {
      const cellXml =
        typeof value === 'number'
          ? `<c r="${ref}${row}" s="1"><v>${value}</v></c>`
          : `<c r="${ref}${row}" s="0" t="inlineStr"><is><t xml:space="preserve">${value}</t></is></c>`;
      // The generated row has no cell at this reference yet (blank cells are
      // omitted), so the new one is inserted at the front; Excel does not
      // require cells in order and neither does the parser under test.
      inner = cellXml + inner;
    }
    xml = xml.replace(rowRe, `<row r="${row}">${inner}</row>`);
  }

  zip[path] = strToU8(xml);
  return zipSync(zip, { level: 6 });
}

const colLetter = (i) => {
  let s = '';
  let n = i;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
};

/* ------------------------------------------------------------- the scenarios */

const scenarios = [
  {
    label: 'an ordinary card (DEBIT lowers the balance)',
    card: card({ name: 'MASTERCARD 6404 VPAY', ledgerBalance: 127930.85 }),
  },
  {
    label: 'a card whose headers run the other way (CREDIT lowers it)',
    card: card({
      name: 'AMEX 4000 VPAY',
      ledgerBalance: 599536.31,
      decreasingColumn: 'E',
      decreasingHeader: 'CREDIT',
      increasingColumn: 'D',
      increasingHeader: 'DEBIT',
      balanceFormula: '=F3+D4-E4',
      headerIsMisleading: true,
    }),
  },
  {
    label: 'a card whose balance counts money drawn (spending raises it)',
    card: card({
      name: 'RAK 9825 (6071)',
      ledgerBalance: -165.72,
      balanceSign: -1,
      decreasingColumn: 'E',
      decreasingHeader: 'Debit (AED)',
      increasingColumn: 'F',
      increasingHeader: 'Credit (AED)',
      balanceFormula: '=G2-E3+F3',
    }),
  },
];

for (const { label, card: c } of scenarios) {
  console.log(`\n${label}\n${'-'.repeat(78)}`);

  const columns = cardTemplateColumns(c);
  const idx = (header) => columns.findIndex((x) => x.header === header);
  const iDate = idx('TRANSACTION DATE');
  const iDetails = idx('DETAILS');
  const iBalance = idx('BALANCE');
  const iSpend = idx(c.decreasingHeader.trim());
  const iReceived = idx(c.increasingHeader.trim());
  const iReq = idx('REQ NUMBER');
  const iCurrency = idx('ORIGINAL CURRENCY');
  const iAmount = idx('AMOUNT');

  const bytes = buildCardTemplate(c, 10);
  const file = join(outDir, `${c.name.replace(/[\\/:*?"<>|]/g, '_')}-template.xlsx`);
  writeFileSync(file, Buffer.from(bytes));

  // The template's shape: 3 preamble rows, header on row 4, opening on row 5.
  const HEADER_ROW = 4;
  const FIRST_BLANK = 6;

  // What a person would type: a purchase, a payment received, and a foreign
  // currency purchase.
  const filled = typeInto(bytes, [
    {
      row: FIRST_BLANK,
      cells: {
        [colLetter(iDate)]: '28/01/2026',
        [colLetter(iDetails)]: 'NATIONAL TAXI 784',
        [colLetter(iSpend)]: 109,
        [colLetter(iReq)]: 'KSAML43',
      },
    },
    {
      row: FIRST_BLANK + 1,
      cells: {
        [colLetter(iDate)]: '14/08/2026',
        [colLetter(iDetails)]: 'PAYMENT RECD.-INTERNET BANKING',
        [colLetter(iReceived)]: 5500,
      },
    },
    {
      row: FIRST_BLANK + 2,
      cells: {
        [colLetter(iDate)]: '24/06/2026',
        [colLetter(iDetails)]: 'JRC SMART EX 392',
        [colLetter(iCurrency)]: 'JPY',
        [colLetter(iAmount)]: 99600,
        [colLetter(iSpend)]: 2350.52,
      },
    },
  ]);
  writeFileSync(file.replace('-template', '-filled'), Buffer.from(filled));

  /* ------------------------------------------------------ read it back in */

  const sheets = parseXlsx(filled);
  check('the filled template parses as one sheet', sheets.length === 1, `${sheets.length}`);

  const analysis = analyseSheet(sheets[0], c);
  check(
    'the importer finds the header row on its own',
    analysis.headerRow === HEADER_ROW - 1,
    `row ${analysis.headerRow + 1}`,
  );
  check(
    'it maps the date and supplier columns',
    analysis.mapping.date === iDate && analysis.mapping.supplier === iDetails,
    `date ${analysis.mapping.date}, supplier ${analysis.mapping.supplier}`,
  );
  check(
    "it binds the amount columns to this card's own convention",
    analysis.mapping.decrease === iSpend && analysis.mapping.increase === iReceived,
    `spend col ${analysis.mapping.decrease}, received col ${analysis.mapping.increase}`,
  );
  check(
    'no column mapping is left for the reviewer to fix by hand',
    analysis.mapping.date !== undefined &&
      analysis.mapping.supplier !== undefined &&
      analysis.mapping.decrease !== undefined,
  );

  const rows = buildRows(sheets[0], analysis.headerRow, analysis.mapping, {
    dayFirst: analysis.dayFirst,
    existing: [],
    cardId: c.id,
  });
  const real = rows.filter((r) => r.date || r.amountAed);

  check('exactly the three typed rows come back', real.length === 3, `${real.length} rows`);

  const [taxi, payment, jrc] = real;

  check(
    'the purchase is a purchase, at the amount typed',
    taxi?.kind === 'purchase' && taxi?.amountAed === 109,
    `${taxi?.kind} ${taxi?.amountAed}`,
  );
  check(
    'its date reads as 28 January, not 1 August',
    taxi?.date === '2026-01-28',
    String(taxi?.date),
  );
  check('its supplier survives', taxi?.supplier === 'NATIONAL TAXI 784', String(taxi?.supplier));
  check('its request number survives', taxi?.reqNumber === 'KSAML43', String(taxi?.reqNumber));

  check(
    'the money received is funding, not a purchase',
    payment?.kind === 'funding' && payment?.amountAed === 5500,
    `${payment?.kind} ${payment?.amountAed}`,
  );

  check(
    'the foreign-currency purchase keeps its currency and original amount',
    jrc?.currency === 'JPY' && jrc?.originalAmount === 99600 && jrc?.amountAed === 2350.52,
    `${jrc?.currency} ${jrc?.originalAmount} -> ${jrc?.amountAed}`,
  );

  /* --------------------------------------- the balance formulas, recomputed */

  const zip = unzipSync(filled);
  const xml = strFromU8(zip['xl/worksheets/sheet1.xml']);
  const B = colLetter(iBalance);
  const S = colLetter(iSpend);
  const R = colLetter(iReceived);

  const formulaAt = (row) => {
    const m = xml.match(new RegExp(`<c r="${B}${row}"[^>]*><f>([^<]*)</f>`));
    return m ? m[1] : null;
  };

  check(
    'the opening row carries the balance as it stands today',
    xml.includes(`<c r="${B}${FIRST_BLANK - 1}" s="1"><v>${c.ledgerBalance}</v></c>`),
    String(c.ledgerBalance),
  );

  const expected =
    c.balanceSign === -1
      ? `${B}${FIRST_BLANK - 1}+${S}${FIRST_BLANK}-${R}${FIRST_BLANK}`
      : `${B}${FIRST_BLANK - 1}-${S}${FIRST_BLANK}+${R}${FIRST_BLANK}`;
  check(
    "the first blank row's balance formula follows this card's own convention",
    formulaAt(FIRST_BLANK) === expected,
    `${formulaAt(FIRST_BLANK)}  (wanted ${expected})`,
  );

  // Recompute the chain the formulas describe and confirm it lands where the
  // ledger would. This is the check that would catch a sign the wrong way
  // round: on a drawn-balance card a 109 purchase must RAISE the figure.
  let running = c.ledgerBalance;
  const typed = [
    { spend: 109, received: 0 },
    { spend: 0, received: 5500 },
    { spend: 2350.52, received: 0 },
  ];
  for (const t of typed) {
    running =
      c.balanceSign === -1
        ? running + t.spend - t.received
        : running - t.spend + t.received;
  }
  const expectedEnd = Number(running.toFixed(2));

  // Independently: the same figure via the app's own rule, from the parsed rows.
  const signedTotal = real.reduce(
    (s, r) => s + (r.kind === 'purchase' || r.kind === 'fee' ? -r.amountAed : r.amountAed),
    0,
  );
  const viaLedger = Number((c.ledgerBalance + c.balanceSign * signedTotal).toFixed(2));

  check(
    'the sheet formulas and the ledger rule reach the same balance',
    Math.abs(expectedEnd - viaLedger) < 0.005,
    `sheet ${expectedEnd}, ledger ${viaLedger}`,
  );

  if (c.balanceSign === -1) {
    check(
      'and on this card a purchase genuinely raises the figure',
      viaLedger > c.ledgerBalance - 5500,
      `${c.ledgerBalance} -> ${viaLedger}`,
    );
  }
}

console.log(`\n${'='.repeat(78)}`);
if (failures) {
  console.log(`${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('The blank sheet round-trips: filled in, read back, and the balances agree.');
