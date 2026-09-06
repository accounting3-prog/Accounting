/**
 * Applies one migration, dry-run first.
 *
 * Every balance is read before and after and the difference is printed, so the
 * effect of the change is visible as money rather than as "OK". A dry run does
 * all of that inside a transaction and then rolls it back, so it is safe to run
 * against the live project as often as you like.
 *
 *   LEDGER_DEPS=... node scripts/db/apply_migration.mjs supabase/migrations/013_x.sql
 *   LEDGER_DEPS=... node scripts/db/apply_migration.mjs supabase/migrations/013_x.sql --live
 *
 * A migration is expected to carry its own `begin;` / `commit;`. Those are
 * stripped here so the whole file runs inside the transaction this script
 * controls — otherwise a dry run would commit itself halfway through.
 */

import { readFile } from 'node:fs/promises';
import { connect, q } from './connect.mjs';

const file = process.argv[2];
const live = process.argv.includes('--live');
if (!file) {
  console.error('usage: node scripts/db/apply_migration.mjs <file.sql> [--live]');
  process.exit(2);
}

const raw = await readFile(file, 'utf8');
// Only the outermost transaction control, never a `begin` inside a function
// body or a do-block: those are matched with the anchor at column zero.
const sql = raw
  .replace(/^\s*begin\s*;\s*$/gim, '')
  .replace(/^\s*commit\s*;\s*$/gim, '');

const money = (n) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const client = await connect();

async function balances() {
  return q(
    client,
    `select card_name, source_balance::text s, ledger_balance::text l,
            transaction_count::text n
       from card_balances order by card_name`,
  );
}

try {
  console.log(`\n${live ? 'LIVE' : 'DRY RUN'}  ${file}\n${'='.repeat(78)}`);

  const before = await balances();

  await client.query('begin');
  let failed = null;
  try {
    await client.query(sql);
  } catch (e) {
    failed = e;
  }

  if (failed) {
    await client.query('rollback');
    console.error(`\nThe migration failed. Nothing was changed.\n\n  ${failed.message}`);
    if (failed.where) console.error(`  in: ${failed.where}`);
    process.exit(1);
  }

  const after = await balances();

  console.log(
    '\n  CARD'.padEnd(38) +
      'SOURCE'.padStart(15) +
      'LEDGER'.padStart(15) +
      'CHANGE'.padStart(14),
  );
  console.log('  ' + '-'.repeat(76));
  let moved = 0;
  for (const a of after) {
    const b = before.find((x) => x.card_name === a.card_name);
    const delta = b ? Number(a.l) - Number(b.l) : Number(a.l);
    if (Math.abs(delta) > 0.004) moved++;
    console.log(
      '  ' +
        a.card_name.slice(0, 34).padEnd(36) +
        money(a.s).padStart(15) +
        money(a.l).padStart(15) +
        (Math.abs(delta) > 0.004 ? money(delta) : '—').padStart(14),
    );
  }
  for (const b of before) {
    if (!after.some((x) => x.card_name === b.card_name))
      console.log(`  ${b.card_name}  REMOVED`);
  }
  console.log(
    `\n  ${moved} card${moved === 1 ? '' : 's'} changed balance.` +
      `  ${after.length} cards, ${after.reduce((s, a) => s + Number(a.n), 0)} transactions.`,
  );

  if (live) {
    await client.query('commit');
    console.log('\n  COMMITTED.');
  } else {
    await client.query('rollback');
    console.log('\n  Rolled back — nothing was written. Re-run with --live to apply.');
  }
} finally {
  await client.end();
}
