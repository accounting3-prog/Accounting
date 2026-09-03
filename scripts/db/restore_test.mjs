/**
 * Backup-and-restore test, exercised end to end.
 *
 * Runs against a throwaway PGlite database — real PostgreSQL, created fresh in
 * this process and discarded — so it can be destroyed freely without touching
 * the live project.
 *
 * The sequence is the one that matters in an incident:
 *
 *   1. apply the real schema.sql and import the real ledger;
 *   2. take a snapshot, exactly as scripts/db/import.mjs does before a write;
 *   3. make controlled, destructive changes — delete rows, alter an amount,
 *      insert a row that should not exist;
 *   4. restore the snapshot;
 *   5. verify column-for-column that the data came back, not merely that the
 *      row counts match.
 *
 * A restore that reproduces the right number of rows with the wrong values in
 * them is worse than no restore at all, so step 5 compares every column of
 * every row and reports the first differences it finds.
 */

import { readFile } from 'node:fs/promises';
import { freshDatabase } from './pg.mjs';

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(56)}${detail}`);
}

const TABLES = ['cards', 'suppliers', 'transactions'];

/** Every row of every tracked table, ordered deterministically. */
async function capture(db) {
  const out = {};
  for (const t of TABLES) {
    const order =
      t === 'transactions' ? 'dedup_key' : t === 'cards' ? 'name' : 'name, country_code';
    const res = await db.query(`select * from ${t} order by ${order}`);
    out[t] = res.rows;
  }
  return out;
}

/**
 * Column-for-column comparison. Returns the differences, not just a boolean,
 * so a failure says which field of which row is wrong.
 */
function diff(before, after) {
  const problems = [];
  for (const t of TABLES) {
    const a = before[t];
    const b = after[t];
    if (a.length !== b.length) {
      problems.push(`${t}: ${a.length} rows before, ${b.length} after`);
      continue;
    }
    for (let i = 0; i < a.length; i++) {
      for (const col of Object.keys(a[i])) {
        const x = a[i][col];
        const y = b[i][col];
        const same =
          x instanceof Date && y instanceof Date
            ? x.getTime() === y.getTime()
            : String(x) === String(y);
        if (!same)
          problems.push(
            `${t}[${i}].${col}: ${JSON.stringify(x)} -> ${JSON.stringify(y)}`,
          );
      }
    }
  }
  return problems;
}

/**
 * Columns Postgres computes for itself and refuses to be given a value for.
 * `transactions.search_text` is one, so a naive "insert every column back"
 * restore fails outright. They are still compared afterwards: if the columns
 * they derive from came back correctly, so must they.
 */
async function generatedColumns(db) {
  const res = await db.query(
    `select table_name, column_name from information_schema.columns
      where table_schema = 'public' and is_generated = 'ALWAYS'`,
  );
  const map = new Map();
  for (const r of res.rows) {
    if (!map.has(r.table_name)) map.set(r.table_name, new Set());
    map.get(r.table_name).add(r.column_name);
  }
  return map;
}

async function restore(db, snapshot, generated) {
  // Restore in dependency order, and put children back before parents are
  // needed again. Deleting transactions first keeps the foreign keys satisfied.
  await db.exec('begin');
  await db.exec('delete from transactions; delete from suppliers; delete from cards;');

  for (const table of ['cards', 'suppliers', 'transactions']) {
    const rows = snapshot[table];
    if (!rows.length) continue;
    const skip = generated.get(table) ?? new Set();
    const cols = Object.keys(rows[0]).filter((c) => !skip.has(c));
    for (const row of rows) {
      const params = cols.map((c) => row[c]);
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
      await db.query(
        `insert into ${table} (${cols.map((c) => `"${c}"`).join(',')})
         values (${placeholders})`,
        params,
      );
    }
  }
  await db.exec('commit');
}

console.log('='.repeat(88));
console.log('BACKUP AND RESTORE TEST — throwaway PostgreSQL, destroyed at the end');
console.log('='.repeat(88));

const { db } = await freshDatabase({ schemaPath: 'supabase/schema.sql' });
console.log('\n1. THROWAWAY DATABASE CREATED');
console.log('-'.repeat(88));
const v = await db.query('select version()');
console.log(`  ${String(v.rows[0].version).split(',')[0]}`);
console.log('  schema.sql applied verbatim');

/* ------------------------------------------------------------ 2. import */

console.log('\n2. LEDGER IMPORTED');
console.log('-'.repeat(88));
const extraction = JSON.parse(await readFile('scripts/out/normalised.json', 'utf8'));

const cardIds = new Map();
for (const c of extraction) {
  const dated = c.transactions.map((t) => t.txn_date).filter(Boolean).sort();
  const r = await db.query(
    `insert into cards (name, opening_balance, opening_date, source_sheet,
                        source_header_row, decreasing_column, decreasing_header,
                        increasing_column, increasing_header, balance_formula)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
    [c.card, c.opening_balance, dated[0] ?? null, c.card, c.header_row,
     c.decreasing_column, String(c.decreasing_header ?? ''), c.increasing_column,
     String(c.increasing_header ?? ''), c.balance_formula_sample],
  );
  cardIds.set(c.card, r.rows[0].id);
}

const supplierIds = new Map();
for (const c of extraction)
  for (const t of c.transactions) {
    if (!t.supplier) continue;
    const k = `${t.supplier}|${t.supplier_country ?? ''}`;
    if (supplierIds.has(k)) continue;
    const r = await db.query(
      `insert into suppliers (name, country_code) values ($1,$2)
       on conflict (name, country_code) do update set name = excluded.name
       returning id`,
      [t.supplier, t.supplier_country ?? null],
    );
    supplierIds.set(k, r.rows[0].id);
  }

let imported = 0;
for (const c of extraction)
  for (const t of c.transactions) {
    await db.query(
      `insert into transactions
         (card_id, entry_type, status, review_reason, description, txn_date,
          source_date_raw, date_repaired, date_repair_note, supplier_id,
          supplier_raw, amount_aed, direction, included_in_source_balance,
          currency, original_amount, currency_raw, exchange_rate,
          exchange_rate_formula, req_number, lpo_number, invoice, payment_ref,
          account, crm, client, sales_operation, event_end, notes, source_sheet,
          source_row, occurrence, dedup_key)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
               $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33)`,
      [
        cardIds.get(t.card), t.entry_type, t.status, t.review_reason ?? null,
        t.description ?? null, t.txn_date ?? null, t.source_date_raw ?? null,
        Boolean(t.date_repaired), t.date_repair_note ?? null,
        t.supplier ? supplierIds.get(`${t.supplier}|${t.supplier_country ?? ''}`) : null,
        t.supplier_raw ?? null, t.amount_aed, t.direction ?? null,
        t.included_in_source_balance !== false, t.currency ?? null,
        t.original_amount ?? null, t.currency_raw ?? null, t.exchange_rate ?? null,
        t.exchange_rate_formula ?? null, t.req_number ?? null, t.lpo_number ?? null,
        t.invoice ?? null, t.payment_ref ?? null, t.account ?? null, t.crm ?? null,
        t.client ?? null, t.sales_operation ?? null, t.event_end ?? null,
        t.notes ?? null, t.source_sheet ?? null, t.source_row ?? null,
        t.occurrence ?? 1, t.dedup_key,
      ],
    );
    imported++;
  }
console.log(`  ${cardIds.size} cards, ${supplierIds.size} suppliers, ${imported} transactions`);

const balancesBefore = (
  await db.query('select card_name, source_balance, ledger_balance from card_balances order by card_name')
).rows;
console.log('  balances computed from the restored-into database:');
for (const b of balancesBefore)
  console.log(
    `    ${String(b.card_name).padEnd(32)}source ${String(b.source_balance).padStart(12)}` +
      `   ledger ${String(b.ledger_balance).padStart(12)}`,
  );

/* ----------------------------------------------------------- 3. snapshot */

console.log('\n3. SNAPSHOT TAKEN');
console.log('-'.repeat(88));
const snapshot = await capture(db);
console.log(
  `  cards ${snapshot.cards.length}, suppliers ${snapshot.suppliers.length}, ` +
    `transactions ${snapshot.transactions.length}`,
);

/* ------------------------------------------------- 4. destructive changes */

console.log('\n4. CONTROLLED DAMAGE');
console.log('-'.repeat(88));

const del = await db.query(
  `delete from transactions where id in
     (select id from transactions order by dedup_key limit 250)`,
);
console.log(`  deleted ${del.affectedRows ?? 250} transactions`);

const upd = await db.query(
  `update transactions set amount_aed = amount_aed * 2, status = 'voided'
    where id in (select id from transactions order by dedup_key desc limit 100)`,
);
console.log(`  corrupted ${upd.affectedRows ?? 100} amounts and statuses`);

const anyCard = snapshot.cards[0];
await db.query(
  `insert into transactions (card_id, entry_type, status, amount_aed, direction,
                             supplier_raw, dedup_key)
   values ($1,'source_transaction','confirmed',-999999,'spend','BOGUS ROW','damage-key')`,
  [anyCard.id],
);
console.log('  inserted 1 row that should not exist');

await db.query(`update cards set opening_balance = 0 where id = $1`, [anyCard.id]);
console.log(`  zeroed the opening balance on ${anyCard.name}`);

const damaged = await capture(db);
const damageDiff = diff(snapshot, damaged);
check('the damage is detectable', damageDiff.length > 0, `${damageDiff.length} differences`);

const balancesDamaged = (
  await db.query('select card_name, ledger_balance from card_balances order by card_name')
).rows;
const damagedChanged = balancesDamaged.some(
  (b, i) => String(b.ledger_balance) !== String(balancesBefore[i].ledger_balance),
);
check('balances moved as a result', damagedChanged);

/* -------------------------------------------------------------- 5. restore */

console.log('\n5. SNAPSHOT RESTORED');
console.log('-'.repeat(88));
const t0 = Date.now();
const generated = await generatedColumns(db);
const generatedNote = [...generated.entries()]
  .map(([t, cols]) => `${t}.${[...cols].join(', ')}`)
  .join('; ');
if (generatedNote) console.log(`  generated columns rebuilt by Postgres: ${generatedNote}`);
await restore(db, snapshot, generated);
console.log(`  restored in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const after = await capture(db);

/* --------------------------------------------------- 6. column-for-column */

console.log('\n6. VERIFICATION — column for column, not row counts');
console.log('-'.repeat(88));

for (const t of TABLES)
  check(`${t}: row count restored`, after[t].length === snapshot[t].length,
        `${snapshot[t].length} rows`);

const problems = diff(snapshot, after);
const columnsChecked = TABLES.reduce(
  (n, t) => n + (snapshot[t][0] ? Object.keys(snapshot[t][0]).length * snapshot[t].length : 0),
  0,
);
check(
  'every column of every row matches the snapshot',
  problems.length === 0,
  `${columnsChecked.toLocaleString('en-US')} field comparisons`,
);
if (problems.length) {
  console.log('\n  first differences:');
  for (const p of problems.slice(0, 15)) console.log(`    ${p}`);
  if (problems.length > 15) console.log(`    ... and ${problems.length - 15} more`);
}

const [{ n: bogus }] = (
  await db.query(`select count(*)::int n from transactions where supplier_raw = 'BOGUS ROW'`)
).rows;
check('the row that should not exist is gone', bogus === 0);

const balancesAfter = (
  await db.query('select card_name, source_balance, ledger_balance from card_balances order by card_name')
).rows;
const balancesMatch = balancesAfter.every(
  (b, i) =>
    String(b.source_balance) === String(balancesBefore[i].source_balance) &&
    String(b.ledger_balance) === String(balancesBefore[i].ledger_balance),
);
check('every card balance recomputes to its pre-damage figure', balancesMatch);

console.log('\n  balances after restore:');
for (const b of balancesAfter)
  console.log(
    `    ${String(b.card_name).padEnd(32)}source ${String(b.source_balance).padStart(12)}` +
      `   ledger ${String(b.ledger_balance).padStart(12)}`,
  );

await db.close();

console.log('\n' + '='.repeat(88));
console.log(
  failures === 0
    ? 'RESTORE VERIFIED — data returned column-for-column, not merely row-for-row'
    : `${failures} CHECK(S) FAILED`,
);
console.log('='.repeat(88));
process.exit(failures ? 1 : 0);
