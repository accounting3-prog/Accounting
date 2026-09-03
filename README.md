# Multi-Currency Card Ledger

Reconciliation and audit system for spend across seven payment cards in 28
currencies, all settled in AED.

The source of truth is `2026 Cards Monitoring.xlsx` — **read-only input**.
Nothing in this repository writes back to it.

## Current state

| Stage | Status |
|---|---|
| Workbook audit (independent, from first principles) | 0 disagreements, 0 blocking findings |
| Extraction | 1,948 transactions + 1 adjustment, 1,946 balances verified |
| Database schema + 3 migrations | applied to the live Supabase project |
| Live import | 7 cards, 702 suppliers, 1,949 transactions, 19 anomalies |
| Idempotency | re-import inserts nothing |
| Independent SQL verification | raw SQL, the view and the extraction all agree |
| Restore test | 78,917 field comparisons |
| Simulations | 109 checks across 7 cards |
| Access control | RLS proven in-database and over the wire |
| Frontend | builds clean, reads live, exports CSV/XLSX |

## Layout

```
scripts/extract.py       Workbook -> normalised ledger. Dry-run only.
scripts/audit.py         Independent re-audit. Shares no code with extract.py.
scripts/make_sample.py   Generates the frontend's sample data.
scripts/db/import.mjs    Dry-run and live import, with rollback snapshot.
scripts/db/verify.mjs    Three-way independent verification.
scripts/db/simulate.mjs  Per-card transaction simulations, rolled back.
scripts/db/restore_test.mjs  Backup and restore, column-for-column.
scripts/db/rls_check.mjs Access-control proof.
supabase/schema.sql      Schema, views, RLS policies.
supabase/migrations/     Applied in numeric order after schema.sql.
tests/test_ledger.py     35 tests over the extraction and balance math.
web/                     React 19 + TypeScript + Vite + Tailwind frontend.
```

## Financial rules the system enforces

1. **Direction comes from each sheet's own balance formula, never its headers.**
   Three sheets label the balance-decreasing column `CREDIT`. Verified two
   independent ways and by replaying all 1,946 cached balances.
2. **Balances are computed, never stored.** `card_balances` is a view over
   opening balance plus transactions on or after the card's opening date.
3. **Currencies are never added together.** Spend is reported one row per
   currency with no grand total; the only cross-card figure is AED settlement.
4. **Nothing is guessed.** An unreadable currency, date or rate is left null,
   flagged `needs_review`, and stays searchable.
5. **Dedup includes direction and an occurrence number.** A payment and its
   refund never merge; 130 genuine repeat charges never collapse.
6. **Every repair keeps its original.** 17 transposed dates carry
   `source_date_raw`, `date_repaired` and a note saying what changed.

### The two cards where the workbook and the ledger disagree

**AMEX 3024 (3016- COR)** — FLYNAS RIYADH sits in the sheet with an amount but
no balance formula, so the workbook's own chain excludes it. It **does** count
in the official live balance, deducted exactly once:

| | |
|---|---:|
| Source workbook formula-chain balance | 25,474.74 AED |
| FLYNAS RIYADH | −8,745.78 AED |
| **Official live ledger balance** | **16,728.96 AED** |
| Reconciliation difference | 8,745.78 AED |

`7,983.18` is the result of deducting FLYNAS twice. It is invalid, and
`scripts/db/verify.mjs` scans every balance figure in the system to prove it
appears nowhere.

**RAK 9825 (6071)** — the balance at row 26 was typed over the formula, leaving
1,718.02 AED with no transaction behind it. It is held as a labelled
`reconciliation_adjustment` with no direction, so it cannot fall inside a spend
or funding total, and stays `needs_review` until a real transaction replaces it.

| | |
|---|---:|
| Source workbook balance | 165.72 AED |
| Ledger excluding the unconfirmed adjustment | −1,552.30 AED |
| Review adjustment | +1,718.02 AED |

### Exchange rates

The workbook's conversion cells divide the AED figure by a denominator typed
into the formula, which on six rows differs slightly from the amount stated in
the currency cell. Rather than correct the source:

- `exchange_rate` and `exchange_rate_formula` keep the workbook's own values.
- `normalized_exchange_rate` holds AED settlement ÷ original amount — the rate
  the transaction actually settled at. Use this for reporting.
- `rate_review_note` carries a visible explanation, shown in the transaction
  detail and the review queue.
- A missing currency code is never invented. A row with a conversion formula is
  never classified as native AED, and no AED row may carry a rate (enforced by
  a check constraint).

## Local setup

```bash
cd web && npm install
```

```bash
npm run dev
```

Opens on http://localhost:5173. With no environment variables the app runs on
the audited workbook extract, clearly labelled — every figure is real, so the UI
is reviewable before the backend is connected.

```bash
cp web/.env.example web/.env.local
```

### Server-side tooling

The importer, verifier, simulations and restore test read the database password
from a gitignored `.env` at the repository root, and need a directory holding
`node_modules`:

```bash
LEDGER_DEPS=/path/to/deps node scripts/db/verify.mjs
```

`.env` needs `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`,
`SUPABASE_URL` and `SUPABASE_ANON_KEY`. **Never** copy these into `web/` or
Vercel.

### Note on `node_modules`

Installing dependencies onto the Google shared drive silently truncates files to
zero bytes. If the repository lives on `G:\`, install and build from a local-disk
copy, or keep `node_modules` outside the synced folder.

## Supabase configuration

**1. Apply the schema and migrations, in order:**

```bash
LEDGER_DEPS=/path/to/deps node scripts/db/apply_schema.mjs
```

Then each file in `supabase/migrations/` in numeric order. `apply_schema.mjs`
refuses to run if its tables already exist, reporting row counts instead.

**2. Enable Google OAuth** — Supabase Dashboard → Authentication → Providers →
Google. Add these **Redirect URLs** under Authentication → URL Configuration:

| Environment | URL |
|---|---|
| Local development | `http://localhost:5173` |
| Vercel production | `https://<your-project>.vercel.app` |
| Vercel previews | `https://<your-project>-*.vercel.app` |

Set **Site URL** to the production URL.

**3. Create the first admin.** The `admins` table gates every write, and it
starts empty — so nobody can add a card or a transaction until someone is named
in it. Sign in through the app once so a row exists in `auth.users`, then:

```sql
insert into admins (user_id, email)
select id, email from auth.users where email = 'you@example.com';
```

Run that in the Supabase SQL editor. After that, the app's admin can add further
admins the same way. Everyone else who signs in is view-only, enforced by RLS.

## Import, backup and restore

**Always dry-run first.** It performs the full validation and reports exactly
what would be inserted, skipped, flagged or rejected, and writes nothing:

```bash
LEDGER_DEPS=/path/to/deps node scripts/db/import.mjs --dry-run
```

```bash
LEDGER_DEPS=/path/to/deps node scripts/db/import.mjs --live
```

A live run takes a rollback snapshot into `import_batches.snapshot` before its
first write. Re-running is idempotent: `dedup_key` is unique and a row already
present is skipped, so importing the same workbook twice changes nothing.

**To restore from a snapshot**, read the JSON from the batch you want and replay
it. `scripts/db/restore_test.mjs` is the working reference — it restores in
dependency order (cards, suppliers, transactions), excludes generated columns
from the write, and compares column-for-column afterwards. Run it any time to
prove the procedure still works:

```bash
LEDGER_DEPS=/path/to/deps node scripts/db/restore_test.mjs
```

It uses a throwaway in-process PostgreSQL, so it never touches the live project.

**Verification and tests:**

```bash
LEDGER_DEPS=/path/to/deps node scripts/db/verify.mjs
```

```bash
LEDGER_DEPS=/path/to/deps node scripts/db/simulate.mjs
```

```bash
LEDGER_DEPS=/path/to/deps node scripts/db/rls_check.mjs
```

```bash
python tests/test_ledger.py
```

## Deploying to Vercel

1. **Import the repository** at vercel.com/new.
2. **Root Directory → `web`.** Required; the repository root has no frontend.
3. **Framework Preset → Vite.** Build `npm run build`, output `dist`.
4. **Environment variables**, all environments:

   | Name | Value |
   |---|---|
   | `VITE_SUPABASE_URL` | `https://<project-ref>.supabase.co` |
   | `VITE_SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_…` |

5. **Deploy**, then add the deployed URL to Supabase's redirect list (step 2 of
   Supabase configuration above).

`vercel.json` rewrites every path to `index.html` so client-side routes such as
`/cards/card-5` resolve on a cold load rather than 404ing.

### What must never go into Vercel

Anything prefixed `VITE_` is inlined into the JavaScript bundle every visitor
downloads. These bypass Row Level Security completely and belong only in the
server-side `.env`:

- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_SECRET_KEY`
- `DATABASE_URL`, `PGPASSWORD`

The publishable key is safe to ship precisely because RLS is enforced in the
database — an insert with it returns 401 unless the signed-in user is a named
admin.

## Access control

| Who | Can |
|---|---|
| Signed out | See the audited sample, clearly labelled. No live data. |
| Signed in | Read the whole ledger. |
| Named admin | Add cards, add transactions, resolve review items. |

Writes never go through a client insert. `create_transaction` and `create_card`
are `SECURITY DEFINER` functions that re-derive the transaction sign from its
type, recompute the dedup key, enforce required fields, and refuse any caller
not named in `admins` — so the rules hold even if the UI is bypassed.

## The seven cards

Names are the workbook sheet names, verbatim.

| Card | Txns | Source balance | Official live balance | Difference |
|---|---:|---:|---:|---:|
| MASTERCARD 5135 (4173) (7206) | 67 | 244,608.37 | 244,608.37 | — |
| RAK 8871 (8435)(0033) | 21 | 178,885.95 | 178,885.95 | — |
| AMEX 4000 VPAY | 1,370 | 599,536.31 | 599,536.31 | — |
| MASTERCARD 6404 VPAY | 458 | 127,930.85 | 127,930.85 | — |
| AMEX 3024 (3016- COR) | 3 | 25,474.74 | 16,728.96 | 8,745.78 |
| AMEX 2044 (2036- VIP) | 1 | 13,708.16 | 13,708.16 | — |
| RAK 9825 (6071) | 28 | 165.72 | −1,552.30 | 1,718.02 |
| **Total (AED)** | **1,948** | **1,190,310.10** | **1,179,846.30** | **10,463.80** |

## Open questions for the account owner

- **AMEX 3024 / FLYNAS RIYADH** — now counted in the official balance. Confirm
  it is a completed payment, or mark it voided.
- **RAK 9825 row 26** (+1,718.02 AED) — is there a transaction around
  2026-03-16 that was never entered?
- **18 rows flagged `needs_review`** — see the review queue in the app.
