/** Runs supabase/schema.sql against a throwaway Postgres and reports what it built. */
import { freshDatabase, rows } from './pg.mjs';

const { db } = await freshDatabase({
  schemaPath: 'supabase/schema.sql', quiet: false,
});
console.log('schema.sql executed against real Postgres — no errors');


const show = async (label, sql) => {
  const r = await rows(db, sql);
  console.log(`\n${label} (${r.length})`);
  for (const x of r) console.log('   ', Object.values(x).join('  '));
};
await show('TABLES', `select tablename from pg_tables where schemaname='public' order by 1`);
await show('VIEWS',  `select viewname  from pg_views  where schemaname='public' order by 1`);
await show('ENUMS',  `select t.typname || ' = ' || string_agg(e.enumlabel, ', ' order by e.enumsortorder)
                      from pg_type t join pg_enum e on e.enumtypid=t.oid group by t.typname order by 1`);
await show('CONSTRAINTS on transactions', `
  select conname from pg_constraint
  where conrelid='transactions'::regclass and contype='c' order by 1`);
await show('RLS ENABLED', `select tablename from pg_tables
  where schemaname='public' and rowsecurity order by 1`);
await show('POLICIES', `select tablename||' :: '||policyname from pg_policies
  where schemaname='public' order by 1`);
await db.close();
