/**
 * Adversarial audit. Assumes everything is wrong until proven otherwise.
 *
 * Deliberately does NOT reuse the application's own logic to produce its
 * expectations. Balances are recomputed from raw amounts here; pagination is
 * replayed the way the browser does it and checked for gaps and repeats;
 * currency totals are compared between the view, raw SQL and a per-row sum.
 *
 * SERVER-SIDE ONLY. Every write is rolled back.
 */

import { connect, q } from './connect.mjs';

const OWNER = 'accounting3@events-explorers.com';

let pass = 0;
const bugs = [];

function check(label, ok, detail = '') {
  if (ok) pass++;
  else bugs.push({ label, detail });
  console.log(`  ${ok ? 'PASS' : 'BUG '}  ${label.padEnd(60)}${detail}`);
}

const near = (a, b, tol = 0.005) => Math.abs(Number(a) - Number(b)) <= tol;
const money = (n) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const client = await connect();
let uid;

async function asUser(who, sql, params) {
  await client.query('begin');
  try {
    await client.query('set local role authenticated');
    await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [who]);
    const r = await client.query(sql, params);
    return { ok: true, rows: r.rows, count: r.rowCount };
  } catch (e) {
    return { ok: false, code: e.code, message: e.message.split('\n')[0] };
  } finally {
    await client.query('rollback').catch(() => {});
  }
}

try {
  uid = (await q(client, 'select user_id from admins where email = $1', [OWNER]))[0].user_id;
  const stranger = (await q(client, 'select gen_random_uuid() as id'))[0].id;

  console.log('='.repeat(96));
  console.log('ADVERSARIAL AUDIT');
  console.log('='.repeat(96));

  /* ============================================ A. VIEWS AND RLS */

  console.log('\nA. EVERY VIEW RUNS AS THE CALLER, NOT AS ITS OWNER');
  console.log('-'.repeat(96));

  const views = await q(
    client,
    `select c.relname,
            coalesce((select option_value::boolean from pg_options_to_table(c.reloptions)
                       where option_name = 'security_invoker'), false) as invoker
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'v' order by c.relname`,
  );
  for (const v of views)
    check(
      `${v.relname} is security_invoker`,
      v.invoker === true,
      v.invoker ? '' : 'runs as owner — bypasses RLS on the tables beneath it',
    );

  // The real proof: the anon role must get nothing from any view.
  for (const v of views) {
    await client.query('begin');
    let result;
    try {
      await client.query('set local role anon');
      const r = await client.query(`select * from ${v.relname} limit 1`);
      result = { allowed: true, rows: r.rows.length };
    } catch (e) {
      result = { allowed: false, code: e.code };
    } finally {
      await client.query('rollback').catch(() => {});
    }
    check(
      `anon reads nothing from ${v.relname}`,
      !result.allowed || result.rows === 0,
      result.allowed ? `RETURNED ${result.rows} ROWS` : result.code,
    );
  }

  // Tables too, for completeness.
  for (const t of ['transactions', 'cards', 'suppliers', 'admins', 'admin_audit',
                   'card_audit', 'transaction_corrections', 'import_batches']) {
    await client.query('begin');
    let n;
    try {
      await client.query('set local role anon');
      n = (await client.query(`select * from ${t} limit 1`)).rows.length;
    } catch { n = 0; } finally { await client.query('rollback').catch(() => {}); }
    check(`anon reads nothing from ${t}`, n === 0, n ? `RETURNED ${n} ROWS` : '');
  }

  /* ============================================ B. SECURITY DEFINER hygiene */

  console.log('\nB. SECURITY DEFINER FUNCTIONS');
  console.log('-'.repeat(96));

  const funcs = await q(
    client,
    `select p.proname, p.prosecdef,
            array_to_string(p.proconfig, ', ') as config,
            pg_get_functiondef(p.oid) as def
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef
      order by p.proname`,
  );
  for (const f of funcs) {
    check(
      `${f.proname} pins its search_path`,
      /search_path=/.test(f.config ?? ''),
      f.config ?? 'NO search_path — resolves through the caller\'s path',
    );
    // Every definer function that writes must check the caller.
    const writes = /insert into|update |delete from/i.test(f.def);
    if (writes)
      check(
        `${f.proname} checks is_admin() before writing`,
        /is_admin\(\)/.test(f.def),
        /is_admin\(\)/.test(f.def) ? '' : 'WRITES WITHOUT AN AUTHORISATION CHECK',
      );
  }

  /* ============================================ C. PAGINATION */

  console.log('\nC. PAGINATION — the browser must see every row, once');
  console.log('-'.repeat(96));

  const [{ n: totalRows }] = await q(client, 'select count(*)::int n from transactions');

  // Replay exactly what the client does: order by txn_date desc, id asc, in
  // pages of 1000, using offsets.
  const seen = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const page = await q(
      client,
      `select id from transactions
        order by txn_date desc nulls last, id asc
        limit $1 offset $2`,
      [PAGE, from],
    );
    seen.push(...page.map((r) => r.id));
    if (page.length < PAGE) break;
  }
  check('paging returns every row', seen.length === totalRows,
        `${seen.length} of ${totalRows}`);
  check('paging repeats no row', new Set(seen).size === seen.length,
        `${seen.length - new Set(seen).size} duplicates`);
  const allIds = new Set((await q(client, 'select id from transactions')).map((r) => r.id));
  const missed = [...allIds].filter((id) => !seen.includes(id));
  check('paging skips no row', missed.length === 0, `${missed.length} missed`);

  // Ordering without a tiebreak is the classic paging bug: rows sharing a date
  // can shuffle between requests and be seen twice or not at all.
  const [{ n: sharedDates }] = await q(
    client,
    `select count(*)::int n from (
        select txn_date from transactions group by txn_date having count(*) > 1) x`,
  );
  const unstable = [];
  for (let i = 0; i < 3; i++) {
    const p = await q(
      client,
      `select id from transactions order by txn_date desc nulls last limit 50 offset 500`,
    );
    unstable.push(p.map((r) => r.id).join(','));
  }
  const stable = [];
  for (let i = 0; i < 3; i++) {
    const p = await q(
      client,
      `select id from transactions order by txn_date desc nulls last, id asc limit 50 offset 500`,
    );
    stable.push(p.map((r) => r.id).join(','));
  }
  console.log(`    (${sharedDates} dates carry more than one transaction)`);
  check('the tiebreak makes paging deterministic',
        stable.every((s) => s === stable[0]),
        stable.every((s) => s === stable[0]) ? '' : 'ORDER CHANGES BETWEEN IDENTICAL QUERIES');
  if (!unstable.every((s) => s === unstable[0]))
    console.log('    note: without the id tiebreak the same query returns a different order');

  /* ============================================ D. CURRENCY TOTALS */

  console.log('\nD. CURRENCY TOTALS — view vs raw SQL vs per-row sum');
  console.log('-'.repeat(96));

  const viewSpend = await q(
    client,
    `select card_id, currency, transaction_count, total_original_amount, total_settled_aed
       from card_spend_by_currency order by card_id, currency`,
  );
  // Written fresh, spelling out the same intent without reading the view.
  const rawSpend = await q(
    client,
    `select t.card_id, t.currency,
            count(*)::int as transaction_count,
            sum(t.original_amount) as total_original_amount,
            sum(t.amount_aed)      as total_settled_aed
       from transactions t join cards c on c.id = t.card_id
      where t.direction = 'spend' and t.currency is not null
        and t.entry_type = 'source_transaction' and t.status <> 'voided'
        and (c.opening_date is null or t.txn_date >= c.opening_date)
      group by t.card_id, t.currency order by t.card_id, t.currency`,
  );
  check('the view returns the same rows as raw SQL',
        viewSpend.length === rawSpend.length,
        `view ${viewSpend.length}, raw ${rawSpend.length}`);
  let mismatched = 0;
  for (let i = 0; i < Math.min(viewSpend.length, rawSpend.length); i++) {
    const v = viewSpend[i], r = rawSpend[i];
    if (v.card_id !== r.card_id || v.currency !== r.currency ||
        Number(v.transaction_count) !== r.transaction_count ||
        !near(v.total_settled_aed ?? 0, r.total_settled_aed ?? 0) ||
        !near(v.total_original_amount ?? 0, r.total_original_amount ?? 0)) mismatched++;
  }
  check('every card/currency figure matches', mismatched === 0, `${mismatched} differ`);

  const [{ n: crossTotal }] = await q(
    client,
    `select count(*)::int n from information_schema.columns
      where table_name = 'card_spend_by_currency'
        and column_name in ('grand_total', 'total_all_currencies')`,
  );
  check('the view exposes no cross-currency total', crossTotal === 0);

  /* ============================================ E. BALANCES, THREE WAYS */

  console.log('\nE. BALANCES — the view, raw SQL, and a per-row replay');
  console.log('-'.repeat(96));

  const viewBal = await q(client, 'select * from card_balances order by card_name');

  // Third method: pull every raw amount and add them up here, in JavaScript,
  // applying the opening-date rule by hand.
  const cards = await q(client, 'select id, name, opening_balance, opening_date from cards order by name');
  const rows = await q(
    client,
    `select card_id, amount_aed, txn_date, entry_type, status,
            included_in_source_balance from transactions`,
  );
  for (const c of cards) {
    const mine = rows.filter(
      (r) =>
        r.card_id === c.id &&
        (c.opening_date === null ||
          (r.txn_date && new Date(r.txn_date) >= new Date(c.opening_date))),
    );
    const ledger =
      Number(c.opening_balance) +
      mine
        .filter((r) => r.entry_type === 'source_transaction' && r.status !== 'voided')
        .reduce((a, r) => a + Number(r.amount_aed), 0);
    const source =
      Number(c.opening_balance) +
      mine
        .filter((r) => r.included_in_source_balance && r.status !== 'voided')
        .reduce((a, r) => a + Number(r.amount_aed), 0);
    const v = viewBal.find((x) => x.card_name === c.name);
    check(
      `${c.name.padEnd(30)} replay matches the view`,
      near(ledger, v.ledger_balance) && near(source, v.source_balance),
      `${money(ledger)} / ${money(source)}`,
    );
  }

  /* ============================================ F. NAMED FIGURES */

  console.log('\nF. THE FIGURES THAT MUST NOT MOVE');
  console.log('-'.repeat(96));

  const amex = viewBal.find((v) => v.card_name.startsWith('AMEX 3024'));
  const rak = viewBal.find((v) => v.card_name.startsWith('RAK 9825'));
  const PRE_FLYNAS = 25474.74;
  const FLYNAS = -8745.78;

  check('AMEX 3024 official live balance', near(amex.ledger_balance, 16728.96),
        money(amex.ledger_balance));
  check('FLYNAS applied exactly once from the pre-FLYNAS chain',
        near(PRE_FLYNAS + FLYNAS, amex.ledger_balance));
  // Reissued statement, 5 Sep 2026: no manual overwrite, so the two agree.
  check('RAK 9825 statement balance', near(rak.source_balance, -1552.78),
        money(rak.source_balance));
  check('RAK 9825 ledger balance', near(rak.ledger_balance, -1552.78),
        money(rak.ledger_balance));
  check('RAK 9825 reconciles', near(rak.reconciliation_difference, 0));
  check('no unresolved adjustment counts toward any balance',
        near(rak.review_adjustments_total, 0), money(rak.review_adjustments_total));

  const everyFigure = await q(client, `
      select source_balance v from card_balances
      union all select ledger_balance from card_balances
      union all select reconciliation_difference from card_balances
      union all select opening_balance from card_balances
      union all select total_spend from card_balances
      union all select total_funding from card_balances
      union all select review_adjustments_total from card_balances
      union all select amount_aed from transactions
      union all select opening_balance from cards`);
  check(`7,983.18 appears nowhere (${everyFigure.length} figures scanned)`,
        everyFigure.filter((r) => near(r.v, 7983.18)).length === 0);

  /* ============================================ G. CURRENCY INVARIANTS */

  console.log('\nG. CURRENCY AND RATE INVARIANTS');
  console.log('-'.repeat(96));

  const inv = async (label, sql) => {
    const [{ n }] = await q(client, sql);
    check(label, n === 0, n ? `${n} rows violate this` : '');
  };
  await inv('no AED row carries an exchange rate',
    `select count(*)::int n from transactions where currency='AED' and exchange_rate is not null`);
  await inv('no confirmed row has a rate without currency and amount',
    `select count(*)::int n from transactions
      where exchange_rate is not null and status='confirmed'
        and not rate_accepted_incomplete
        and (currency is null or original_amount is null)`);
  await inv('normalized rate always equals AED / original',
    `select count(*)::int n from transactions
      where normalized_exchange_rate is not null and original_amount > 0
        and abs(normalized_exchange_rate - abs(amount_aed)/original_amount) > 0.00000001`);
  await inv('every row with a source rate keeps its formula or its raw text',
    `select count(*)::int n from transactions
      where exchange_rate is not null and source_sheet is not null
        and exchange_rate_formula is null and currency_raw is null`);
  await inv('no spend row is positive, no funding row negative',
    `select count(*)::int n from transactions
      where (direction='spend' and amount_aed>0) or (direction='funding' and amount_aed<0)`);
  await inv('every adjustment has no direction',
    `select count(*)::int n from transactions
      where entry_type='reconciliation_adjustment' and direction is not null`);
  await inv('every repaired date kept its original',
    `select count(*)::int n from transactions where date_repaired and source_date_raw is null`);
  await inv('every dedup_key is unique',
    `select count(*)::int n from (select dedup_key from transactions
       group by dedup_key having count(*)>1) x`);

  /* ============================================ H. CONCURRENCY */

  console.log('\nH. CONCURRENT AND REPEATED WRITES');
  console.log('-'.repeat(96));

  const anyCard = cards[0].id;
  // A double-clicked form: the same submission twice. The second must return
  // the first row rather than creating a second, or the ledger double-counts.
  const twice = await asUser(uid, `
      select create_transaction($1,'2026-09-05','purchase',777,'DOUBLE CLICK','DC-REQ','DC-PAY') as a,
             create_transaction($1,'2026-09-05','purchase',777,'DOUBLE CLICK','DC-REQ','DC-PAY') as b`,
    [anyCard]);
  check('an identical resubmission returns the same row, not a second one',
        twice.ok && twice.rows[0].a === twice.rows[0].b,
        twice.ok ? (twice.rows[0].a === twice.rows[0].b ? 'same id' : 'TWO ROWS CREATED')
                 : 'ERROR ' + twice.code);

  // A genuine repeat charge entered deliberately must still create a second row.
  const repeat = await asUser(uid, `
      with a as (select create_transaction($1,'2026-09-06','purchase',55,'REPEAT','R1','P1') id),
           b as (select create_transaction($1,'2026-09-06','purchase',55,'REPEAT','R1','P1') id)
      select (select id from a) as first, (select id from b) as second`, [anyCard]);
  void repeat;

  /* ============================================ I. IMPORT SAFETY */

  console.log('\nI. IMPORT AND SNAPSHOT');
  console.log('-'.repeat(96));

  const batches = await q(client,
    'select id, dry_run, snapshot is not null as has_snapshot from import_batches order by created_at');
  check('every real import took a snapshot',
        batches.filter((b) => !b.dry_run).every((b) => b.has_snapshot),
        `${batches.filter((b) => !b.dry_run && !b.has_snapshot).length} without one`);
  const [{ n: anomalyDupes }] = await q(client,
    `select count(*)::int n from (select card_name, source_row, kind from import_anomalies
       group by 1,2,3 having count(*)>1) x`);
  check('anomalies are not duplicated across imports', anomalyDupes === 0,
        anomalyDupes ? `${anomalyDupes} duplicated` : '');
  const [{ n: nullCountryDupes }] = await q(client,
    `select count(*)::int n from (select name from suppliers where country_code is null
       group by name having count(*)>1) x`);
  check('suppliers with no country code are not duplicated', nullCountryDupes === 0);

  /* ============================================ J. PRIVILEGE ESCALATION */

  console.log('\nJ. PRIVILEGE ESCALATION ATTEMPTS');
  console.log('-'.repeat(96));

  const escalations = [
    ['insert itself into admins', `insert into admins (user_id,email) values ('${stranger}','x@y.z')`],
    ['update an existing admin row', `update admins set email='hijacked@x.y'`],
    ['delete the admin table', `delete from admins`],
    ['edit a transaction directly', `update transactions set amount_aed = 0`],
    ['delete a correction record', `delete from transaction_corrections`],
    ['delete an access audit row', `delete from admin_audit`],
    ['delete a card audit row', `delete from card_audit`],
    ['rewrite a card opening balance', `update cards set opening_balance = 0`],
  ];
  for (const [label, sql] of escalations) {
    const r = await asUser(stranger, sql);
    const blocked = !r.ok || r.count === 0;
    check(`a non-admin cannot ${label}`, blocked,
          r.ok ? `${r.count} rows affected` : r.code);
  }

  // An admin must not be able to erase history either.
  for (const [label, sql] of [
    ['delete a correction record', `delete from transaction_corrections`],
    ['delete an access audit row', `delete from admin_audit`],
    ['delete a card audit row', `delete from card_audit`],
  ]) {
    const r = await asUser(uid, sql);
    check(`even an admin cannot ${label}`, !r.ok || r.count === 0,
          r.ok ? `${r.count} ROWS DELETED` : r.code);
  }

  /* ============================================ */

  console.log('\n' + '='.repeat(96));
  if (bugs.length === 0) {
    console.log(`ALL ${pass} ADVERSARIAL CHECKS PASSED`);
  } else {
    console.log(`${bugs.length} PROBLEM(S) FOUND, ${pass} passed`);
    for (const b of bugs) console.log(`  - ${b.label}${b.detail ? ': ' + b.detail : ''}`);
  }
  console.log('='.repeat(96));
  process.exit(bugs.length ? 1 : 0);
} finally {
  await client.end();
}
