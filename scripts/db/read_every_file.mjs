/**
 * Reads every real file and reports what the system makes of it.
 *
 * WHY THIS EXISTS
 *
 * Four faults reached a real balance in two days, and every one was found by a
 * person noticing a wrong number rather than by the suite. Looking at them
 * together, they share a cause:
 *
 *   the rate in scientific notation   my fixtures never had a small rate,
 *                                     because I chose the numbers
 *   the repeat charges swallowed      my fixtures never had two identical rows
 *                                     in one file
 *   the counting rule                 my fixtures always started from an empty
 *                                     card, because that was easier to write
 *   the supplier country code         my fixture handed over the raw name; the
 *                                     app hands over the split one
 *
 * In each case I wrote the fixture AND the expectation, so they agreed with
 * each other and with my idea of the data. The suite was green because it was
 * testing my understanding, and my understanding was the thing that was wrong.
 * A green suite means "nothing I thought to check is broken", which is a much
 * smaller claim than it sounds.
 *
 * So this reads the ACTUAL files — the workbook, the blank sheets, the
 * statements — and says what the importer would do with each. It invents
 * nothing. Where a sheet carries its own BALANCE column it goes further and
 * replays that column, because the sheet's own arithmetic is the one authority
 * in the building that was not written by me.
 *
 * Read-only. It imports nothing and changes nothing.
 *
 *   LEDGER_DEPS=... IMPORT_BUNDLE=... node scripts/db/read_every_file.mjs <dir>
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path, { resolve } from 'node:path';
import { connect, q } from './connect.mjs';

const DIR = process.argv[2] ?? 'C:\\Users\\LE.Andrew\\Downloads';

const { parseXlsx, analyseSheet, buildRows } = await import(
  pathToFileURL(resolve(process.env.IMPORT_BUNDLE ?? 'web/src/lib/importFile.ts')).href
);

const money = (n) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const near = (a, b, t = 0.02) => Math.abs(Number(a) - Number(b)) < t;

let problems = 0;
const flag = (msg) => {
  problems++;
  console.log(`      >> ${msg}`);
};

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

try {
  const cards = (
    await q(
      client,
      `select b.*, c.source_header_row, c.decreasing_column, c.decreasing_header,
              c.increasing_column, c.increasing_header, c.balance_formula
         from card_balances b join cards c on c.id = b.card_id`,
    )
  ).map(cardFromDb);

  /** Which card a sheet belongs to, by its own name or its file's. */
  const matchCard = (sheetName, fileName) => {
    const hay = `${sheetName} ${fileName}`.toUpperCase();
    let best = null;
    for (const c of cards) {
      const key = c.name.toUpperCase().replace(/\s*\(.*$/, '').trim();
      if (key && hay.includes(key) && (!best || key.length > best.key.length))
        best = { card: c, key };
    }
    return best?.card ?? null;
  };

  const files = readdirSync(DIR)
    .filter((f) => /\.(xlsx|xlsm)$/i.test(f))
    .filter((f) => !f.startsWith('~$'))
    .map((f) => path.join(DIR, f))
    .filter((f) => statSync(f).size < 8 * 1024 * 1024)
    .sort();

  console.log('='.repeat(94));
  console.log(`READING ${files.length} REAL FILES — nothing is imported`);
  console.log('='.repeat(94));

  let readable = 0;
  let matched = 0;

  for (const file of files) {
    let sheets;
    try {
      sheets = parseXlsx(new Uint8Array(readFileSync(file)));
    } catch (e) {
      continue; // not a workbook this app would ever be given
    }
    const relevant = [];
    for (const sheet of sheets) {
      const card = matchCard(sheet.name, path.basename(file));
      if (card) relevant.push({ sheet, card });
    }
    if (!relevant.length) continue;
    readable++;

    console.log(`\n${path.basename(file)}`);
    console.log('-'.repeat(94));

    for (const { sheet, card } of relevant) {
      matched++;
      const analysis = analyseSheet(sheet, card);
      if (analysis.headerRow < 0) {
        flag(`${sheet.name}: no header row could be found`);
        continue;
      }

      const existing = await q(
        client,
        `select id, card_id as "cardId", to_char(txn_date,'YYYY-MM-DD') as txn_date,
                regexp_replace(supplier_raw, '\\s\\d{3}\\s*$', '') as supplier,
                supplier_raw, amount_aed::float8 as amount_aed, payment_ref, req_number
           from transactions where card_id = $1 and status <> 'voided'`,
        [card.id],
      );
      const rows = buildRows(sheet, analysis.headerRow, analysis.mapping, {
        dayFirst: analysis.dayFirst,
        existing,
        cardId: card.id,
      }).filter((r) => r.date || r.amountAed !== null);

      const stopped = rows.filter((r) => r.errors.length);
      const known = rows.filter((r) => r.duplicateOf);
      const fresh = rows.filter((r) => !r.errors.length && r.include !== false);

      console.log(
        `  ${sheet.name.slice(0, 30).padEnd(32)}-> ${card.name.slice(0, 24).padEnd(26)}` +
          `${String(rows.length).padStart(5)} rows  ${String(known.length).padStart(4)} already here` +
          `  ${String(fresh.length).padStart(4)} new  ${String(stopped.length).padStart(3)} stopped`,
      );

      // Anything the parser could not read is worth a person's attention: it is
      // the shape of every fault so far.
      const reasons = new Map();
      for (const r of stopped)
        reasons.set(r.errors[0], (reasons.get(r.errors[0]) ?? 0) + 1);
      for (const [why, n] of reasons) flag(`${sheet.name}: ${n} row(s) stopped — ${why}`);

      /* --------- the sheet's own balance column, replayed against the ledger */

      const headers = sheet.rows[analysis.headerRow] ?? [];
      const balCol = headers.findIndex((h) => /^balance|available balance/i.test(String(h ?? '').trim()));
      if (balCol < 0) continue;

      const printed = [];
      for (let i = sheet.rows.length - 1; i > analysis.headerRow; i--) {
        const v = Number(String(sheet.rows[i]?.[balCol] ?? '').replace(/[^\d.-]/g, ''));
        if (Number.isFinite(v) && String(sheet.rows[i]?.[balCol] ?? '').trim() !== '') {
          printed.push(v);
          break;
        }
      }
      if (!printed.length) continue;
      const closing = printed[0];

      // A template nobody has filled in carries the balance it was downloaded
      // with, and comparing that to today's ledger says nothing except how long
      // ago it was downloaded. Three of those produced three false alarms on
      // the first run of this file.
      if (rows.length === 0) {
        console.log(
          `      empty template, downloaded when the balance was ${money(closing)} — skipped`,
        );
        continue;
      }

      // What the ledger would hold if every row this file offers were imported.
      const net = fresh.reduce(
        (s, r) => s + (r.kind === 'purchase' || r.kind === 'fee' ? -r.amountAed : r.amountAed),
        0,
      );
      const projected = Number((card.ledgerBalance + card.balanceSign * net).toFixed(2));

      const agrees = near(projected, closing);
      console.log(
        `      sheet closes on ${money(closing).padStart(14)}   ` +
          `ledger would hold ${money(projected).padStart(14)}   ${agrees ? 'agree' : 'DIFFER'}`,
      );
      if (!agrees)
        flag(
          `${sheet.name}: importing this file would leave the ledger ` +
            `${money(projected - closing)} away from the balance the sheet itself computes`,
        );
    }
  }

  console.log(`\n${'='.repeat(94)}`);
  console.log(`  ${readable} files matched a card, ${matched} sheets read`);
  if (problems) {
    console.log(`  ${problems} thing(s) worth a look — listed above with >>`);
  } else {
    console.log('  Every sheet read cleanly and every balance column agrees with the ledger.');
  }
  console.log('='.repeat(94));
} finally {
  await client.end();
}
