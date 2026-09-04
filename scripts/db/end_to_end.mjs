/**
 * End-to-end exercise of the whole system, through the paths the UI actually
 * uses.
 *
 * Everything here calls create_card / create_transaction / resolve_review_item
 * as a signed-in admin — not raw INSERTs — so what is proven is the behaviour
 * that ships, including every constraint and every validation the functions
 * apply. Each scenario runs inside a transaction that is rolled back, and the
 * script asserts at the end that the database is untouched.
 *
 * SERVER-SIDE ONLY. Read-only in effect.
 */

import { connect, q } from './connect.mjs';

const OWNER = 'accounting3@events-explorers.com';

let pass = 0;
let fail = 0;
const failures = [];

function check(label, ok, detail = '') {
  if (ok) pass++;
  else {
    fail++;
    failures.push(label + (detail ? ` — ${detail}` : ''));
  }
  console.log(`    ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(56)}${detail}`);
}

const near = (a, b, tol = 0.005) => Math.abs(Number(a) - Number(b)) <= tol;
const money = (n) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const client = await connect();
let uid;

/** Run a body as the signed-in admin, then roll everything back. */
async function scenario(fn) {
  await client.query('begin');
  try {
    await client.query('set local role authenticated');
    await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid]);
    return await fn();
  } finally {
    await client.query('rollback').catch(() => {});
  }
}

async function balance(cardId) {
  const r = await client.query(
    'select ledger_balance from card_balances where card_id = $1',
    [cardId],
  );
  return Number(r.rows[0].ledger_balance);
}

/** Call create_transaction the way the form does. */
async function addTxn(cardId, opts) {
  const r = await client.query(
    `select create_transaction(
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) as id`,
    [
      cardId,
      opts.date ?? '2026-09-04',
      opts.kind,
      opts.amount,
      opts.supplier ?? 'E2E SUPPLIER',
      opts.req ?? 'E2E-REQ-1',
      opts.paymentRef ?? 'E2E-PAY-1',
      opts.currency ?? null,
      opts.originalAmount ?? null,
      opts.rate ?? null,
      opts.country ?? null,
      null, null, null, null, null, null, null,
      opts.needsReview ?? false,
    ],
  );
  return r.rows[0].id;
}

async function expectRefused(label, fn) {
  try {
    await fn();
    check(label, false, 'it was ACCEPTED');
  } catch (e) {
    check(label, true, e.message.split('\n')[0].slice(0, 58));
  }
}

try {
  const admin = await q(client, 'select user_id from admins where email = $1', [OWNER]);
  if (!admin.length) throw new Error(`${OWNER} is not an admin`);
  uid = admin[0].user_id;

  const cards = await q(client, 'select id, name from cards order by name');
  const snapshot = {
    transactions: (await q(client, 'select count(*)::int n from transactions'))[0].n,
    cards: (await q(client, 'select count(*)::int n from cards'))[0].n,
    balances: await q(
      client,
      'select card_name, source_balance, ledger_balance from card_balances order by card_name',
    ),
  };

  console.log('='.repeat(94));
  console.log('END-TO-END TEST — every scenario through the real write path, then rolled back');
  console.log('='.repeat(94));

  /* ================================================== 1. every card, every kind */

  console.log('\n1. EACH TRANSACTION TYPE, ON EVERY EXISTING CARD');
  console.log('-'.repeat(94));

  for (const card of cards) {
    console.log(`\n  ${card.name}`);
    await scenario(async () => {
      const start = await balance(card.id);
      console.log(`    balance before: ${money(start)} AED`);

      await addTxn(card.id, { kind: 'purchase', amount: 2500, paymentRef: 'E2E-P1' });
      const afterPurchase = await balance(card.id);
      check(
        'purchase DECREASES the balance, exactly once',
        near(afterPurchase, start - 2500),
        `${money(start)} -> ${money(afterPurchase)}`,
      );

      await addTxn(card.id, { kind: 'refund', amount: 2500, paymentRef: 'E2E-P1' });
      const afterRefund = await balance(card.id);
      check(
        'refund INCREASES the balance, exactly once',
        near(afterRefund, afterPurchase + 2500),
        `${money(afterPurchase)} -> ${money(afterRefund)}`,
      );
      check('refund reverses the purchase exactly', near(afterRefund, start));

      const pair = await client.query(
        `select count(*)::int n from transactions
          where card_id = $1 and payment_ref = 'E2E-P1'`,
        [card.id],
      );
      check(
        'payment and refund on one reference stay separate',
        pair.rows[0].n === 2,
        `${pair.rows[0].n} rows`,
      );

      await addTxn(card.id, { kind: 'funding', amount: 10000, paymentRef: 'E2E-F1' });
      const afterFunding = await balance(card.id);
      check(
        'funding INCREASES the balance',
        near(afterFunding, afterRefund + 10000),
        `${money(afterRefund)} -> ${money(afterFunding)}`,
      );

      await addTxn(card.id, { kind: 'fee', amount: 75, paymentRef: 'E2E-FEE' });
      const afterFee = await balance(card.id);
      check(
        'fee DECREASES the balance',
        near(afterFee, afterFunding - 75),
        `${money(afterFunding)} -> ${money(afterFee)}`,
      );
    });
  }

  /* ============================================ 2. foreign currency, on every card */

  console.log('\n\n2. FOREIGN CURRENCY, ON EVERY EXISTING CARD');
  console.log('-'.repeat(94));

  for (const card of cards) {
    await scenario(async () => {
      const start = await balance(card.id);
      const original = 1200;
      const rate = 4.2035;
      const settled = Number((original * rate).toFixed(2)); // 5044.20

      const id = await addTxn(card.id, {
        kind: 'purchase',
        amount: settled,
        currency: 'EUR',
        originalAmount: original,
        rate,
        paymentRef: 'E2E-FX',
      });
      const row = (
        await client.query(
          `select currency, original_amount, exchange_rate, normalized_exchange_rate,
                  amount_aed, direction from transactions where id = $1`,
          [id],
        )
      ).rows[0];
      const afterFx = await balance(card.id);

      const ok =
        row.currency === 'EUR' &&
        near(row.original_amount, original) &&
        near(row.exchange_rate, rate, 1e-6) &&
        near(Math.abs(row.amount_aed), settled) &&
        near(afterFx, start - settled);
      check(
        `${card.name.slice(0, 26).padEnd(26)} FX purchase stores and deducts correctly`,
        ok,
        `${original} EUR @ ${rate} = ${money(settled)} AED`,
      );

      await addTxn(card.id, {
        kind: 'refund',
        amount: settled,
        currency: 'EUR',
        originalAmount: original,
        rate,
        paymentRef: 'E2E-FX',
      });
      const afterFxRefund = await balance(card.id);
      check(
        `${card.name.slice(0, 26).padEnd(26)} FX refund adds the AED back`,
        near(afterFxRefund, start),
        `${money(afterFx)} -> ${money(afterFxRefund)}`,
      );
    });
  }

  /* ================================================== 3. a brand-new card */

  console.log('\n\n3. A BRAND-NEW CARD, CREATED AND USED');
  console.log('-'.repeat(94));

  await scenario(async () => {
    const newId = (
      await client.query(
        `select create_card('E2E TEST CARD 9999', 50000, '2026-06-01',
                            'Credit card', 'active', 'AED', 'Test Bank',
                            '9999', 100000, 'created by the end-to-end test') as id`,
      )
    ).rows[0].id;
    check('a new card is created through create_card', Boolean(newId));

    const created = (
      await client.query(
        `select name, opening_balance, opening_date, card_type, status,
                bank_issuer, account_reference, credit_limit, created_by
           from cards where id = $1`,
        [newId],
      )
    ).rows[0];
    check('opening balance stored', near(created.opening_balance, 50000));
    check('opening date stored', String(created.opening_date).startsWith('2026-06-01') ||
          created.opening_date instanceof Date);
    check('card type stored', created.card_type === 'Credit card');
    check('status stored', created.status === 'active');
    check('creator recorded', created.created_by === uid);

    const auditRow = (
      await client.query(
        `select action, performed_by_email, detail from card_audit where card_id = $1`,
        [newId],
      )
    ).rows[0];
    check('an immutable audit row was written', auditRow?.action === 'created',
          auditRow?.performed_by_email ?? '');

    let bal = await balance(newId);
    check('new card starts at its opening balance', near(bal, 50000), `${money(bal)} AED`);

    await addTxn(newId, { kind: 'purchase', amount: 12000, date: '2026-07-15', paymentRef: 'NC-1' });
    bal = await balance(newId);
    check('purchase on the new card decreases it', near(bal, 38000), `${money(bal)} AED`);

    await addTxn(newId, { kind: 'refund', amount: 12000, date: '2026-07-16', paymentRef: 'NC-1' });
    bal = await balance(newId);
    check('refund on the new card increases it', near(bal, 50000), `${money(bal)} AED`);

    await addTxn(newId, { kind: 'funding', amount: 25000, date: '2026-08-01', paymentRef: 'NC-2' });
    bal = await balance(newId);
    check('funding on the new card increases it', near(bal, 75000), `${money(bal)} AED`);

    // The whole point of an opening date.
    await addTxn(newId, {
      kind: 'purchase', amount: 99999, date: '2026-01-15', paymentRef: 'NC-OLD',
    });
    const afterOld = await balance(newId);
    check(
      'a transaction BEFORE the opening date does not move the balance',
      near(afterOld, 75000),
      `still ${money(afterOld)} AED`,
    );
    const oldRow = await client.query(
      `select count(*)::int n from transactions where card_id = $1 and txn_date < '2026-06-01'`,
      [newId],
    );
    check('...but it is still stored and searchable', oldRow.rows[0].n === 1);

    // FX on a fresh card
    await addTxn(newId, {
      kind: 'purchase', amount: 3672.5, currency: 'USD', originalAmount: 1000,
      rate: 3.6725, date: '2026-08-10', paymentRef: 'NC-FX',
    });
    bal = await balance(newId);
    check('FX purchase on the new card', near(bal, 75000 - 3672.5), `${money(bal)} AED`);

    // Two identical submissions moments apart are the same submission arriving
    // twice — a double-clicked button, a retry, a refresh mid-save. For a
    // ledger, creating a second row there counts the same money twice.
    await addTxn(newId, { kind: 'purchase', amount: 500, date: '2026-08-20', paymentRef: 'NC-DUP', req: 'NC-R' });
    await addTxn(newId, { kind: 'purchase', amount: 500, date: '2026-08-20', paymentRef: 'NC-DUP', req: 'NC-R' });
    const accidental = await client.query(
      `select count(*)::int n from transactions
        where card_id = $1 and payment_ref = 'NC-DUP'`,
      [newId],
    );
    check(
      'a resubmitted form does NOT create a second transaction',
      accidental.rows[0].n === 1,
      `${accidental.rows[0].n} row`,
    );
    bal = await balance(newId);
    check('the amount is counted once, not twice', near(bal, 75000 - 3672.5 - 500),
          `${money(bal)} AED`);

    // A genuine repeat charge is still possible: the person entering it says so.
    await client.query(
      `select create_transaction($1,'2026-08-20','purchase',500,'E2E SUPPLIER','NC-R','NC-DUP',
         null,null,null,null,null,null,null,null,null,null,null,false,true)`,
      [newId],
    );
    const deliberate = await client.query(
      `select count(*)::int n, max(occurrence) as maxocc from transactions
        where card_id = $1 and payment_ref = 'NC-DUP'`,
      [newId],
    );
    check(
      'a deliberate repeat charge IS kept as its own row',
      deliberate.rows[0].n === 2 && Number(deliberate.rows[0].maxocc) === 2,
      `${deliberate.rows[0].n} rows, occurrence up to ${deliberate.rows[0].maxocc}`,
    );
    bal = await balance(newId);
    check('the deliberate repeat also hits the balance', near(bal, 75000 - 3672.5 - 1000),
          `${money(bal)} AED`);

    // Reading repeatedly must not drift
    const reads = [];
    for (let i = 0; i < 5; i++) reads.push(await balance(newId));
    check('reading the balance 5x never drifts', reads.every((v) => near(v, reads[0])),
          `all ${money(reads[0])}`);
  });

  /* ================================================== 4. what must be refused */

  console.log('\n\n4. WHAT THE SYSTEM MUST REFUSE');
  console.log('-'.repeat(94));

  const anyCard = cards[0].id;

  await scenario(() =>
    expectRefused('a negative amount', () =>
      addTxn(anyCard, { kind: 'purchase', amount: -100 })));
  await scenario(() =>
    expectRefused('a zero amount', () =>
      addTxn(anyCard, { kind: 'purchase', amount: 0 })));
  await scenario(() =>
    expectRefused('a missing supplier', () =>
      addTxn(anyCard, { kind: 'purchase', amount: 100, supplier: '  ' })));
  await scenario(() =>
    expectRefused('a missing request number', () =>
      addTxn(anyCard, { kind: 'purchase', amount: 100, req: '' })));
  await scenario(() =>
    expectRefused('a missing payment reference', () =>
      addTxn(anyCard, { kind: 'purchase', amount: 100, paymentRef: '' })));
  await scenario(() =>
    expectRefused('a currency with no original amount', () =>
      addTxn(anyCard, { kind: 'purchase', amount: 100, currency: 'EUR', rate: 4 })));
  await scenario(() =>
    expectRefused('a currency with no rate', () =>
      addTxn(anyCard, { kind: 'purchase', amount: 100, currency: 'EUR', originalAmount: 25 })));
  await scenario(() =>
    expectRefused('an unrecognised currency', () =>
      addTxn(anyCard, { kind: 'purchase', amount: 100, currency: 'XYZ',
                        originalAmount: 25, rate: 4 })));
  await scenario(() =>
    expectRefused('an unknown transaction type', () =>
      addTxn(anyCard, { kind: 'nonsense', amount: 100 })));
  await scenario(() =>
    expectRefused('a duplicate card name', () =>
      client.query(
        `select create_card('AMEX 4000 VPAY', 0, '2026-01-01', 'Credit card')`)));
  await scenario(() =>
    expectRefused('a card with no opening date', () =>
      client.query(`select create_card('E2E NO DATE', 0, null, 'Credit card')`)));
  await scenario(() =>
    expectRefused('a full card number as the reference', () =>
      client.query(
        `select create_card('E2E LONG REF', 0, '2026-01-01', 'Credit card',
                            'active', 'AED', null, '4111111111111111')`)));

  // An incomplete conversion IS allowed, but only when explicitly flagged.
  await scenario(async () => {
    const id = await addTxn(anyCard, {
      kind: 'purchase', amount: 500, currency: 'EUR', needsReview: true,
    });
    const row = (
      await client.query('select status from transactions where id = $1', [id])
    ).rows[0];
    check(
      'an incomplete conversion IS allowed when flagged for review',
      row.status === 'needs_review',
      row.status,
    );
  });

  /* ================================================== 5. non-admin */

  console.log('\n\n5. A SIGNED-IN NON-ADMIN');
  console.log('-'.repeat(94));

  await client.query('begin');
  try {
    const stranger = (await q(client, 'select gen_random_uuid() as id'))[0].id;
    await client.query('set local role authenticated');
    await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [stranger]);

    const readable = await client.query('select count(*)::int n from transactions');
    check('can read the whole ledger', readable.rows[0].n === snapshot.transactions,
          `${readable.rows[0].n} rows`);

    // Each case carries its own parameters. Passing a spare or untyped one
    // makes Postgres fail on the binding before it ever reaches the function,
    // which looks like a refusal but proves nothing about access control.
    const attempts = [
      {
        label: 'cannot add a transaction',
        sql: `select create_transaction($1,'2026-09-04','purchase',1,'S','R','P')`,
        params: [anyCard],
      },
      {
        label: 'cannot add a card',
        sql: `select create_card('E2E STRANGER', 0, '2026-01-01', 'Credit card')`,
        params: [],
      },
      {
        label: 'cannot resolve a review item',
        sql: `select resolve_review_item(
                (select id from transactions limit 1), 'void', 'trying it on')`,
        params: [],
      },
      {
        label: 'cannot grant itself access',
        sql: `select grant_admin($1::text, 'trying it on')`,
        params: [OWNER],
      },
      {
        label: 'cannot list the accounts',
        sql: `select * from list_app_users()`,
        params: [],
      },
    ];

    for (const a of attempts) {
      await client.query('savepoint p');
      try {
        await client.query(a.sql, a.params.length ? a.params : undefined);
        check(a.label, false, 'it was ALLOWED');
      } catch (e) {
        check(a.label, e.code === '42501', e.code ?? '');
      }
      await client.query('rollback to savepoint p');
    }
  } finally {
    await client.query('rollback').catch(() => {});
  }

  /* ================================================== 6. nothing was left behind */

  console.log('\n\n6. THE DATABASE IS UNCHANGED');
  console.log('-'.repeat(94));

  const after = {
    transactions: (await q(client, 'select count(*)::int n from transactions'))[0].n,
    cards: (await q(client, 'select count(*)::int n from cards'))[0].n,
    balances: await q(
      client,
      'select card_name, source_balance, ledger_balance from card_balances order by card_name',
    ),
  };
  check('transaction count unchanged', after.transactions === snapshot.transactions,
        `${snapshot.transactions} -> ${after.transactions}`);
  check('card count unchanged', after.cards === snapshot.cards,
        `${snapshot.cards} -> ${after.cards}`);
  check(
    'every balance unchanged',
    snapshot.balances.every(
      (b, i) =>
        near(b.source_balance, after.balances[i].source_balance) &&
        near(b.ledger_balance, after.balances[i].ledger_balance),
    ),
  );
  const strays = await q(
    client,
    `select count(*)::int n from cards where name like 'E2E%'
      union all select count(*)::int from transactions where supplier_raw like 'E2E%'`,
  );
  check('no test row survived', strays.every((r) => r.n === 0));

  console.log('\n' + '='.repeat(94));
  console.log(
    fail === 0
      ? `ALL ${pass} CHECKS PASSED`
      : `${fail} of ${pass + fail} CHECKS FAILED`,
  );
  for (const f of failures) console.log('  FAILED: ' + f);
  console.log('='.repeat(94));
  process.exit(fail ? 1 : 0);
} finally {
  await client.end();
}
