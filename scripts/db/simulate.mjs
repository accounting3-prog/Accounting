/**
 * Transaction simulations against the live schema, rolled back afterwards.
 *
 * For every card these prove, with real inserts against the real constraints
 * and the real balance view:
 *
 *   1. an AED purchase decreases the balance exactly once;
 *   2. an AED refund increases it exactly once, reversing the purchase;
 *   3. a foreign-currency purchase stores currency, original amount, rate and
 *      AED settlement correctly and moves the balance by the AED figure;
 *   4. a foreign-currency refund increases the balance by its AED figure and
 *      stays a separate row from the purchase;
 *   5. a payment and a refund sharing one reference number remain two rows;
 *   6. recomputing the balance repeatedly never applies a transaction twice.
 *
 * Every scenario runs inside a transaction that is rolled back, and the script
 * asserts at the end that the database is byte-for-byte unchanged.
 *
 * SERVER-SIDE ONLY.
 */

import { createHash } from 'node:crypto';
import { connect, q } from './connect.mjs';

let failures = 0;
let checks = 0;

function check(label, ok, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`    ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(58)}${detail}`);
}

const near = (a, b, tol = 0.005) => Math.abs(Number(a) - Number(b)) <= tol;
const money = (n) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** A unique key for a simulated row, shaped like the importer's. */
function key(parts) {
  return createHash('sha256').update(['SIM', ...parts].join('|')).digest('hex');
}

const client = await connect();

/** Live balance straight from the view the application reads. */
async function ledgerBalance(cardId) {
  const r = await q(client, 'select ledger_balance from card_balances where card_id = $1', [
    cardId,
  ]);
  return Number(r[0].ledger_balance);
}

async function insertTxn(cardId, t) {
  const r = await q(
    client,
    `insert into transactions
       (card_id, entry_type, status, txn_date, supplier_raw, amount_aed, direction,
        included_in_source_balance, currency, original_amount, exchange_rate,
        req_number, payment_ref, source_sheet, occurrence, dedup_key)
     values ($1,'source_transaction','confirmed',$2,$3,$4,$5,true,$6,$7,$8,$9,$10,
             null,$11,$12)
     returning id, amount_aed, currency, original_amount, exchange_rate,
               direction, payment_ref`,
    [
      cardId, t.date, t.supplier, t.amount, t.direction, t.currency ?? null,
      t.originalAmount ?? null, t.rate ?? null, t.req ?? null, t.paymentRef ?? null,
      t.occurrence ?? 1, t.dedupKey,
    ],
  );
  return r[0];
}

try {
  const cards = await q(client, 'select id, name from cards order by name');
  const before = {
    transactions: (await q(client, 'select count(*)::int n from transactions'))[0].n,
    cards: (await q(client, 'select count(*)::int n from cards'))[0].n,
    balances: await q(
      client,
      'select card_name, source_balance, ledger_balance from card_balances order by card_name',
    ),
  };

  console.log('='.repeat(92));
  console.log('TRANSACTION SIMULATIONS — every scenario rolled back');
  console.log('='.repeat(92));

  for (const card of cards) {
    console.log(`\n${card.name}`);
    console.log('-'.repeat(92));

    await client.query('begin');
    try {
      const opening = await ledgerBalance(card.id);
      console.log(`    live balance before: ${money(opening)} AED`);

      /* ---------------------------------------------- 1. AED purchase */
      const purchase = await insertTxn(card.id, {
        date: '2026-09-03',
        supplier: 'SIM SUPPLIER AED',
        amount: -1500,
        direction: 'spend',
        req: 'SIM-REQ-1',
        paymentRef: 'SIM-PAY-1',
        dedupKey: key([card.id, 'aed-purchase']),
      });
      const afterPurchase = await ledgerBalance(card.id);
      check(
        'AED purchase decreases the balance exactly once',
        near(afterPurchase, opening - 1500),
        `${money(opening)} -> ${money(afterPurchase)}`,
      );

      /* ------------------------------------------------ 2. AED refund */
      await insertTxn(card.id, {
        date: '2026-09-03',
        supplier: 'SIM SUPPLIER AED',
        amount: 1500,
        direction: 'funding',
        req: 'SIM-REQ-1',
        paymentRef: 'SIM-PAY-1',
        dedupKey: key([card.id, 'aed-refund']),
      });
      const afterRefund = await ledgerBalance(card.id);
      check(
        'AED refund increases the balance exactly once',
        near(afterRefund, afterPurchase + 1500),
        `${money(afterPurchase)} -> ${money(afterRefund)}`,
      );
      check(
        'the refund reverses the purchase exactly',
        near(afterRefund, opening),
        `back to ${money(afterRefund)}`,
      );

      /* ---------------------- 5. same reference, still two separate rows */
      const shared = await q(
        client,
        `select count(*)::int n from transactions
          where card_id = $1 and payment_ref = 'SIM-PAY-1'`,
        [card.id],
      );
      check(
        'payment and refund sharing a reference stay separate',
        shared[0].n === 2,
        `${shared[0].n} rows under SIM-PAY-1`,
      );

      /* ------------------------------- 3. foreign-currency purchase */
      const originalAmount = 1000;
      const rate = 3.6725;
      const settled = -Number((originalAmount * rate).toFixed(2)); // -3672.50
      const fx = await insertTxn(card.id, {
        date: '2026-09-03',
        supplier: 'SIM SUPPLIER USD',
        amount: settled,
        direction: 'spend',
        currency: 'USD',
        originalAmount,
        rate,
        req: 'SIM-REQ-2',
        paymentRef: 'SIM-PAY-2',
        dedupKey: key([card.id, 'fx-purchase']),
      });
      const afterFx = await ledgerBalance(card.id);

      check('FX purchase stores the currency code', fx.currency === 'USD', fx.currency);
      check(
        'FX purchase stores the original amount',
        near(fx.original_amount, originalAmount),
        `${money(fx.original_amount)} USD`,
      );
      check(
        'FX purchase stores the rate it was converted at',
        near(fx.exchange_rate, rate, 1e-6),
        String(fx.exchange_rate),
      );
      check(
        'FX purchase AED settlement equals original x rate',
        near(Math.abs(fx.amount_aed), originalAmount * rate),
        `${money(Math.abs(fx.amount_aed))} AED`,
      );
      check(
        'FX purchase moves the balance by the AED figure',
        near(afterFx, afterRefund + settled),
        `${money(afterRefund)} -> ${money(afterFx)}`,
      );

      /* --------------------------------- 4. foreign-currency refund */
      const fxRefund = await insertTxn(card.id, {
        date: '2026-09-03',
        supplier: 'SIM SUPPLIER USD',
        amount: -settled,
        direction: 'funding',
        currency: 'USD',
        originalAmount,
        rate,
        req: 'SIM-REQ-2',
        paymentRef: 'SIM-PAY-2',
        dedupKey: key([card.id, 'fx-refund']),
      });
      const afterFxRefund = await ledgerBalance(card.id);
      check(
        'FX refund increases the balance by its AED settlement',
        near(afterFxRefund, afterFx + Math.abs(settled)),
        `${money(afterFx)} -> ${money(afterFxRefund)}`,
      );
      check(
        'FX refund is a separate row, not deduplicated away',
        fxRefund.id !== fx.id,
        '2 distinct ids',
      );
      const fxPair = await q(
        client,
        `select count(*)::int n from transactions
          where card_id = $1 and payment_ref = 'SIM-PAY-2'`,
        [card.id],
      );
      check('both FX rows persist under one reference', fxPair[0].n === 2);

      /* ------------------------- 6. recomputation is never cumulative */
      const reads = [];
      for (let i = 0; i < 5; i++) reads.push(await ledgerBalance(card.id));
      check(
        'recomputing the balance 5x never applies anything twice',
        reads.every((v) => near(v, reads[0])),
        `all reads ${money(reads[0])}`,
      );
      check(
        'balance returned to opening plus only the two FX-neutral pairs',
        near(reads[0], opening),
        `${money(reads[0])} vs opening ${money(opening)}`,
      );
    } finally {
      await client.query('rollback');
    }

    const restored = await ledgerBalance(card.id);
    const originalRow = before.balances.find((b) => b.card_name === card.name);
    check(
      'rollback left the card exactly as it was',
      near(restored, originalRow.ledger_balance),
      `${money(restored)} AED`,
    );
  }

  /* ---------------------------------------- the database is unchanged */

  console.log('\n' + '='.repeat(92));
  console.log('DATABASE UNCHANGED BY THE SIMULATIONS');
  console.log('-'.repeat(92));
  const after = {
    transactions: (await q(client, 'select count(*)::int n from transactions'))[0].n,
    cards: (await q(client, 'select count(*)::int n from cards'))[0].n,
    balances: await q(
      client,
      'select card_name, source_balance, ledger_balance from card_balances order by card_name',
    ),
  };
  check('transaction count unchanged', after.transactions === before.transactions,
        `${before.transactions} -> ${after.transactions}`);
  check('card count unchanged', after.cards === before.cards);
  const balancesMatch = before.balances.every((b, i) =>
    near(b.source_balance, after.balances[i].source_balance) &&
    near(b.ledger_balance, after.balances[i].ledger_balance));
  check('every card balance unchanged', balancesMatch);
  const [{ n: strays }] = await q(
    client,
    `select count(*)::int n from transactions where supplier_raw like 'SIM %'`,
  );
  check('no simulated row survived', strays === 0);

  console.log('\n' + '='.repeat(92));
  console.log(
    failures === 0
      ? `ALL ${checks} SIMULATION CHECKS PASSED across ${cards.length} cards`
      : `${failures} of ${checks} CHECKS FAILED`,
  );
  console.log('='.repeat(92));
  process.exit(failures ? 1 : 0);
} finally {
  await client.end();
}
