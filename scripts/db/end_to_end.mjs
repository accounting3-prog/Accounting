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
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) as id`,
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
      opts.allowDuplicate ?? false,
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

  // balance_sign comes along because a purchase does not move every card's
  // balance the same way: six sheets write an available balance, RAK 9825
  // writes what has been drawn. The assertions below use each card's own rule
  // rather than assuming one of them.
  const cards = await q(client,
    'select id, name, balance_sign::int as sign from cards order by name');
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

      // How this card's own statement moves. On six cards a purchase lowers
      // the balance; on RAK 9825 it raises it, because that balance counts
      // what has been drawn. The direction stored is 'spend' either way, and
      // that is checked separately below.
      const sign = card.sign;
      const spendWord = sign === 1 ? 'DECREASES' : 'INCREASES';
      const inWord = sign === 1 ? 'INCREASES' : 'DECREASES';

      const purchaseId = await addTxn(card.id, {
        kind: 'purchase', amount: 2500, date: '2026-09-04', paymentRef: 'E2E-P1',
      });
      const afterPurchase = await balance(card.id);
      check(
        `purchase ${spendWord} the balance, exactly once`,
        near(afterPurchase, start + sign * -2500),
        `${money(start)} -> ${money(afterPurchase)}`,
      );
      check(
        'and it is recorded as spending whichever way the balance moved',
        (await client.query('select direction, amount_aed from transactions where id = $1',
                            [purchaseId])).rows[0].direction === 'spend',
      );

      // The date is what every report, filter and export sorts and groups by.
      // A transaction stored under the wrong day is invisible to the month it
      // belongs to.
      const stored = (
        await client.query(
          `select to_char(txn_date, 'YYYY-MM-DD') as d, created_at, updated_at
             from transactions where id = $1`,
          [purchaseId],
        )
      ).rows[0];
      check('the date is stored exactly as entered', stored.d === '2026-09-04', stored.d);
      check('created_at is set', Boolean(stored.created_at));

      await addTxn(card.id, { kind: 'refund', amount: 2500, paymentRef: 'E2E-P1' });
      const afterRefund = await balance(card.id);
      check(
        `refund ${inWord} the balance, exactly once`,
        near(afterRefund, afterPurchase + sign * 2500),
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
        `funding ${inWord} the balance`,
        near(afterFunding, afterRefund + sign * 10000),
        `${money(afterRefund)} -> ${money(afterFunding)}`,
      );

      await addTxn(card.id, { kind: 'fee', amount: 75, paymentRef: 'E2E-FEE' });
      const afterFee = await balance(card.id);
      check(
        `fee ${spendWord} the balance`,
        near(afterFee, afterFunding + sign * -75),
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
        // Signed as spending on every card; the balance then moves the way
        // this card's own statement moves.
        Number(row.amount_aed) < 0 &&
        near(afterFx, start + card.sign * -settled);
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

  /* ============================ 3b. a card whose balance counts money drawn */

  console.log('\n\n3b. A CARD WHOSE STATEMENT COUNTS WHAT HAS BEEN DRAWN');
  console.log('-'.repeat(94));

  await scenario(async () => {
    // RAK 9825's statement works this way: a purchase raises the figure and a
    // payment lowers it, because the figure is what has been drawn on the card
    // rather than what is left on it. The risk in supporting that is flipping
    // the transactions themselves, which would corrupt every spend report in
    // the system. This proves the balance moves and the reporting does not.
    const drawnId = (
      await client.query(
        `select create_card('E2E DRAWN CARD 8888', 0, '2026-06-01', 'Credit card',
                            'active', 'AED', 'Test Bank', '8888', null,
                            'created by the end-to-end test', -1::smallint) as id`,
      )
    ).rows[0].id;
    check('a card can be created with the drawn convention', Boolean(drawnId));

    const [row] = await q(client, 'select balance_sign::int s from cards where id = $1', [drawnId]);
    check('the convention is stored on the card', row.s === -1, String(row.s));
    check('it opens at its opening balance', near(await balance(drawnId), 0));

    await addTxn(drawnId, { kind: 'purchase', amount: 1000, date: '2026-07-01',
                            paymentRef: 'DR-1' });
    const afterBuy = await balance(drawnId);
    check('a purchase RAISES the balance on this card', near(afterBuy, 1000),
          `${money(afterBuy)} AED`);

    await addTxn(drawnId, { kind: 'funding', amount: 1200, date: '2026-07-02',
                            paymentRef: 'DR-2' });
    const afterPay = await balance(drawnId);
    check('a payment LOWERS it, past zero into credit', near(afterPay, -200),
          `${money(afterPay)} AED`);

    // The point of the whole design: the rows themselves are untouched.
    const stored = await q(
      client,
      `select direction, amount_aed::numeric a from transactions
        where card_id = $1 order by txn_date`,
      [drawnId],
    );
    check('the purchase is still stored as spending, and still negative',
          stored[0].direction === 'spend' && Number(stored[0].a) === -1000,
          `${stored[0].direction} ${stored[0].a}`);
    check('the payment is still stored as funding, and still positive',
          stored[1].direction === 'funding' && Number(stored[1].a) === 1200,
          `${stored[1].direction} ${stored[1].a}`);

    const [totals] = await q(
      client,
      'select total_spend::numeric s, total_funding::numeric f from card_balances where card_id = $1',
      [drawnId],
    );
    check('spend reporting is unaffected by the convention',
          near(totals.s, -1000) && near(totals.f, 1200),
          `spend ${money(totals.s)}, funding ${money(totals.f)}`);
  });

  await scenario(() =>
    expectRefused('a balance convention that is neither +1 nor -1', () =>
      client.query(
        `select create_card('E2E BAD SIGN', 0, '2026-06-01', 'Credit card', 'active',
                            'AED', null, null, null, null, 0::smallint)`,
      )));

  /* ================================================ 3c. the history of a row */

  console.log('\n\n3c. EVERY CHANGE IS RECORDED, AND ONLY AN ADMIN CAN READ IT');
  console.log('-'.repeat(94));

  await scenario(async () => {
    const target = cards[0];

    // Adding.
    const id = await addTxn(target.id, {
      kind: 'purchase', amount: 4321, date: '2026-09-01', paymentRef: 'HIST-1',
      supplier: 'HISTORY TEST SUPPLIER',
    });
    let history = await q(
      client,
      `select action, actor, rationale, changes, from_status, to_status
         from activity_log where transaction_id = $1 order by created_at`,
      [id],
    );
    check('adding a transaction is recorded', history.length === 1, `${history.length} entries`);
    check('the entry says it was created', history[0]?.action === 'created', history[0]?.action);
    check('and names who did it', /@/.test(history[0]?.actor ?? ''), history[0]?.actor);
    check(
      'the created entry carries the figures the row was entered with',
      Number(history[0]?.changes?.amount_aed) === -4321 &&
        history[0]?.changes?.txn_date === '2026-09-01',
      JSON.stringify(history[0]?.changes),
    );

    // Editing.
    await client.query(
      `select update_transaction(p_id := $1, p_rationale := $2, p_amount_aed := 5000)`,
      [id, 'the receipt says 5,000'],
    );
    history = await q(
      client,
      `select action, rationale, changes from activity_log
        where transaction_id = $1 order by created_at`,
      [id],
    );
    check('editing adds a second entry, it does not replace the first',
          history.length === 2, `${history.length} entries`);
    check('the edit records what the figure was and what it became',
          Number(history[1]?.changes?.amount_aed?.from) === -4321 &&
            Number(history[1]?.changes?.amount_aed?.to) === -5000,
          JSON.stringify(history[1]?.changes?.amount_aed));
    check('and why', history[1]?.rationale === 'the receipt says 5,000', history[1]?.rationale);

    // The history is append-only, like the table under it. There is no delete
    // or update policy on it, and row-level security answers a statement with
    // no policy by matching no rows rather than by raising — so what is checked
    // is that nothing moved, which is the thing that actually matters.
    const del = await client.query(
      'delete from transaction_corrections where transaction_id = $1', [id]);
    check('deleting a history entry removes nothing', del.rowCount === 0,
          `${del.rowCount} rows deleted`);
    const upd = await client.query(
      `update transaction_corrections set rationale = 'something else'
        where transaction_id = $1`, [id]);
    check('rewriting a history entry changes nothing', upd.rowCount === 0,
          `${upd.rowCount} rows changed`);

    const still = await q(client,
      'select count(*)::int n from activity_log where transaction_id = $1', [id]);
    check('both entries survived the attempts', still[0].n === 2, `${still[0].n}`);
  });

  await scenario(async () => {
    // A viewer may read the ledger and not the history. That is the whole point
    // of narrowing it, so it is checked from a viewer's session, not asserted.
    //
    // auth.users is not readable by the authenticated role that scenario()
    // switches to, so the account is found with the role reset, then handed
    // back before anything is read.
    await client.query('reset role');
    let viewer = (await q(client,
      `select id from auth.users where id not in (select user_id from admins) limit 1`))[0];
    // Every real account has write access, so a read-only one is created here
    // and rolled back with the rest of the scenario. Without this the check
    // would quietly stop testing anything the day the last viewer is promoted.
    if (!viewer) {
      viewer = (await q(client,
        `insert into auth.users (id, email) values (gen_random_uuid(), 'e2e-viewer@example.test')
         returning id`))[0];
    }
    if (!viewer) { check('a read-only account exists to test with', false); return; }

    await client.query('set local role authenticated');
    await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [viewer.id]);

    const readable = await q(client, 'select count(*)::int n from transactions');
    check('a viewer can still read the ledger', readable[0].n > 0, `${readable[0].n} rows`);

    const feed = await q(client, 'select count(*)::int n from activity_log');
    check('but the history reads as empty for them', feed[0].n === 0, `${feed[0].n} entries`);

    const corrections = await q(client, 'select count(*)::int n from transaction_corrections');
    check('and so does the table under it', corrections[0].n === 0, `${corrections[0].n} rows`);
  });

  /* ============================================ 3d. an editor versus the owner */

  console.log('\n\n3d. AN EDITOR DOES THE WORK; THE OWNER KEEPS THE KEYS');
  console.log('-'.repeat(94));

  await scenario(async () => {
    await client.query('reset role');
    const editor = (await q(client,
      `select user_id from admins where not is_owner limit 1`))[0];
    const owner = (await q(client, `select user_id from admins where is_owner limit 1`))[0];
    check('there is an owner', Boolean(owner));
    if (!editor) { check('there is an editor to test with', false); return; }

    await client.query('set local role authenticated');
    await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [editor.user_id]);

    // What an editor must be able to do: all of the actual work.
    const [me] = await q(client, 'select * from my_access()');
    check('an editor is told it may write', me.can_write === true, String(me.can_write));
    check('and told it may not manage', me.can_manage === false, String(me.can_manage));

    const card = cards[0];
    const before = await balance(card.id);
    const id = await addTxn(card.id, {
      kind: 'purchase', amount: 750, date: '2026-09-02', paymentRef: 'EDITOR-1',
      supplier: 'EDITOR TEST SUPPLIER',
    });
    check('an editor can add a transaction', Boolean(id));
    check('and it moves the balance', !near(await balance(card.id), before));

    await client.query(
      `select update_transaction(p_id := $1, p_rationale := $2, p_amount_aed := 800)`,
      [id, 'editor correcting the figure'],
    );
    const [edited] = await q(client, 'select amount_aed::numeric a from transactions where id = $1', [id]);
    check('an editor can edit one', near(edited.a, -800), String(edited.a));

    const newCard = (await client.query(
      `select create_card('EDITOR CARD 7777', 0, '2026-06-01', 'Credit card', 'active',
                          'AED', null, '7777', null, null) as id`)).rows[0].id;
    check('an editor can add a card', Boolean(newCard));

    // What an editor must NOT be able to do.
    const feed = await q(client, 'select count(*)::int n from activity_log');
    check('an editor cannot read the history', feed[0].n === 0, `${feed[0].n} entries`);

    const audit = await q(client, 'select count(*)::int n from admin_audit');
    check('nor the record of who has access', audit[0].n === 0, `${audit[0].n} rows`);

    const cardAudit = await q(client, 'select count(*)::int n from card_audit');
    check('nor the record of card changes', cardAudit[0].n === 0, `${cardAudit[0].n} rows`);

    const visible = await q(client, 'select count(*)::int n from admins');
    check('nor who else can write, beyond their own row',
          visible[0].n === 1, `${visible[0].n} rows`);

    // Their work is still recorded — that is the point of them not reading it.
    await client.query('reset role');
    await client.query('set local role authenticated');
    await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [owner.user_id]);
    const trail = await q(client,
      `select action, actor from activity_log where transaction_id = $1 order by created_at`, [id]);
    check('the owner sees what the editor did', trail.length === 2,
          trail.map((r) => r.action).join(', '));
    check('attributed to the editor by name',
          trail.every((r) => /@/.test(r.actor)), trail[0]?.actor);
  });

  // Each refusal gets its own transaction: a raised exception poisons the one
  // it happened in, and every statement after it would fail for that reason
  // rather than for the reason under test.
  const asEditor = async (label, fn) =>
    scenario(async () => {
      await client.query('reset role');
      const editor = (await q(client, 'select user_id from admins where not is_owner limit 1'))[0];
      if (!editor) { check(label, false, 'no editor account'); return; }
      await client.query('set local role authenticated');
      await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [editor.user_id]);
      await expectRefused(label, () => fn(editor));
    });

  await asEditor('an editor listing the accounts', () =>
    client.query('select * from list_app_users()'));
  await asEditor('an editor giving someone access', () =>
    client.query(`select grant_admin('accounting5@luxuryexplorersme.com', 'trying it on')`));
  await asEditor('an editor making themselves an owner', (editor) =>
    client.query(`select grant_admin($1, 'trying it on', true)`, [editor.user_id]));
  await asEditor("an editor taking an owner's access away", async () => {
    await client.query('reset role');
    const owner = (await q(client, 'select user_id from admins where is_owner limit 1'))[0];
    await client.query('set local role authenticated');
    const editor = (await q(client, 'select user_id from admins where not is_owner limit 1'))[0];
    await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [editor.user_id]);
    return client.query('select revoke_admin($1)', [owner.user_id]);
  });
  // Not expectRefused: row-level security answers an update that matches no
  // visible row by changing nothing rather than by raising, so what is checked
  // is that the editor is still an editor afterwards.
  await scenario(async () => {
    await client.query('reset role');
    const editor = (await q(client, 'select user_id from admins where not is_owner limit 1'))[0];
    if (!editor) { check('an editor promoting themselves changes nothing', false); return; }
    await client.query('set local role authenticated');
    await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [editor.user_id]);

    const r = await client.query(
      'update admins set is_owner = true where user_id = $1', [editor.user_id]);
    check('an editor writing straight into the admins table changes nothing',
          r.rowCount === 0, `${r.rowCount} rows changed`);

    const [{ can_manage }] = await q(client, 'select * from my_access()');
    check('and they are still an editor afterwards', can_manage === false, String(can_manage));
  });

  await scenario(async () => {
    // The last owner cannot be removed: the lockout would be silent and
    // unrecoverable, since only an owner can create another one.
    await client.query('reset role');
    const owners = await q(client, 'select user_id from admins where is_owner');
    check('there is exactly one owner to test the guard with', owners.length === 1,
          `${owners.length} owners`);
    await client.query('set local role authenticated');
    await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [owners[0].user_id]);
    await expectRefused('removing the only owner', () =>
      client.query('select revoke_admin($1)', [owners[0].user_id]));
  });

  /* ================================= 3e. a transaction with no payment reference */

  console.log('\n\n3e. A ROW WITH NO PAYMENT REFERENCE');
  console.log('-'.repeat(94));

  await scenario(async () => {
    // 577 of the workbook's 1,948 rows have none, so this has to be ordinary
    // rather than exceptional. What is checked is not that it saves, but that
    // the three things keyed on the reference still work without one.
    const card = cards[0];
    const start = await balance(card.id);

    const id = await addTxn(card.id, {
      kind: 'purchase', amount: 640, date: '2026-09-03',
      supplier: 'NO REFERENCE SUPPLIER', paymentRef: '',
    });
    check('a purchase with no payment reference saves', Boolean(id));
    check('and it moves the balance like any other',
          near(await balance(card.id), start + card.sign * -640),
          `${money(start)} -> ${money(await balance(card.id))}`);

    const [row] = await q(client,
      'select payment_ref, occurrence, dedup_key from transactions where id = $1', [id]);
    check('the column holds NULL, not an empty string',
          row.payment_ref === null, JSON.stringify(row.payment_ref));

    // upper(NULL) is NULL and NULL = anything is NULL, so a null reference
    // would silently defeat the double-submit guard.
    const again = await addTxn(card.id, {
      kind: 'purchase', amount: 640, date: '2026-09-03',
      supplier: 'NO REFERENCE SUPPLIER', paymentRef: '',
    });
    check('submitting the same form twice still returns the first row, not a second',
          again === id, again === id ? '' : 'A SECOND ROW WAS WRITTEN');

    // concat_ws skips a null argument rather than writing an empty field, which
    // would shift every later field in the signature by one position.
    const deliberate = await addTxn(card.id, {
      kind: 'purchase', amount: 640, date: '2026-09-03',
      supplier: 'NO REFERENCE SUPPLIER', paymentRef: '', allowDuplicate: true,
    });
    const [second] = await q(client,
      'select occurrence, dedup_key from transactions where id = $1', [deliberate]);
    check('a deliberate repeat is counted as the second occurrence',
          Number(second.occurrence) === 2, String(second.occurrence));
    check('and gets its own dedup key', second.dedup_key !== row.dedup_key);

    // The reference is still stored when there is one.
    const withRef = await addTxn(card.id, {
      kind: 'purchase', amount: 641, date: '2026-09-03',
      supplier: 'NO REFERENCE SUPPLIER', paymentRef: 'PR-KEPT-1',
    });
    const [kept] = await q(client, 'select payment_ref from transactions where id = $1', [withRef]);
    check('a reference that is given is still kept', kept.payment_ref === 'PR-KEPT-1',
          String(kept.payment_ref));
  });

  /* ============================ 3f. an import accounts for every row of its file */

  console.log('\n\n3f. AN IMPORT LEAVES A RECORD OF WHAT IT DID NOT TAKE');
  console.log('-'.repeat(94));

  await scenario(async () => {
    // A file of 36 rows once produced 31 transactions, and the five that never
    // arrived left no trace anywhere: not in transactions, and not in
    // import_batches, because the browser importer never wrote to it. The
    // balance was 64,297.17 short and the only way to ask why was to subtract
    // two numbers and guess.
    const card = cards[0];
    const [{ id: batchId }] = await q(client,
      `select begin_import_batch('e2e-file.xlsx', 5) as id`);
    check('an import opens a batch before it writes', Boolean(batchId));

    const id = await addTxn(card.id, {
      kind: 'purchase', amount: 120, date: '2026-09-01', paymentRef: 'BATCH-1',
      supplier: 'BATCH TEST SUPPLIER',
    });
    check('the one good row is written', Boolean(id));

    const leftOut = JSON.stringify([
      { source_row: 7,  supplier: 'HOTEL A', amount: -1000, kind: 'unticked',
        detail: 'Looks like a transaction already in the ledger.' },
      { source_row: 9,  supplier: 'HOTEL B', amount: -2000, kind: 'refused',
        detail: 'A request number is required' },
      { source_row: 12, supplier: 'HOTEL C', amount: -3000, kind: 'stopped',
        detail: 'The import stopped before reaching this row.' },
      { source_row: 25, supplier: 'HOTEL D', amount: -4000, kind: 'unticked',
        detail: 'Unticked before importing.' },
    ]);
    const [{ finish_import_batch: recorded }] = await q(client,
      `select finish_import_batch($1, 1, $2::jsonb, $3)`, [batchId, leftOut, card.name]);
    check('every row it did not take is recorded', Number(recorded) === 4, String(recorded));

    const [h] = await q(client,
      `select rows_in_file, imported, left_out, left_out_rows from import_history where batch_id = $1`,
      [batchId]);
    check('the file size is on record', Number(h.rows_in_file) === 5, String(h.rows_in_file));
    check('and what was taken from it', Number(h.imported) === 1, String(h.imported));
    check('and what was not', Number(h.left_out) === 4, String(h.left_out));

    // The whole point: the arithmetic has to close. Rows in the file must equal
    // what was imported plus what was left out, or something went missing
    // without anyone being told.
    check('imported plus left out accounts for the whole file',
          Number(h.imported) + Number(h.left_out) === Number(h.rows_in_file),
          `${h.imported} + ${h.left_out} vs ${h.rows_in_file}`);

    const kinds = h.left_out_rows.map((r) => r.kind).sort();
    check('a refusal, a stop and an untick are told apart',
          JSON.stringify(kinds) === JSON.stringify(['refused', 'stopped', 'unticked', 'unticked']),
          kinds.join(', '));
    check('each names the row it came from',
          h.left_out_rows.every((r) => Number.isFinite(Number(r.source_row))),
          h.left_out_rows.map((r) => r.source_row).join(', '));
    check('and says why, in words',
          h.left_out_rows.every((r) => String(r.detail).length > 10),
          String(h.left_out_rows[0]?.detail ?? '').slice(0, 46));
  });

  await scenario(() =>
    expectRefused('a viewer opening an import batch', async () => {
      await client.query('reset role');
      const viewer = (await q(client,
        `select id from auth.users where id not in (select user_id from admins) limit 1`))[0]
        ?? (await q(client,
          `insert into auth.users (id, email) values (gen_random_uuid(), 'e2e-batch@example.test')
           returning id`))[0];
      await client.query('set local role authenticated');
      await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [viewer.id]);
      return client.query(`select begin_import_batch('sneaky.xlsx', 1)`);
    }));

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
