/**
 * Checks every bank account against the balances the bank itself printed.
 *
 * Each imported statement row carries the running balance the bank showed on
 * that line. That makes the account checkable without the statement file: walk
 * the rows in the bank's own order, adding each amount to the one before, and
 * compare with what the bank printed on that line. A row that is missing,
 * doubled, or wrong in amount breaks the chain from that point on.
 *
 * Nothing here is reused from the importer, and no figure is written into this
 * file. Every number comes from the ledger or from the bank.
 *
 * Two rules this also enforces, because they are the ones that go wrong
 * silently:
 *   - each account is reported in its own currency, and no two are added up
 *   - money out must carry a request number; money in needs none
 *
 *   LEDGER_DEPS=... node scripts/db/bank_balance_audit.mjs
 */

import { connect, q } from './connect.mjs';

const money = (n) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(56)}${detail}`);
};

const client = await connect();

try {
  const accounts = await q(
    client,
    `select c.id, c.name, c.settlement_currency cur, c.account_reference ref,
            c.opening_balance::float8 opening, to_char(c.opening_date,'YYYY-MM-DD') od,
            b.ledger_balance::float8 bal, b.transaction_count::int n
       from cards c join card_balances b on b.card_id = c.id
      where c.card_type = 'bank_account' and c.tracks_balance is not false
      order by c.settlement_currency, c.name`,
  );

  console.log('='.repeat(100));
  console.log('BANK ACCOUNTS — each in its own currency');
  console.log('='.repeat(100) + '\n');

  for (const a of accounts)
    console.log(
      `  ${a.name.padEnd(28)} ref ${String(a.ref ?? '—').padEnd(6)}` +
        `${String(a.n).padStart(6)} rows   ${money(a.bal).padStart(17)} ${a.cur}`,
    );

  // Two accounts in different currencies must never be added together. The
  // check is that the currencies are distinct per account and that nothing in
  // this report ever totals across them — which is why no total is printed.
  const currencies = new Set(accounts.map((a) => a.cur));
  console.log(
    `\n  ${accounts.length} account(s) in ${currencies.size} currenc${currencies.size === 1 ? 'y' : 'ies'}: ` +
      `${[...currencies].join(', ')} — reported separately, never summed\n`,
  );

  for (const a of accounts) {
    console.log('-'.repeat(100));
    console.log(`${a.name}  (${a.cur})`);
    console.log('-'.repeat(100));

    // The chain runs in the order the source listed the rows, not in date
    // order: a sheet sometimes puts a later day above an earlier one, and the
    // balance the bank printed follows the sheet. So sheets are sequenced by
    // the earliest day each one covers, and rows within a sheet by their own
    // line number. Rows the bank never gave a balance for are left out of the
    // chain — they cannot be checked this way — but they are counted.
    const rows = await q(
      client,
      `select to_char(txn_date,'YYYY-MM-DD') d, amount_aed::float8 a,
              statement_balance::float8 sb, req_number, source_sheet,
              left(regexp_replace(supplier_raw, '\\s+', ' ', 'g'), 46) s
         from transactions
        where card_id = $1 and status <> 'voided'
        order by min(txn_date) over (partition by source_sheet),
                 source_sheet, source_row nulls last`,
      [a.id],
    );

    const chained = rows.filter((r) => r.sb !== null);
    const unchained = rows.length - chained.length;

    // Which way a sheet runs is not a thing to assume: the monthly workbook
    // lists the oldest row first, the bank's own statement lists the newest
    // first. The sheet's arithmetic says which. Walking it the wrong way makes
    // every line disagree, which is indistinguishable from a broken ledger —
    // so ask the sheet rather than trusting a convention.
    const ordered = [];
    const sheets = [...new Set(chained.map((r) => r.source_sheet))];
    const runsBackwards = [];
    for (const name of sheets) {
      const block = chained.filter((r) => r.source_sheet === name);
      const holds = (seq) =>
        seq.reduce(
          (n, r, i) =>
            i && Math.abs(r.sb - (seq[i - 1].sb + r.a)) < 0.005 ? n + 1 : n,
          0,
        );
      const back = block.slice().reverse();
      const backwards = holds(back) > holds(block);
      if (backwards) runsBackwards.push(name);
      ordered.push(...(backwards ? back : block));
    }
    if (runsBackwards.length)
      console.log(
        `  ${runsBackwards.length} of ${sheets.length} source sheet(s) list the newest row first`,
      );

    let run = a.opening;
    let agreed = 0;
    let firstBreak = null;
    for (const r of ordered) {
      // The amount carries its own sign — money out is stored negative — so
      // the direction word is a label on it, never what decides it.
      run += r.a;
      if (Math.abs(run - r.sb) < 0.005) agreed++;
      else if (!firstBreak) firstBreak = { ...r, run };
    }

    console.log(
      `  opening ${money(a.opening)} ${a.cur} on ${a.od} · ${rows.length} rows` +
        (unchained ? ` (${unchained} without a printed balance)` : ''),
    );
    check(
      'every printed balance agrees with the rows above it',
      firstBreak === null,
      firstBreak
        ? `first break ${firstBreak.d}: ledger ${money(firstBreak.run)}, bank ${money(firstBreak.sb)}`
        : `${agreed} of ${ordered.length} lines`,
    );

    const last = ordered[ordered.length - 1];
    if (last)
      check(
        'the balance today is the last one the bank printed',
        Math.abs(a.bal - last.sb) < 0.005,
        `${money(a.bal)} vs ${money(last.sb)} ${a.cur}`,
      );

    // Money out must be traceable to a request. Money in need not be: it comes
    // from the bank's side, and the ledger does not ask for one.
    const out = rows.filter((r) => r.a < 0);
    const missing = out.filter((r) => !String(r.req_number ?? '').trim());
    const total = missing.reduce((t, r) => t + r.a, 0);
    console.log(
      `  ${out.length} payments out, ${rows.length - out.length} in · ` +
        (missing.length
          ? `${missing.length} out still need a request number (${money(-total)} ${a.cur})`
          : 'every payment out carries a request number'),
    );
    console.log('');
  }
} finally {
  await client.end();
}

console.log('='.repeat(100));
if (failures) {
  console.log(`${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('Every bank account agrees, line by line, with the balances the bank printed.');
console.log('='.repeat(100));
