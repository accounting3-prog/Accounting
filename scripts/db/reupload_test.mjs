/**
 * Two questions about working with the sheets, answered against the real
 * database rather than by reasoning about the code.
 *
 *   1. If I export a card's rows, add new ones to the file, and upload the whole
 *      thing back — does the system read it, skip what it already has, and move
 *      the balance by exactly the new rows?
 *
 *   2. When I then download a blank sheet for that card, does it open on the
 *      new balance?
 *
 * Everything is done through the same paths the app uses: the exporter builds
 * the file, the importer reads it, create_transaction writes each row. Rolled
 * back at the end, so it can be run against the live project.
 *
 *   esbuild web/src/lib/export.ts     --bundle --format=esm --platform=node \
 *     --external:fflate --outfile=/tmp/export.mjs
 *   esbuild web/src/lib/importFile.ts --bundle --format=esm --platform=node \
 *     --external:fflate --outfile=/tmp/importFile.mjs
 *   LEDGER_DEPS=... EXPORT_BUNDLE=/tmp/export.mjs IMPORT_BUNDLE=/tmp/importFile.mjs \
 *     node scripts/db/reupload_test.mjs
 */

import { pathToFileURL } from 'node:url';
import path, { resolve } from 'node:path';
import { connect, q } from './connect.mjs';

// fflate, like pg, comes from the directory LEDGER_DEPS points at. Nothing is
// installed into the repository itself.
const fflate = await import(
  pathToFileURL(
    path.join(process.env.FFLATE_DIR ?? process.env.LEDGER_DEPS, 'node_modules/fflate/esm/browser.js'),
  ).href
);
const { unzipSync, zipSync, strToU8, strFromU8 } = fflate;

const load = (envVar, fallback) =>
  import(pathToFileURL(resolve(process.env[envVar] ?? fallback)).href);

const { buildXlsxByCard, buildCardTemplate, cardTemplateColumns } = await load(
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
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(60)}${detail}`);
};
const near = (a, b, t = 0.005) => Math.abs(Number(a) - Number(b)) < t;
const money = (n) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const colLetter = (i) => {
  let s = '';
  let n = i;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
};

/** Types values into an existing sheet, the way a person filling one in would. */
function typeInto(bytes, sheetNumber, entries) {
  const zip = unzipSync(bytes);
  // Named explicitly. The workbook's first sheet is the summary tab, and
  // picking "the first worksheet part" would type the new transactions into
  // that instead of into the card — which is exactly what happened first.
  const part = `xl/worksheets/sheet${sheetNumber}.xml`;
  if (!zip[part]) throw new Error(`no ${part} in the workbook`);
  let xml = strFromU8(zip[part]);
  const lastRow = Math.max(
    ...[...xml.matchAll(/<row r="(\d+)"/g)].map((m) => Number(m[1])),
  );
  let n = lastRow;
  const rows = entries
    .map((cells) => {
      n += 1;
      const inner = Object.entries(cells)
        .map(([ref, value]) =>
          typeof value === 'number'
            ? `<c r="${ref}${n}" s="1"><v>${value}</v></c>`
            : `<c r="${ref}${n}" s="0" t="inlineStr"><is><t xml:space="preserve">${value}</t></is></c>`,
        )
        .join('');
      return `<row r="${n}">${inner}</row>`;
    })
    .join('');
  xml = xml.replace('</sheetData>', `${rows}</sheetData>`);
  zip[part] = strToU8(xml);
  return zipSync(zip, { level: 6 });
}

/** The Card shape the exporter and importer both expect. */
const cardFromDb = (row) => ({
  id: row.card_id,
  name: row.card_name,
  settlementCurrency: row.settlement_currency,
  openingBalance: Number(row.opening_balance),
  openingDate: row.opening_date ? String(row.opening_date).slice(0, 10) : null,
  lastTransaction: null,
  sourceBalance: Number(row.source_balance),
  ledgerBalance: Number(row.ledger_balance),
  reconciliationDifference: Number(row.reconciliation_difference),
  balanceSign: Number(row.balance_sign) === -1 ? -1 : 1,
  totalSpend: Number(row.total_spend),
  totalFunding: Number(row.total_funding),
  reviewAdjustmentsTotal: 0,
  needsReview: 0,
  excluded: 0,
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

async function cardRow(name) {
  const [row] = await q(
    client,
    `select b.*, c.source_header_row, c.decreasing_column, c.decreasing_header,
            c.increasing_column, c.increasing_header, c.balance_formula
       from card_balances b join cards c on c.id = b.card_id
      where b.card_name = $1`,
    [name],
  );
  return cardFromDb(row);
}

try {
  const [admin] = await q(
    client,
    'select user_id from admins where is_owner order by created_at limit 1',
  );
  if (!admin) throw new Error('no owner account to run as');

  console.log('='.repeat(94));
  console.log('RE-UPLOADING A SHEET — does it read the new rows, and only those?');
  console.log('='.repeat(94));

  await client.query('begin');
  await client.query('set local role authenticated');
  await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [admin.user_id]);

  // A card whose balance runs the ordinary way, and the one that does not.
  for (const cardName of ['MASTERCARD 6404 VPAY', 'RAK 9825 (6071)']) {
    console.log(`\n${cardName}`);
    console.log('-'.repeat(94));

    const before = await cardRow(cardName);
    console.log(`  balance before: ${money(before.ledgerBalance)} AED, ` +
                `${before.transactionCount} transactions`);

    /* ---------------------------------------------------------- 1. export */

    const existing = await q(
      client,
      `select id, card_id as "cardId", entry_type, status,
              to_char(txn_date, 'YYYY-MM-DD') as txn_date,
              supplier_raw as supplier, amount_aed::float8 as amount_aed, direction,
              currency, original_amount::float8 as original_amount,
              exchange_rate::float8 as exchange_rate, req_number, payment_ref,
              source_sheet, source_row
         from transactions where card_id = $1 and status <> 'voided'
        order by txn_date desc limit 60`,
      [before.id],
    );
    const workbook = buildXlsxByCard(existing, [before]);
    check('the card exports to a workbook', workbook.length > 0, `${workbook.length} bytes`);

    /* ------------------------------------------- 2. add rows to that file */

    // The exported sheet's own header, so the new rows land in the right columns.
    const sheets = parseXlsx(workbook);
    const mineIndex = sheets.findIndex((s) => s.name.startsWith(cardName.slice(0, 20)));
    const mine = sheets[mineIndex];
    check('the exported workbook has a tab for this card', Boolean(mine), mine?.name ?? '—');
    check('and it is not the summary tab', mineIndex > 0, `tab ${mineIndex + 1}`);

    const headerRow = mine.rows.findIndex((r) => r[0] === 'Card');
    const headers = mine.rows[headerRow];
    const at = (name) => colLetter(headers.indexOf(name));

    const stamp = Date.now().toString().slice(-6);
    const added = [
      {
        [at('Card')]: cardName,
        [at('Date')]: '2026-09-05',
        [at('Supplier')]: `REUPLOAD NEW ONE ${stamp}`,
        [at('AED settlement')]: -1234.56,
        [at('Request number')]: `RU-REQ-${stamp}-1`,
        [at('Payment reference')]: `RU-${stamp}-1`,
      },
      {
        [at('Card')]: cardName,
        [at('Date')]: '2026-09-06',
        [at('Supplier')]: `REUPLOAD NEW TWO ${stamp}`,
        [at('AED settlement')]: 500,
        [at('Request number')]: `RU-REQ-${stamp}-2`,
        [at('Payment reference')]: `RU-${stamp}-2`,
      },
    ];
    const refilled = typeInto(workbook, mineIndex + 1, added);

    /* ---------------------------------------------------- 3. read it back */

    const reparsed = parseXlsx(refilled).find((s) => s.name === mine.name);
    const analysis = analyseSheet(reparsed, before);
    const known = await q(
      client,
      `select id, card_id as "cardId",
              to_char(txn_date, 'YYYY-MM-DD') as txn_date,
              supplier_raw as supplier, amount_aed::float8 as amount_aed,
              payment_ref, req_number
         from transactions where card_id = $1 and status <> 'voided'`,
      [before.id],
    );
    const rows = buildRows(reparsed, analysis.headerRow, analysis.mapping, {
      dayFirst: analysis.dayFirst,
      existing: known,
      cardId: before.id,
    });

    const real = rows.filter((r) => r.date || r.amountAed);
    const flagged = real.filter((r) => r.duplicateOf);
    const fresh = real.filter((r) => !r.duplicateOf && r.errors.length === 0);

    check(
      'every row already in the ledger is recognised and set aside',
      flagged.length === existing.length,
      `${flagged.length} of ${existing.length} known rows flagged`,
    );
    check(
      'only the two new rows are left to import',
      fresh.length === 2,
      `${fresh.length}: ${fresh.map((r) => r.supplier).join(', ')}`,
    );
    check(
      'and none of them is unticked by default',
      fresh.every((r) => r.include !== false),
    );

    /* --------------------------------------------------------- 4. import */

    for (const row of fresh) {
      await client.query(
        `select create_transaction(
           p_card_id := $1, p_txn_date := $2, p_kind := $3, p_amount_aed := $4,
           p_supplier := $5, p_req_number := $6, p_payment_ref := $7)`,
        [
          before.id,
          row.date,
          row.kind,
          row.amountAed,
          row.supplier,
          row.reqNumber ?? '',
          row.paymentRef ?? '',
        ],
      );
    }

    const after = await cardRow(cardName);
    const expected =
      before.ledgerBalance +
      before.balanceSign * fresh.reduce(
        (s, r) => s + (r.kind === 'purchase' || r.kind === 'fee' ? -r.amountAed : r.amountAed),
        0,
      );

    check(
      'the balance moved by exactly the new rows',
      near(after.ledgerBalance, expected),
      `${money(before.ledgerBalance)} -> ${money(after.ledgerBalance)} (wanted ${money(expected)})`,
    );
    check(
      'nothing was recorded twice',
      after.transactionCount === before.transactionCount + 2,
      `${before.transactionCount} -> ${after.transactionCount}`,
    );
    check(
      'and re-uploading the very same file again adds nothing',
      (
        buildRows(reparsed, analysis.headerRow, analysis.mapping, {
          dayFirst: analysis.dayFirst,
          existing: await q(
            client,
            `select id, card_id as "cardId", to_char(txn_date,'YYYY-MM-DD') as txn_date,
                    supplier_raw as supplier, amount_aed::float8 as amount_aed,
                    payment_ref, req_number
               from transactions where card_id = $1 and status <> 'voided'`,
            [before.id],
          ),
          cardId: before.id,
        }).filter((r) => (r.date || r.amountAed) && !r.duplicateOf && r.errors.length === 0)
      ).length === 0,
    );

    /* --------------------------------- 5. the next blank sheet is current */

    const template = buildCardTemplate(after, 5);
    const columns = cardTemplateColumns(after);
    const iBalance = columns.findIndex((c) => c.header === 'BALANCE');
    const B = colLetter(iBalance);
    const xml = strFromU8(unzipSync(template)['xl/worksheets/sheet1.xml']);

    // Row 5 is the opening line of the template: the balance as it stands now.
    const opening = new RegExp(`<c r="${B}5"[^>]*><v>([-\\d.]+)</v></c>`).exec(xml);
    check(
      'a blank sheet downloaded now opens on the NEW balance',
      opening !== null && near(opening[1], after.ledgerBalance),
      `sheet says ${opening ? money(opening[1]) : 'nothing'}, ledger says ${money(after.ledgerBalance)}`,
    );
    check(
      'which is not the balance it would have shown before the import',
      !near(after.ledgerBalance, before.ledgerBalance),
      `${money(before.ledgerBalance)} then, ${money(after.ledgerBalance)} now`,
    );
  }

  await client.query('rollback');
  console.log('\n  Rolled back — the live ledger is untouched.');
} finally {
  await client.end();
}

console.log('\n' + '='.repeat(94));
if (failures) {
  console.log(`${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('A re-uploaded sheet imports only what is new, and the next blank sheet is current.');
console.log('='.repeat(94));
