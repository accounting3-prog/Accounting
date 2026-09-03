/**
 * Imports the validated extraction into Supabase.
 *
 * SERVER-SIDE ONLY. This reads the database password from .env and writes with
 * full privileges. Nothing in this file may ever be imported from web/.
 *
 * Usage:
 *   node scripts/db/import.mjs --dry-run     report what would happen, write nothing
 *   node scripts/db/import.mjs --live        take a snapshot, then write
 *
 * Guarantees:
 *   - Dry run performs the full validation and reports exactly what would be
 *     inserted, skipped, flagged or rejected, and touches nothing.
 *   - A live import takes a rollback snapshot into import_batches.snapshot
 *     before its first write.
 *   - Re-running is idempotent: dedup_key is unique, and a row already present
 *     is skipped rather than inserted again. The key includes direction and an
 *     occurrence number, so a payment and its refund never merge and a genuine
 *     repeat charge is never collapsed.
 *   - Existing confirmed rows are never overwritten. Correcting one is a
 *     separate, audited workflow.
 */

import { readFile } from 'node:fs/promises';
import { connect, q, scalar } from './connect.mjs';

const args = process.argv.slice(2);
const LIVE = args.includes('--live');
const DRY = !LIVE;
const SOURCE_FILE = 'scripts/out/normalised.json';
const CHUNK = 200;

const money = (n) =>
  n === null || n === undefined
    ? '—'
    : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* ----------------------------------------------------------------- loading */

async function loadExtraction() {
  const raw = JSON.parse(await readFile(SOURCE_FILE, 'utf8'));
  const cards = raw.map((c) => {
    const dated = c.transactions.map((t) => t.txn_date).filter(Boolean).sort();
    return {
      name: c.card,
      settlement_currency: 'AED',
      opening_balance: c.opening_balance,
      // Nothing before this date is charged to the card. It is the date of the
      // card's own first transaction, so the historical import counts in full.
      opening_date: dated[0] ?? null,
      source_sheet: c.card,
      source_header_row: c.header_row,
      decreasing_column: c.decreasing_column,
      decreasing_header: String(c.decreasing_header ?? ''),
      increasing_column: c.increasing_column,
      increasing_header: String(c.increasing_header ?? ''),
      balance_formula: c.balance_formula_sample,
      summary: c.summary,
      transactions: c.transactions,
    };
  });
  return cards;
}

/* -------------------------------------------------------------- validation */

/** Rows the database would refuse. Reported, never silently dropped. */
function validate(cards) {
  const rejected = [];
  for (const card of cards) {
    for (const t of card.transactions) {
      const where = `${t.card} row ${t.source_row}`;
      if (t.amount_aed === null || t.amount_aed === undefined) {
        rejected.push({ where, why: 'no AED amount; the ledger cannot hold it' });
        continue;
      }
      if (t.entry_type === 'source_transaction' && !t.direction) {
        rejected.push({ where, why: 'a source transaction with no direction' });
        continue;
      }
      if (t.entry_type === 'reconciliation_adjustment' && t.direction) {
        rejected.push({ where, why: 'an adjustment must carry no direction' });
        continue;
      }
      if (t.direction === 'spend' && t.amount_aed > 0)
        rejected.push({ where, why: `spend with a positive amount ${t.amount_aed}` });
      if (t.direction === 'funding' && t.amount_aed < 0)
        rejected.push({ where, why: `funding with a negative amount ${t.amount_aed}` });
      if (
        t.exchange_rate != null &&
        t.status !== 'needs_review' &&
        (!t.currency || t.original_amount == null)
      )
        rejected.push({ where, why: 'a rate without both currency and original amount' });
    }
  }
  return rejected;
}

/* ------------------------------------------------------------------ report */

function buildReport(cards, existingKeys) {
  const r = {
    cardsTotal: cards.length,
    transactionsTotal: 0,
    toInsert: 0,
    alreadyImported: 0,
    needsReview: 0,
    adjustments: 0,
    excluded: 0,
    repeatCharges: 0,
    datesRepaired: 0,
    perCard: [],
  };

  for (const card of cards) {
    const rows = card.transactions;
    let insert = 0;
    let skip = 0;
    for (const t of rows) {
      if (existingKeys.has(t.dedup_key)) skip++;
      else insert++;
    }
    r.transactionsTotal += rows.length;
    r.toInsert += insert;
    r.alreadyImported += skip;
    r.needsReview += rows.filter((t) => t.status === 'needs_review').length;
    r.adjustments += rows.filter((t) => t.entry_type === 'reconciliation_adjustment').length;
    r.excluded += rows.filter((t) => t.status === 'excluded_from_source_balance').length;
    r.repeatCharges += rows.filter((t) => (t.occurrence ?? 1) > 1).length;
    r.datesRepaired += rows.filter((t) => t.date_repaired).length;
    r.perCard.push({
      name: card.name,
      rows: rows.length,
      insert,
      skip,
      source: card.summary.source_balance,
      ledger: card.summary.ledger_balance,
      diff: card.summary.reconciliation_difference,
      needsReview: card.summary.needs_review,
      excluded: card.summary.excluded,
    });
  }
  return r;
}

function printReport(r, rejected, mode) {
  const line = '='.repeat(86);
  console.log(line);
  console.log(mode === 'dry' ? 'DRY RUN — nothing will be written' : 'LIVE IMPORT');
  console.log(line);

  console.log('\nWHAT WOULD CHANGE');
  console.log('-'.repeat(86));
  console.log(`  cards to create or update       ${r.cardsTotal}`);
  console.log(`  transactions to insert          ${r.toInsert}`);
  console.log(`  already imported, skipped       ${r.alreadyImported}`);
  console.log(`  rejected (would not be written) ${rejected.length}`);
  console.log('');
  console.log(`  of those to insert:`);
  console.log(`    needs_review                  ${r.needsReview}`);
  console.log(`    reconciliation adjustments    ${r.adjustments}`);
  console.log(`    excluded from source balance  ${r.excluded}`);
  console.log(`    repeat charges (occurrence>1) ${r.repeatCharges}`);
  console.log(`    dates repaired on import      ${r.datesRepaired}`);

  console.log('\nPER-CARD BALANCE COMPARISON');
  console.log('-'.repeat(86));
  console.log(
    `  ${'CARD'.padEnd(32)}${'ROWS'.padStart(6)}${'INSERT'.padStart(8)}${'SKIP'.padStart(7)}` +
      `${'SOURCE'.padStart(14)}${'LEDGER'.padStart(14)}${'DIFF'.padStart(12)}`,
  );
  for (const c of r.perCard) {
    console.log(
      `  ${c.name.padEnd(32)}${String(c.rows).padStart(6)}${String(c.insert).padStart(8)}` +
        `${String(c.skip).padStart(7)}${money(c.source).padStart(14)}` +
        `${money(c.ledger).padStart(14)}${money(c.diff).padStart(12)}` +
        (Math.abs(c.diff) > 0.005 ? '  *' : ''),
    );
  }
  const t = r.perCard.reduce(
    (a, c) => ({
      source: a.source + c.source,
      ledger: a.ledger + c.ledger,
      diff: a.diff + c.diff,
    }),
    { source: 0, ledger: 0, diff: 0 },
  );
  console.log('  ' + '-'.repeat(84));
  console.log(
    `  ${'TOTAL (AED)'.padEnd(32)}${''.padStart(21)}${money(t.source).padStart(14)}` +
      `${money(t.ledger).padStart(14)}${money(t.diff).padStart(12)}`,
  );
  console.log('\n  * source and ledger disagree — the difference is imported as a');
  console.log('    visible figure, never reconciled away');

  if (rejected.length) {
    console.log('\nREJECTED');
    console.log('-'.repeat(86));
    for (const x of rejected.slice(0, 20)) console.log(`  ${x.where}: ${x.why}`);
    if (rejected.length > 20) console.log(`  ... and ${rejected.length - 20} more`);
  }
}

/* ------------------------------------------------------------------ writing */

async function upsertCards(client, cards, batchId) {
  const ids = new Map();
  for (const c of cards) {
    // Fill-only: an existing card keeps its stored values. Re-importing must
    // not silently move an opening balance someone has since corrected.
    const row = await q(
      client,
      `insert into cards (name, settlement_currency, opening_balance, opening_date,
                          source_sheet, source_header_row, decreasing_column,
                          decreasing_header, increasing_column, increasing_header,
                          balance_formula)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       on conflict (name) do update set
         opening_date      = coalesce(cards.opening_date, excluded.opening_date),
         source_sheet      = coalesce(cards.source_sheet, excluded.source_sheet),
         balance_formula   = coalesce(cards.balance_formula, excluded.balance_formula),
         updated_at        = now()
       returning id`,
      [
        c.name, c.settlement_currency, c.opening_balance, c.opening_date,
        c.source_sheet, c.source_header_row, c.decreasing_column,
        c.decreasing_header, c.increasing_column, c.increasing_header,
        c.balance_formula,
      ],
    );
    ids.set(c.name, row[0].id);
  }
  void batchId;
  return ids;
}

async function upsertSuppliers(client, cards) {
  const wanted = new Map();
  for (const c of cards)
    for (const t of c.transactions)
      if (t.supplier) wanted.set(`${t.supplier}|${t.supplier_country ?? ''}`, {
        name: t.supplier,
        country: t.supplier_country ?? null,
      });

  const ids = new Map();
  const list = [...wanted.values()];
  for (let i = 0; i < list.length; i += CHUNK) {
    const slice = list.slice(i, i + CHUNK);
    const values = slice
      .map((_, j) => `($${j * 2 + 1},$${j * 2 + 2})`)
      .join(',');
    const params = slice.flatMap((s) => [s.name, s.country]);
    const rows = await q(
      client,
      `insert into suppliers (name, country_code) values ${values}
       on conflict (name, country_code) do update set name = excluded.name
       returning id, name, country_code`,
      params,
    );
    for (const r of rows) ids.set(`${r.name}|${r.country_code ?? ''}`, r.id);
  }
  return ids;
}

const TXN_COLUMNS = [
  'card_id', 'entry_type', 'status', 'review_reason', 'description',
  'txn_date', 'source_date_raw', 'date_repaired', 'date_repair_note',
  'supplier_id', 'supplier_raw', 'amount_aed', 'direction',
  'included_in_source_balance', 'currency', 'original_amount', 'currency_raw',
  'exchange_rate', 'exchange_rate_formula', 'req_number', 'lpo_number',
  'invoice', 'payment_ref', 'account', 'crm', 'client', 'sales_operation',
  'event_end', 'notes', 'batch_id', 'source_sheet', 'source_row',
  'occurrence', 'dedup_key',
];

function txnValues(t, cardId, supplierId, batchId) {
  return [
    cardId, t.entry_type, t.status, t.review_reason ?? null, t.description ?? null,
    t.txn_date ?? null, t.source_date_raw ?? null, Boolean(t.date_repaired),
    t.date_repair_note ?? null, supplierId ?? null, t.supplier_raw ?? null,
    t.amount_aed, t.direction ?? null,
    t.included_in_source_balance !== false,
    t.currency ?? null, t.original_amount ?? null, t.currency_raw ?? null,
    t.exchange_rate ?? null, t.exchange_rate_formula ?? null,
    t.req_number ?? null, t.lpo_number ?? null, t.invoice ?? null,
    t.payment_ref ?? null, t.account ?? null, t.crm ?? null, t.client ?? null,
    t.sales_operation ?? null, t.event_end ?? null, t.notes ?? null,
    batchId, t.source_sheet ?? null, t.source_row ?? null,
    t.occurrence ?? 1, t.dedup_key,
  ];
}

async function insertTransactions(client, cards, cardIds, supplierIds, batchId, existingKeys) {
  const pending = [];
  for (const c of cards)
    for (const t of c.transactions) {
      if (existingKeys.has(t.dedup_key)) continue;
      if (t.amount_aed === null || t.amount_aed === undefined) continue;
      pending.push(
        txnValues(
          t,
          cardIds.get(t.card),
          t.supplier ? supplierIds.get(`${t.supplier}|${t.supplier_country ?? ''}`) : null,
          batchId,
        ),
      );
    }

  let inserted = 0;
  const n = TXN_COLUMNS.length;
  for (let i = 0; i < pending.length; i += CHUNK) {
    const slice = pending.slice(i, i + CHUNK);
    const values = slice
      .map((_, r) => `(${Array.from({ length: n }, (_, c) => `$${r * n + c + 1}`).join(',')})`)
      .join(',');
    // A key already present is left exactly as it is: an existing confirmed row
    // is never overwritten by a re-import.
    const res = await client.query(
      `insert into transactions (${TXN_COLUMNS.join(',')}) values ${values}
       on conflict (dedup_key) do nothing`,
      slice.flat(),
    );
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}

async function insertAnomalies(client, batchId) {
  const raw = await readFile('scripts/out/anomalies.json', 'utf8').catch(() => null);
  if (!raw) return 0;
  const items = JSON.parse(raw);
  let n = 0;
  for (let i = 0; i < items.length; i += CHUNK) {
    const slice = items.slice(i, i + CHUNK);
    const values = slice
      .map((_, j) => `($${j * 5 + 1},$${j * 5 + 2},$${j * 5 + 3},$${j * 5 + 4},$${j * 5 + 5})`)
      .join(',');
    const params = slice.flatMap((a) => [batchId, a.sheet, a.row, a.kind, a.detail]);
    // Anomalies describe the workbook, not the run, so re-importing must not
    // duplicate the review surface. An unresolved anomaly already recorded for
    // the same sheet, row and kind is left alone.
    const res = await client.query(
      `insert into import_anomalies (batch_id, card_name, source_row, kind, detail)
       select v.batch_id::uuid, v.card_name, v.source_row::int, v.kind, v.detail
         from (values ${values}) as v(batch_id, card_name, source_row, kind, detail)
        where not exists (
            select 1 from import_anomalies a
             where a.card_name = v.card_name
               and a.source_row = v.source_row::int
               and a.kind = v.kind
        )`,
      params,
    );
    n += res.rowCount ?? 0;
  }
  return n;
}

/* -------------------------------------------------------------- snapshot */

/**
 * A rollback snapshot of everything this import could touch, taken before the
 * first write. Restoring it returns the database to its pre-import state.
 */
async function takeSnapshot(client) {
  // Sequential, not Promise.all: a single pg client cannot run concurrent
  // queries, and doing so silently serialises them behind a deprecation warning.
  const cards = await q(client, 'select * from cards order by name');
  const transactions = await q(client, 'select * from transactions order by dedup_key');
  const suppliers = await q(client, 'select * from suppliers order by name, country_code');
  return {
    takenAt: new Date().toISOString(),
    counts: {
      cards: cards.length,
      transactions: transactions.length,
      suppliers: suppliers.length,
    },
    cards,
    transactions,
    suppliers,
  };
}

/* ------------------------------------------------------------------- main */

const client = await connect();
try {
  const cards = await loadExtraction();
  const rejected = validate(cards);

  const existingKeys = new Set(
    (await q(client, 'select dedup_key from transactions')).map((r) => r.dedup_key),
  );

  const report = buildReport(cards, existingKeys);
  printReport(report, rejected, DRY ? 'dry' : 'live');

  if (DRY) {
    console.log('\nNOTHING WAS WRITTEN.');
    console.log('Re-run with --live to take a snapshot and import.');
    process.exit(rejected.length ? 1 : 0);
  }

  if (rejected.length) {
    console.log('\nREFUSING TO IMPORT — resolve the rejected rows first.');
    process.exit(1);
  }

  console.log('\nTAKING ROLLBACK SNAPSHOT');
  console.log('-'.repeat(86));
  const snapshot = await takeSnapshot(client);
  console.log(
    `  captured ${snapshot.counts.cards} cards, ` +
      `${snapshot.counts.transactions} transactions, ` +
      `${snapshot.counts.suppliers} suppliers`,
  );

  const batchId = await scalar(
    client,
    `insert into import_batches (source, parser, dry_run, row_count, snapshot)
     values ($1,$2,false,$3,$4) returning id`,
    [
      '2026 Cards Monitoring.xlsx',
      'scripts/extract.py',
      report.transactionsTotal,
      JSON.stringify(snapshot),
    ],
  );
  console.log(`  snapshot stored on import_batches ${batchId}`);

  console.log('\nWRITING');
  console.log('-'.repeat(86));
  await client.query('begin');
  try {
    const cardIds = await upsertCards(client, cards, batchId);
    console.log(`  cards            ${cardIds.size}`);
    const supplierIds = await upsertSuppliers(client, cards);
    console.log(`  suppliers        ${supplierIds.size}`);
    const inserted = await insertTransactions(
      client, cards, cardIds, supplierIds, batchId, existingKeys,
    );
    console.log(`  transactions     ${inserted} inserted, ${report.alreadyImported} skipped`);
    const anomalies = await insertAnomalies(client, batchId);
    console.log(`  anomalies        ${anomalies}`);

    await client.query(
      `update import_batches
          set inserted_count = $1, skipped_count = $2, anomaly_count = $3
        where id = $4`,
      [inserted, report.alreadyImported, anomalies, batchId],
    );
    await client.query('commit');
    console.log('\nCOMMITTED.');
  } catch (e) {
    await client.query('rollback');
    console.error('\nROLLED BACK —', e.message);
    process.exit(1);
  }
} finally {
  await client.end();
}
