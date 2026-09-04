/**
 * Scale and completeness, against a throwaway PostgreSQL.
 *
 * The live project holds 1,949 transactions, which is below every limit that
 * matters — so a bug that only appears past a page boundary would not show up
 * there. This generates 5,000 and 100,000 rows and checks the things that break
 * quietly at volume: paging that repeats or skips rows, ordering that shuffles
 * between requests, balances computed from a partial read, and exports that
 * stop at a page boundary while looking complete.
 *
 * Nothing here touches the live database.
 */

import { freshDatabase } from './pg.mjs';

let pass = 0;
const bugs = [];
function check(label, ok, detail = '') {
  if (ok) pass++;
  else bugs.push(label + (detail ? `: ${detail}` : ''));
  console.log(`    ${ok ? 'PASS' : 'BUG '}  ${label.padEnd(58)}${detail}`);
}
const near = (a, b, tol = 0.01) => Math.abs(Number(a) - Number(b)) <= tol;

const { db } = await freshDatabase({ schemaPath: 'supabase/schema.sql' });

console.log('='.repeat(94));
console.log('SCALE TEST — throwaway PostgreSQL');
console.log('='.repeat(94));

const cardId = (
  await db.query(
    `insert into cards (name, opening_balance, opening_date)
     values ('SCALE CARD', 100000, '2020-01-01') returning id`,
  )
).rows[0].id;

/** Generate n transactions with known, checkable properties. */
async function generate(n, offset = 0) {
  const CHUNK = 2000;
  for (let i = 0; i < n; i += CHUNK) {
    const rows = [];
    const params = [];
    for (let j = 0; j < Math.min(CHUNK, n - i); j++) {
      const k = offset + i + j;
      // Deliberately clustered dates: 100 rows share each date, which is what
      // makes an unstable sort repeat or skip rows between pages.
      const day = 1 + (Math.floor(k / 100) % 28);
      const month = 1 + (Math.floor(k / 2800) % 12);
      const p = params.length;
      params.push(
        cardId,
        `2021-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
        // Alternating spend and funding, so a missing direction filter shows up.
        k % 2 === 0 ? -10 : 5,
        k % 2 === 0 ? 'spend' : 'funding',
        k % 3 === 0 ? 'EUR' : 'AED',
        k % 3 === 0 ? 2 : null,
        `SCALE SUPPLIER ${k % 50}`,
        `REQ ${k}`,
        `scale-${k}`,
      );
      rows.push(
        `($${p + 1},'source_transaction','confirmed',$${p + 2},$${p + 3},$${p + 4},true,` +
          `$${p + 5},$${p + 6},$${p + 7},$${p + 8},$${p + 9})`,
      );
    }
    await db.query(
      `insert into transactions
         (card_id, entry_type, status, txn_date, amount_aed, direction,
          included_in_source_balance, currency, original_amount, supplier_raw,
          req_number, dedup_key)
       values ${rows.join(',')}`,
      params,
    );
  }
}

for (const SIZE of [5000, 100000]) {
  const existing = (await db.query('select count(*)::int n from transactions')).rows[0].n;
  const t0 = Date.now();
  await generate(SIZE - existing, existing);
  const total = (await db.query('select count(*)::int n from transactions')).rows[0].n;
  console.log(`\n${total.toLocaleString()} TRANSACTIONS  (generated in ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  console.log('-'.repeat(94));

  /* -------------------------------------------------- paging completeness */

  const PAGE = 1000;
  const seen = [];
  const pageT0 = Date.now();
  for (let from = 0; ; from += PAGE) {
    const page = await db.query(
      `select id from transactions
        order by txn_date desc nulls last, id asc
        limit $1 offset $2`,
      [PAGE, from],
    );
    seen.push(...page.rows.map((r) => r.id));
    if (page.rows.length < PAGE) break;
  }
  const pageMs = Date.now() - pageT0;

  check('paging returns every row', seen.length === total,
        `${seen.length.toLocaleString()} of ${total.toLocaleString()}`);
  check('paging repeats no row', new Set(seen).size === seen.length,
        `${seen.length - new Set(seen).size} duplicates`);
  const all = new Set(
    (await db.query('select id from transactions')).rows.map((r) => r.id),
  );
  let missed = 0;
  for (const id of all) if (!all.has(id)) missed++;
  const seenSet = new Set(seen);
  for (const id of all) if (!seenSet.has(id)) missed++;
  check('paging skips no row', missed === 0, `${missed} missed`);
  console.log(`      paged in ${(pageMs / 1000).toFixed(1)}s, ${Math.ceil(total / PAGE)} requests`);

  /* -------------------------------------------------- ordering stability */

  const runs = [];
  for (let i = 0; i < 3; i++) {
    const r = await db.query(
      `select id from transactions order by txn_date desc nulls last, id asc
        limit 100 offset $1`,
      [Math.floor(total / 2)],
    );
    runs.push(r.rows.map((x) => x.id).join(','));
  }
  check('the same page comes back identical every time',
        runs.every((r) => r === runs[0]));

  const noTiebreak = [];
  for (let i = 0; i < 3; i++) {
    const r = await db.query(
      `select id from transactions order by txn_date desc nulls last
        limit 100 offset $1`,
      [Math.floor(total / 2)],
    );
    noTiebreak.push(r.rows.map((x) => x.id).join(','));
  }
  if (!noTiebreak.every((r) => r === noTiebreak[0]))
    console.log('      (without the id tiebreak the same query returns a different page)');

  /* -------------------------------------------------- balances at volume */

  const view = (
    await db.query('select ledger_balance, source_balance from card_balances')
  ).rows[0];
  const raw = (
    await db.query(
      `select (select opening_balance from cards where id = $1)
              + coalesce(sum(amount_aed), 0) as bal
         from transactions where card_id = $1
           and entry_type = 'source_transaction' and status <> 'voided'`,
      [cardId],
    )
  ).rows[0];
  check('the balance view agrees with raw SQL at this volume',
        near(view.ledger_balance, raw.bal),
        `${Number(view.ledger_balance).toLocaleString()} AED`);

  // A balance computed from only the first page would be badly wrong; this is
  // the number the app would have shown before pagination was fixed.
  const firstPageOnly = (
    await db.query(
      `select coalesce(sum(amount_aed), 0) s from (
         select amount_aed from transactions
          order by txn_date desc nulls last, id asc limit 1000) x`,
    )
  ).rows[0].s;
  const fullSum = (
    await db.query('select coalesce(sum(amount_aed),0) s from transactions')
  ).rows[0].s;
  check('a one-page read would have been wrong (so the fix matters)',
        !near(firstPageOnly, fullSum, 1),
        `1 page ${Number(firstPageOnly).toLocaleString()} vs all ${Number(fullSum).toLocaleString()}`);

  /* -------------------------------------------------- currency aggregation */

  const spendView = (
    await db.query(
      'select currency, transaction_count, total_settled_aed from card_spend_by_currency order by currency',
    )
  ).rows;
  const spendRaw = (
    await db.query(
      `select currency, count(*)::int transaction_count, sum(amount_aed) total_settled_aed
         from transactions where direction='spend' and currency is not null
          and entry_type='source_transaction' and status<>'voided'
        group by currency order by currency`,
    )
  ).rows;
  check('currency aggregation matches raw SQL at this volume',
        spendView.length === spendRaw.length &&
          spendView.every((v, i) =>
            v.currency === spendRaw[i].currency &&
            Number(v.transaction_count) === spendRaw[i].transaction_count &&
            near(v.total_settled_aed, spendRaw[i].total_settled_aed)),
        `${spendView.length} currencies`);
  check('funding is not counted as spend',
        spendView.every((v) => Number(v.total_settled_aed) < 0),
        spendView.map((v) => `${v.currency} ${Number(v.total_settled_aed).toLocaleString()}`).join(', '));

  /* -------------------------------------------------- filtered search */

  const q = 'SCALE SUPPLIER 7';
  const matches = (
    await db.query(
      `select count(*)::int n from transactions where supplier_raw = $1`,
      [q],
    )
  ).rows[0].n;
  const pagedMatches = [];
  for (let from = 0; ; from += PAGE) {
    const page = await db.query(
      `select id from transactions where supplier_raw = $1
        order by txn_date desc nulls last, id asc limit $2 offset $3`,
      [q, PAGE, from],
    );
    pagedMatches.push(...page.rows.map((r) => r.id));
    if (page.rows.length < PAGE) break;
  }
  check('a filtered search returns every match across pages',
        pagedMatches.length === matches && new Set(pagedMatches).size === matches,
        `${matches.toLocaleString()} matches`);
}

await db.close();

console.log('\n' + '='.repeat(94));
console.log(bugs.length === 0 ? `ALL ${pass} SCALE CHECKS PASSED` : `${bugs.length} PROBLEM(S)`);
for (const b of bugs) console.log('  - ' + b);
console.log('='.repeat(94));
process.exit(bugs.length ? 1 : 0);
