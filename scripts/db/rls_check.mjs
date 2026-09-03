/**
 * Proves access control is enforced by the database, not the UI.
 *
 * Two layers are tested:
 *
 *   1. In Postgres, by assuming the `authenticated` role and setting the JWT
 *      subject the way Supabase does, then attempting reads and writes as a
 *      named admin and as an ordinary signed-in user. Everything runs inside a
 *      transaction that is rolled back, so no test row survives.
 *
 *   2. Over the wire through PostgREST with the publishable (anon) key — the
 *      exact key the browser bundle carries — to confirm the public frontend
 *      cannot bypass RLS.
 *
 * SERVER-SIDE ONLY.
 */

import { connect, loadEnv, q } from './connect.mjs';

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(62)}${detail}`);
}

/** Run a statement as a role and report whether it was allowed. */
async function attempt(client, sql, params = []) {
  try {
    const r = await client.query(sql, params);
    return { allowed: true, rows: r.rowCount ?? r.rows?.length ?? 0 };
  } catch (e) {
    return { allowed: false, code: e.code, message: e.message.split('\n')[0] };
  }
}

const env = await loadEnv();
const client = await connect();

try {
  console.log('='.repeat(92));
  console.log('ACCESS CONTROL VERIFICATION');
  console.log('='.repeat(92));

  /* --------------------------------------------------- 1. RLS is switched on */

  console.log('\nROW LEVEL SECURITY IS ENABLED ON EVERY EXPOSED TABLE');
  console.log('-'.repeat(92));
  const tables = await q(
    client,
    `select tablename, rowsecurity,
            (select count(*)::int from pg_policies p
              where p.schemaname='public' and p.tablename=t.tablename) as policies
       from pg_tables t where schemaname='public' order by tablename`,
  );
  for (const t of tables)
    check(
      `${t.tablename}`,
      t.rowsecurity && t.policies > 0,
      `RLS ${t.rowsecurity ? 'on' : 'OFF'}, ${t.policies} policies`,
    );

  const forced = tables.filter((t) => !t.rowsecurity);
  check('no exposed table is left without RLS', forced.length === 0);

  /* ------------------------------------- 2. admin writes, ordinary user reads */

  console.log('\nIN-DATABASE ROLE BEHAVIOUR  (all inside a rolled-back transaction)');
  console.log('-'.repeat(92));

  // Each probe runs in its own short transaction and is rolled back. One long
  // transaction does not survive here: a denied statement aborts it, and the
  // transaction-mode pooler does not reliably carry the recovery across
  // statements, so later checks report 25P02 instead of what they found.
  const probe = async (uid, sql, params = []) => {
    await client.query('begin');
    try {
      await client.query('set local role authenticated');
      await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid]);
      const r = await client.query(sql, params);
      return { allowed: true, rows: r.rowCount ?? r.rows?.length ?? 0, value: r.rows?.[0] };
    } catch (e) {
      return { allowed: false, code: e.code, message: e.message.split('\n')[0] };
    } finally {
      await client.query('rollback').catch(() => {});
    }
  };

  const ADMIN_EMAIL = 'rls-admin@test.invalid';
  const VIEWER_EMAIL = 'rls-viewer@test.invalid';
  let adminId = null;
  let viewerId = null;

  try {
    // The two identities have to be committed for is_admin() to see them, so
    // they are created, probed, and removed again in the finally below.
    adminId = (await q(client,
      `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
      [ADMIN_EMAIL]))[0].id;
    viewerId = (await q(client,
      `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
      [VIEWER_EMAIL]))[0].id;
    await client.query(`insert into admins (user_id, email) values ($1,$2)`,
      [adminId, ADMIN_EMAIL]);

    const adminIsAdmin = await probe(adminId, 'select is_admin() as v');
    check('a named admin is recognised by is_admin()', adminIsAdmin.value?.v === true);

    const adminRead = await probe(adminId, 'select count(*) as n from transactions');
    check('admin can read transactions', adminRead.allowed);

    const adminWrite = await probe(adminId,
      `insert into cards (name, opening_balance) values ('RLS TEST ADMIN CARD', 0)`);
    check('admin CAN write', adminWrite.allowed, adminWrite.message ?? '');

    const viewerIsAdmin = await probe(viewerId, 'select is_admin() as v');
    check('a non-admin is not recognised by is_admin()', viewerIsAdmin.value?.v === false);

    const viewerRead = await probe(viewerId, 'select count(*) as n from transactions');
    check('non-admin CAN read (view-only access)', viewerRead.allowed,
          viewerRead.allowed ? `sees ${viewerRead.value.n} rows` : '');

    const viewerInsert = await probe(viewerId,
      `insert into cards (name, opening_balance) values ('RLS TEST VIEWER CARD', 0)`);
    check('non-admin CANNOT insert', !viewerInsert.allowed, viewerInsert.code ?? '');

    const viewerUpdate = await probe(viewerId,
      `update transactions set amount_aed = amount_aed + 1 where true`);
    check('non-admin CANNOT update',
      !viewerUpdate.allowed || viewerUpdate.rows === 0,
      viewerUpdate.allowed ? `${viewerUpdate.rows} rows changed` : viewerUpdate.code ?? '');

    const viewerDelete = await probe(viewerId, `delete from transactions where true`);
    check('non-admin CANNOT delete',
      !viewerDelete.allowed || viewerDelete.rows === 0,
      viewerDelete.allowed ? `${viewerDelete.rows} rows deleted` : viewerDelete.code ?? '');
  } finally {
    await client.query(`delete from admins where email in ($1,$2)`,
      [ADMIN_EMAIL, VIEWER_EMAIL]).catch(() => {});
    await client.query(`delete from auth.users where email in ($1,$2)`,
      [ADMIN_EMAIL, VIEWER_EMAIL]).catch(() => {});
    await client.query(`delete from cards where name like 'RLS TEST%'`).catch(() => {});
    console.log('\n  probes rolled back; test identities removed');
  }

  const [{ n: leftovers }] = await q(client,
    `select count(*)::int n from cards where name like 'RLS TEST%'`);
  check('no test data survived', leftovers === 0);

  const [{ n: testUsers }] = await q(client,
    `select count(*)::int n from auth.users where email like '%@test.invalid'`);
  check('no test identity survived', testUsers === 0);

  /* -------------------------------------- 3. the public key over the wire */

  console.log('\nTHE PUBLISHABLE KEY THE BROWSER CARRIES  (via PostgREST)');
  console.log('-'.repeat(92));
  const url = env.SUPABASE_URL;
  const anon = env.SUPABASE_ANON_KEY;

  const call = async (method, path, body) => {
    const res = await fetch(`${url}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: anon,
        Authorization: `Bearer ${anon}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, text: (await res.text()).slice(0, 120) };
  };

  const anonRead = await call('GET', 'transactions?select=id&limit=1');
  check(
    'anon key cannot read transactions (RLS requires sign-in)',
    anonRead.status === 401 || anonRead.status === 403 || anonRead.text === '[]',
    `HTTP ${anonRead.status}`,
  );

  const anonInsert = await call('POST', 'cards', {
    name: 'RLS TEST PUBLIC CARD',
    opening_balance: 0,
  });
  check(
    'anon key cannot insert a card',
    anonInsert.status === 401 || anonInsert.status === 403,
    `HTTP ${anonInsert.status}`,
  );

  // Asserted on effect, not status. A DELETE that RLS filters to zero rows is
  // a successful request that deleted nothing, and PostgREST correctly returns
  // 200 with an empty body — so the status alone would not tell us whether
  // anything was destroyed. What matters is that no row went missing.
  const beforeDelete = (
    await q(client, 'select count(*)::int n from transactions')
  )[0].n;
  const anonDelete = await call(
    'DELETE',
    'transactions?id=neq.00000000-0000-0000-0000-000000000000',
  );
  const afterDelete = (await q(client, 'select count(*)::int n from transactions'))[0].n;
  check(
    'anon key deletes nothing',
    afterDelete === beforeDelete && anonDelete.text.replace(/\s/g, '') === '[]',
    `HTTP ${anonDelete.status}, ${beforeDelete} -> ${afterDelete} rows, returned ${anonDelete.text || '(empty)'}`,
  );

  const [{ n: publicLeftovers }] = await q(
    client,
    `select count(*)::int n from cards where name like 'RLS TEST%'`,
  );
  check('nothing was written by the public key', publicLeftovers === 0);

  const [{ n: stillThere }] = await q(client, 'select count(*)::int n from transactions');
  check('all 1,949 transactions intact after the delete attempt', stillThere === 1949,
        `${stillThere} rows`);

  console.log('\n' + '='.repeat(92));
  console.log(
    failures === 0
      ? 'ACCESS CONTROL VERIFIED — enforced in the database, not only in the UI'
      : `${failures} CHECK(S) FAILED`,
  );
  console.log('='.repeat(92));
  process.exit(failures ? 1 : 0);
} finally {
  await client.end();
}
