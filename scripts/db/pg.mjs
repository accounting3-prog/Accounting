/**
 * A throwaway Postgres for local testing.
 *
 * PGlite is a real Postgres compiled to WASM, running in-process. That means
 * schema.sql, the importer and the restore test all execute against genuine
 * Postgres semantics — constraints, generated columns, enums and views all
 * behave as they will on Supabase — without needing a server or credentials.
 *
 * Two things Supabase provides that a bare Postgres does not, shimmed here so
 * schema.sql runs UNCHANGED rather than being edited for local use:
 *   - the `auth` schema with `auth.users` and `auth.uid()`
 *   - the `authenticated` and `anon` roles that RLS policies are granted to
 */

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const DEPS = process.env.LEDGER_DEPS;
if (!DEPS) throw new Error('set LEDGER_DEPS to the directory holding node_modules');

const dep = (p) =>
  pathToFileURL(path.join(DEPS, 'node_modules/@electric-sql/pglite/dist', p)).href;

const { PGlite } = await import(dep('index.js'));
// pgcrypto and pg_trgm ship with PGlite but are separate WASM bundles that
// must be handed to the instance at creation; `create extension` alone fails.
const { pgcrypto } = await import(dep('contrib/pgcrypto.js'));
const { pg_trgm } = await import(dep('contrib/pg_trgm.js'));

/** Supabase-shaped scaffolding so schema.sql needs no local edits. */
const SUPABASE_SHIM = `
  create schema if not exists auth;
  create table if not exists auth.users (
      id    uuid primary key default gen_random_uuid(),
      email text unique
  );
  -- Stands in for Supabase's request-scoped auth.uid(). Tests set it with
  -- select set_config('request.jwt.claim.sub', '<uuid>', false);
  create or replace function auth.uid() returns uuid
  language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  $$;
  do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then
          create role authenticated;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'anon') then
          create role anon;
      end if;
  end $$;
`;

export async function freshDatabase({ schemaPath, quiet = true } = {}) {
  const db = await PGlite.create({ extensions: { pgcrypto, pg_trgm } });
  await db.exec(SUPABASE_SHIM);

  if (schemaPath) {
    // schema.sql runs verbatim — the same text that will be applied to
    // Supabase. If it is going to fail there, it fails here first.
    const sql = await readFile(schemaPath, 'utf8');
    await db.exec(sql);
  }
  if (!quiet) {
    const v = await one(db, 'select version()');
    console.log(`  ${String(v).split(',')[0]}`);
  }
  return { db };
}

/** Convenience: run a query and return rows. */
export async function rows(db, sql, params) {
  const res = params ? await db.query(sql, params) : await db.query(sql);
  return res.rows;
}

/** Convenience: run a query and return the single value of the single row. */
export async function one(db, sql, params) {
  const r = await rows(db, sql, params);
  if (r.length === 0) return null;
  return Object.values(r[0])[0];
}
