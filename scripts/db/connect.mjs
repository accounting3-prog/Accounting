/**
 * Connection to the live Supabase Postgres.
 *
 * Credentials come from .env, which is gitignored and never committed.
 *
 * Notes on this project's connection:
 *   - The direct host db.<ref>.supabase.co is IPv6-only, so we go through the
 *     Supavisor pooler instead.
 *   - Only port 6543 (transaction mode) authenticates on this project; 5432
 *     (session mode) is refused. Transaction mode does not keep session state
 *     between statements, so anything needing a session — advisory locks,
 *     SET LOCAL across calls, prepared statements — must be avoided or kept
 *     inside a single explicit transaction.
 */

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const DEPS = process.env.LEDGER_DEPS;
if (!DEPS) throw new Error('set LEDGER_DEPS to the directory holding node_modules');

const pg = await import(pathToFileURL(path.join(DEPS, 'node_modules/pg/lib/index.js')).href);
const { Client } = pg.default ?? pg;

/** Minimal .env reader — no dependency, no export of values anywhere. */
export async function loadEnv(file = '.env') {
  const text = await readFile(file, 'utf8');
  const env = {};
  // Split on \r?\n, not \n: JavaScript treats \r as a line terminator, so `.`
  // will not match it and a trailing \r from CRLF endings stops `$` anchoring.
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;          // comment or blank
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

export async function connect({ envFile = '.env' } = {}) {
  const env = await loadEnv(envFile);
  const missing = ['PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE']
    .filter((k) => !env[k]);
  if (missing.length) throw new Error(`.env is missing ${missing.join(', ')}`);

  const client = new Client({
    host: env.PGHOST,
    port: 6543,                 // transaction mode; 5432 is not open here
    user: env.PGUSER,
    password: env.PGPASSWORD,
    database: env.PGDATABASE,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 30000,
    statement_timeout: 120000,
  });
  await client.connect();
  return client;
}

/** Rows from a query. */
export async function q(client, sql, params) {
  const r = await client.query(sql, params);
  return r.rows;
}

/** The single value of the single row, or null. */
export async function scalar(client, sql, params) {
  const rows = await q(client, sql, params);
  return rows.length ? Object.values(rows[0])[0] : null;
}
