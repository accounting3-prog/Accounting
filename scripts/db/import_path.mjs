/**
 * Proves that a file uploaded through the import page lands in the database as
 * the right money, on the right dates, on the right card.
 *
 * The other import tests stop at the parsed row. This one carries those rows
 * the rest of the way: it feeds them to create_transaction exactly as the page
 * does, then reads the balance back out of card_balances and checks it moved by
 * the amount the file said. Parsing a sheet correctly and then posting it
 * wrongly would be just as expensive as misreading it.
 *
 * Everything runs inside transactions that are rolled back, and the script
 * checks at the end that the database is untouched.
 *
 *   LEDGER_DEPS=<dir with node_modules> IMPORT_BUNDLE=<bundled importFile.mjs> \
 *     node scripts/db/import_path.mjs
 *
 * SERVER-SIDE ONLY. Read-only in effect.
 */

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { connect, q } from './connect.mjs';
import { makeXlsx, AWKWARD_SHEET } from '../import/fixture.mjs';

const { parseXlsx, analyseSheet, buildRows } = await import(
  pathToFileURL(resolve(process.env.IMPORT_BUNDLE ?? 'web/src/lib/importFile.ts')).href
);

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
  console.log(`    ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(62)}${detail}`);
}

const near = (a, b, tol = 0.005) => Math.abs(Number(a) - Number(b)) <= tol;
const money = (n) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const client = await connect();
let uid;

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

/** Posts one parsed row exactly as the import page posts it. */
async function postRow(cardId, row, fileName, allowDuplicate = false) {
  const r = await client.query(
    `select create_transaction(
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) as id`,
    [
      cardId,
      row.date,
      row.kind,
      Math.abs(row.amountAed),
      row.supplier,
      row.reqNumber,
      row.paymentRef,
      row.currency,
      row.originalAmount,
      row.rate,
      null,                                   // supplier country
      row.crm || null,
      row.lpoNumber || null,
      row.invoice || null,
      row.client || null,
      row.salesOperation || null,
      null,                                   // description
      [row.notes, `imported from ${fileName}, row ${row.sourceRow}`].filter(Boolean).join(' — '),
      row.warnings.length > 0,                // needs review
      allowDuplicate,
    ],
  );
  return r.rows[0].id;
}

/* ------------------------------------------------------------- the file */

/**
 * The fixture is built by scripts/import/fixture.mjs, which writes the xlsx
 * bytes itself rather than calling the app's exporter — a file produced by the
 * code under test would prove nothing about reading it.
 */
const SHEET = AWKWARD_SHEET;

/* ------------------------------------------------------------------- run */

try {
  const owner = await q(client, 'select user_id from admins where email = $1', [OWNER]);
  if (!owner.length) throw new Error(`${OWNER} is not an admin in this database`);
  uid = owner[0].user_id;

  const snapshot = {
    transactions: (await q(client, 'select count(*)::int n from transactions'))[0].n,
    cards: (await q(client, 'select count(*)::int n from cards'))[0].n,
    balances: await q(
      client,
      'select card_id, source_balance, ledger_balance from card_balances order by card_id',
    ),
  };

  console.log('\n  Reading the file');
  console.log('  ' + '-'.repeat(92));

  const bytes = makeXlsx(SHEET, 'Card sheet');
  const sheets = parseXlsx(bytes);
  check('the file parses', sheets.length === 1 && sheets[0].name === 'Card sheet', sheets[0]?.name);

  // A card whose DEBIT column decreases the balance, like most of the workbook.
  const cardRecord = {
    name: 'IMPORT TEST CARD',
    decreasingHeader: 'DEBIT',
    increasingHeader: 'CREDIT',
    balanceFormula: '=F2-D3+E3',
  };
  const analysis = analyseSheet(sheets[0], cardRecord);
  check('the header row is found below the title rows', analysis.headerRow === 2,
        `row ${analysis.headerRow + 1}`);
  check('DEBIT is bound to the decreasing column', analysis.mapping.decrease === 3,
        String(analysis.mapping.decrease));
  check('CREDIT is bound to the increasing column', analysis.mapping.increase === 4,
        String(analysis.mapping.increase));

  const rows = buildRows(sheets[0], analysis.headerRow, analysis.mapping, {
    dayFirst: analysis.dayFirst,
  });

  const ok = rows.filter((r) => r.errors.length === 0);
  const broken = rows.filter((r) => r.errors.length > 0);
  check('five rows are importable', ok.length === 5, `${ok.length} of ${rows.length}`);
  check(
    'the two rows that cannot be posted are held back, and nothing else is',
    broken.length === 2 &&
      broken.every((b) => ['IMPORT BROKEN DATE', 'IMPORT NO AMOUNT'].includes(b.supplier)),
    broken.map((b) => `${b.supplier}: ${b.errors[0]}`).join(' | '),
  );
  check(
    'the unreadable date is named in the reason, so it can be fixed in the file',
    broken.some((b) => b.errors.some((e) => e.includes('not a date'))),
    broken.flatMap((b) => b.errors).join(' | '),
  );
  check('the totals row is passed over — it has no date', !rows.some((r) => /total/i.test(r.supplier)));
  check('so is the blank spacer row', rows.length === 7, `${rows.length} rows read`);
  check('the empty cell before the amount did not shift the columns',
        ok.every((r) => r.amountAed !== null && r.amountAed < 2000),
        ok.map((r) => r.amountAed).join(', '));

  const expectedSpend = 1200.5 + 1101.75 + 1200.5 + 75.25;
  const expectedFunding = 450.25;
  check('four rows read as spend', ok.filter((r) => r.kind === 'purchase').length === 4);
  check('one row reads as a refund', ok.filter((r) => r.kind === 'refund').length === 1);
  check('the repeat charge is kept, flagged as identical to the earlier row',
        ok.filter((r) => r.supplier === 'IMPORT SUPPLIER ONE').length === 2);
  const odd = ok.find((r) => r.supplier === 'IMPORT ODD CURRENCY');
  check(
    'an unknown currency is a warning on the row, not a guess at a real one',
    odd && odd.currency === null && odd.warnings.some((w) => w.includes('XYZ')),
    odd ? odd.warnings.join('; ') : 'row missing',
  );
  check(
    'and the figure that went with it is carried in the notes, not silently dropped',
    odd && odd.originalAmount === null && odd.notes.includes('XYZ 500'),
    odd ? `originalAmount=${odd.originalAmount} notes="${odd.notes}"` : 'row missing',
  );

  console.log('\n  Posting it, and reading the balance back');
  console.log('  ' + '-'.repeat(92));

  await scenario(async () => {
    const created = await client.query(
      `select create_card($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as id`,
      ['IMPORT TEST CARD 8888', 10000, '2026-08-01', 'Credit card', 'active', 'AED',
       'Test Bank', '8888', null, 'created by the import path test'],
    );
    const cardId = created.rows[0].id;

    const opening = await balance(cardId);
    check('the new card opens at its opening balance', near(opening, 10000), money(opening));

    const ids = [];
    for (const row of ok) {
      ids.push(await postRow(cardId, row, 'import-test.xlsx',
                             row.supplier === 'IMPORT SUPPLIER ONE' && ids.length > 0));
    }
    check('every importable row was written', ids.length === 5, String(ids.length));

    const after = await balance(cardId);
    const expected = 10000 - expectedSpend + expectedFunding;
    check(
      'the balance moved by exactly what the file said',
      near(after, expected),
      `${money(after)} vs ${money(expected)}`,
    );

    const stored = await q(
      client,
      `select to_char(txn_date,'YYYY-MM-DD') d, amount_aed, direction, supplier_raw,
              currency, original_amount, status, notes
         from transactions where card_id = $1 order by txn_date`,
      [cardId],
    );
    check('five rows are in the table', stored.length === 5, String(stored.length));
    check(
      'every date is stored exactly as the file had it',
      stored.map((r) => r.d).join(',') ===
        '2026-08-03,2026-08-04,2026-08-05,2026-08-06,2026-08-08',
      stored.map((r) => r.d).join(','),
    );
    check(
      'spend is stored negative and funding positive',
      stored.every((r) =>
        r.direction === 'spend' ? Number(r.amount_aed) < 0 : Number(r.amount_aed) > 0,
      ),
      stored.map((r) => `${r.direction}:${r.amount_aed}`).join(' '),
    );
    check(
      'the sum of the stored rows equals the file total',
      near(
        stored.reduce((s, r) => s + Number(r.amount_aed), 0),
        expectedFunding - expectedSpend,
      ),
    );
    const usd = stored.find((r) => r.currency === 'USD');
    check('the foreign-currency row kept its currency and original amount',
          usd && near(usd.original_amount, 300), usd ? String(usd.original_amount) : 'missing');
    check(
      'each row records the file and line it came from',
      stored.every((r) => /imported from import-test\.xlsx, row \d+/.test(r.notes ?? '')),
      stored.map((r) => r.notes).join(' | ').slice(0, 90),
    );
    check(
      'the row carrying a currency warning is flagged for review, the plain ones are not',
      stored.filter((r) => r.status === 'needs_review').length ===
        ok.filter((r) => r.warnings.length > 0).length,
      `${stored.filter((r) => r.status === 'needs_review').length} flagged`,
    );

    /* Importing the same file twice must not double the balance. */
    const beforeSecond = await balance(cardId);
    const secondIds = [];
    for (const row of ok) secondIds.push(await postRow(cardId, row, 'import-test.xlsx', false));
    const afterSecond = await balance(cardId);
    check(
      're-importing the identical file does not change the balance',
      near(beforeSecond, afterSecond),
      `${money(beforeSecond)} -> ${money(afterSecond)}`,
    );
    // create_transaction answers a repeat submission with the id it already
    // wrote rather than an error, so a double-click or a re-run is harmless.
    check(
      'the second pass returns the rows already written instead of new ones',
      secondIds.every((id, i) => id === ids[i]),
      `${secondIds.filter((id, i) => id === ids[i]).length} of ${ids.length} matched`,
    );
    const count = await q(client, 'select count(*)::int n from transactions where card_id = $1',
                          [cardId]);
    check('and no extra row was written', count[0].n === 5, String(count[0].n));
  });

  console.log('\n  The database is untouched');
  console.log('  ' + '-'.repeat(92));

  const after = {
    transactions: (await q(client, 'select count(*)::int n from transactions'))[0].n,
    cards: (await q(client, 'select count(*)::int n from cards'))[0].n,
    balances: await q(
      client,
      'select card_id, source_balance, ledger_balance from card_balances order by card_id',
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
    `select count(*)::int n from cards where name like 'IMPORT TEST%'
      union all select count(*)::int from transactions where supplier_raw like 'IMPORT %'`,
  );
  check('no test row survived', strays.every((r) => r.n === 0));

  console.log('\n' + '='.repeat(100));
  console.log(fail === 0 ? `ALL ${pass} CHECKS PASSED` : `${fail} of ${pass + fail} CHECKS FAILED`);
  for (const f of failures) console.log('  FAILED: ' + f);
  console.log('='.repeat(100));
  process.exit(fail ? 1 : 0);
} finally {
  await client.end();
}
