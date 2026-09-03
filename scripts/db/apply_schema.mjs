/**
 * Applies supabase/schema.sql to the live Supabase project.
 *
 * Refuses to run if any of the schema's own tables already exist, so it can
 * never silently clobber a populated database. Pass --force only to re-apply
 * over an empty-but-partial schema.
 */
import { readFile } from 'node:fs/promises';
import { connect, q } from './connect.mjs';

const OURS = ['cards','transactions','suppliers','currencies','admins',
              'import_batches','import_anomalies','transaction_corrections'];
const force = process.argv.includes('--force');

const client = await connect();
try {
  const existing = (await q(client,
    `select tablename from pg_tables where schemaname='public' and tablename = any($1)`,
    [OURS])).map(r => r.tablename);

  if (existing.length && !force) {
    console.log('REFUSING to apply — these tables already exist:');
    for (const t of existing) {
      const n = (await q(client, `select count(*)::int as n from public."${t}"`))[0].n;
      console.log(`   ${t}  (${n} rows)`);
    }
    console.log('\nNothing was changed. Re-run with --force only if you intend to re-apply.');
    process.exit(1);
  }

  console.log('applying supabase/schema.sql ...');
  const sql = await readFile('supabase/schema.sql', 'utf8');
  await client.query(sql);
  console.log('applied with no errors\n');

  const show = async (label, sql2) => {
    const rows = await q(client, sql2);
    console.log(`${label} (${rows.length})`);
    console.log('   ' + rows.map(r => Object.values(r)[0]).join(', '));
  };
  await show('TABLES', `select tablename from pg_tables where schemaname='public' order by 1`);
  await show('VIEWS',  `select viewname from pg_views where schemaname='public' order by 1`);
  await show('RLS ON', `select tablename from pg_tables where schemaname='public' and rowsecurity order by 1`);
  const pol = await q(client, `select count(*)::int as n from pg_policies where schemaname='public'`);
  console.log(`POLICIES (${pol[0].n})`);
  const cur = await q(client, `select count(*)::int as n from currencies`);
  console.log(`CURRENCIES seeded: ${cur[0].n}`);
} finally {
  await client.end();
}
