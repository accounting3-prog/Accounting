/**
 * Regenerates the frontend's sample extract from the live database.
 *
 * The sample is what a signed-out visitor sees. It was previously generated
 * from the extraction output, which froze it at the moment of import — so once
 * review items were resolved in the live ledger, the demo went on showing a
 * state that no longer existed. Generating it from the database instead keeps
 * the two honest with each other.
 *
 * It is still clearly labelled as a sample in the UI. This only makes sure the
 * figures in it are the current ones rather than a stale snapshot.
 *
 * SERVER-SIDE ONLY. Read-only.
 */

import { writeFile } from 'node:fs/promises';
import { connect, q } from './connect.mjs';

const OUT = 'web/src/data/ledger-sample.json';

const num = (v) => (v === null || v === undefined ? null : Number(v));

/**
 * A Postgres `date` comes back from pg as a JavaScript Date at local midnight,
 * and `String(date)` gives "Wed Sep 02 2026 ..." — so slicing ten characters
 * off it yields "Wed Sep 02", not a date at all. Formatted from the local
 * calendar parts rather than toISOString(), which would shift the day for
 * anyone west of UTC.
 */
const iso = (v) => {
  if (!v) return undefined;
  if (v instanceof Date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v).slice(0, 10);
};

const client = await connect();
try {
  const cardRows = await q(
    client,
    `select c.*, b.source_balance, b.ledger_balance, b.reconciliation_difference,
            b.total_spend, b.total_funding, b.review_adjustments_total,
            b.needs_review_count, b.excluded_count, b.transaction_count,
            b.first_transaction, b.last_transaction
       from cards c join card_balances b on b.card_id = c.id
      order by c.name`,
  );

  const cards = cardRows.map((c) => ({
    id: c.id,
    name: c.name,
    settlementCurrency: c.settlement_currency,
    openingBalance: num(c.opening_balance),
    openingDate: iso(c.opening_date) ?? null,
    lastTransaction: iso(c.last_transaction) ?? null,
    sourceBalance: num(c.source_balance),
    ledgerBalance: num(c.ledger_balance),
    reconciliationDifference: num(c.reconciliation_difference),
    totalSpend: num(c.total_spend),
    totalFunding: num(c.total_funding),
    reviewAdjustmentsTotal: num(c.review_adjustments_total),
    needsReview: Number(c.needs_review_count),
    excluded: Number(c.excluded_count),
    transactionCount: Number(c.transaction_count),
    sourceHeaderRow: c.source_header_row ?? 1,
    decreasingColumn: c.decreasing_column ?? '',
    decreasingHeader: c.decreasing_header ?? '',
    increasingColumn: c.increasing_column ?? '',
    increasingHeader: c.increasing_header ?? '',
    balanceFormula: c.balance_formula ?? '',
    headerIsMisleading: /credit/i.test(c.decreasing_header ?? ''),
    verifiedRows: Number(c.transaction_count),
  }));

  const txnRows = await q(
    client,
    `select * from transactions order by txn_date desc nulls last, dedup_key`,
  );

  // Empty fields are dropped: the file ships in the browser bundle, and a
  // hundred thousand nulls is a hundred thousand bytes for nothing.
  const put = (o, k, v) => {
    if (v !== null && v !== undefined && v !== '' && v !== false) o[k] = v;
  };

  const transactions = txnRows.map((t) => {
    const raw = t.supplier_raw ?? '';
    const o = { id: t.id, cardId: t.card_id, amount_aed: num(t.amount_aed) };
    put(o, 'entry_type', t.entry_type);
    put(o, 'status', t.status);
    put(o, 'review_reason', t.review_reason);
    put(o, 'rate_review_note', t.rate_review_note);
    put(o, 'description', t.description);
    put(o, 'source_sheet', t.source_sheet);
    put(o, 'source_row', t.source_row);
    put(o, 'txn_date', iso(t.txn_date));
    put(o, 'source_date_raw', t.source_date_raw);
    put(o, 'date_repaired', t.date_repaired);
    put(o, 'date_repair_note', t.date_repair_note);
    put(o, 'supplier', raw.replace(/\s\d{3}\s*$/, '') || undefined);
    put(o, 'supplier_raw', t.supplier_raw);
    put(o, 'supplier_country', raw.match(/\s(\d{3})\s*$/)?.[1]);
    put(o, 'direction', t.direction);
    o.included_in_source_balance = t.included_in_source_balance;
    put(o, 'currency', t.currency);
    put(o, 'original_amount', num(t.original_amount));
    put(o, 'currency_raw', t.currency_raw);
    put(o, 'exchange_rate', num(t.exchange_rate));
    put(o, 'normalized_exchange_rate', num(t.normalized_exchange_rate));
    put(o, 'exchange_rate_formula', t.exchange_rate_formula);
    put(o, 'occurrence', t.occurrence);
    for (const k of ['req_number','lpo_number','invoice','payment_ref','account',
                     'crm','client','sales_operation','event_end','notes'])
      put(o, k, t[k]);
    return o;
  });

  const spendRows = await q(
    client,
    `select card_id, currency, transaction_count, total_original_amount, total_settled_aed
       from card_spend_by_currency order by transaction_count desc`,
  );
  const spendByCurrency = spendRows.map((s) => ({
    cardId: s.card_id,
    currency: s.currency,
    count: Number(s.transaction_count),
    originalTotal: num(s.total_original_amount) ?? 0,
    aedTotal: num(s.total_settled_aed) ?? 0,
  }));

  const payload = {
    generatedFrom: 'Supabase, ' + new Date().toISOString().slice(0, 10),
    cards,
    transactions,
    spendByCurrency,
  };
  await writeFile(OUT, JSON.stringify(payload), 'utf8');

  // Every date must be a plain ISO day. A mangled one is silent in JSON and
  // only shows up as nonsense on screen, so it is caught here.
  const isoDay = /^\d{4}-\d{2}-\d{2}$/;
  const badDates = [
    ...cards.flatMap((c) =>
      [c.openingDate, c.lastTransaction].filter((d) => d && !isoDay.test(d)),
    ),
    ...transactions.map((t) => t.txn_date).filter((d) => d && !isoDay.test(d)),
  ];
  if (badDates.length)
    throw new Error(
      `${badDates.length} dates are not ISO days, e.g. ${JSON.stringify(badDates[0])}`,
    );

  const size = Buffer.byteLength(JSON.stringify(payload)) / 1024;
  console.log(`${OUT}`);
  console.log(
    `  ${cards.length} cards, ${transactions.length} transactions, ` +
      `${spendByCurrency.length} card/currency pairs, ${size.toFixed(0)} KB`,
  );
  const flagged = transactions.filter(
    (t) => t.status === 'needs_review' || t.status === 'excluded_from_source_balance',
  );
  console.log(`  still flagged in the sample: ${flagged.length}`);
  for (const c of cards)
    console.log(
      `  ${c.name.padEnd(32)} source ${String(c.sourceBalance).padStart(11)}  ` +
        `live ${String(c.ledgerBalance).padStart(11)}  review ${c.needsReview + c.excluded}`,
    );
} finally {
  await client.end();
}
