# Multi-Currency Card Ledger

Reconciliation and audit system for spend across seven payment cards in 28
currencies, settled in AED.

The source of truth is `2026 Cards Monitoring.xlsx` — **read-only input**.
Nothing in this repo writes back to it.

## Current state

| Stage | Status |
|---|---|
| Workbook audit (independent, from first principles) | done — 0 disagreements, 0 blocking findings |
| Extraction to normalised JSON | done — 1,948 transactions, 1,946 balances verified |
| Database schema | done, applied to the live Supabase project |
| Test suite | done — 35 tests |
| Frontend | done — builds clean, runs on the audited sample data |
| Live Supabase importer | pending |
| Vercel deployment | ready to deploy |

## Layout

```
scripts/extract.py     Workbook -> normalised ledger. Dry-run only.
scripts/audit.py       Independent re-audit. Shares no code with extract.py.
scripts/make_sample.py Generates the frontend's sample data from the extraction.
scripts/db/            Schema application and connection to Supabase.
supabase/schema.sql    Postgres schema, views and RLS policies.
tests/test_ledger.py   35 tests. Run: python tests/test_ledger.py
web/                   React 19 + TypeScript + Vite + Tailwind frontend.
```

## Running the frontend locally

```bash
cd web && npm install
```

```bash
npm run dev
```

Opens on http://localhost:5173. With no environment variables set, the app runs
on the audited workbook extract — every figure on screen is real, so the UI is
fully reviewable before the backend is connected. The sidebar states which
source is in use.

To point it at Supabase, copy the example file and fill in the two public
values:

```bash
cp web/.env.example web/.env.local
```

To produce a production build:

```bash
cd web && npm run build
```

### Note on `node_modules`

Installing dependencies onto the Google shared drive silently truncates files
to zero bytes. If the repo lives on `G:\`, install and build from a local-disk
copy, or keep `node_modules` outside the synced folder.

## Deploying to Vercel

1. **Import the repository** at vercel.com/new, choosing `accounting3-prog/Accounting`.
2. **Root Directory** — set to `web`. This is required; the repository root has
   no frontend.
3. **Framework Preset** — Vite. Build command `npm run build`, output `dist`.
   Vercel infers all three once the root directory is set.
4. **Environment Variables** — add these two, for all environments:

   | Name | Value |
   |---|---|
   | `VITE_SUPABASE_URL` | `https://<project-ref>.supabase.co` |
   | `VITE_SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_…` |

5. **Deploy.**

`vercel.json` rewrites every path to `index.html` so client-side routes such as
`/cards/card-5` resolve on a cold load rather than 404ing.

### What must never go into Vercel

Anything prefixed `VITE_` is inlined into the JavaScript bundle that every
visitor downloads. These bypass Row Level Security completely and belong only
in the server-side `.env`, which is gitignored:

- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_SECRET_KEY`
- `DATABASE_URL`, `PGPASSWORD`

The publishable key is safe to ship precisely because RLS is enforced in the
database — an insert with it returns 401 unless the signed-in user is a named
admin.

## Running the audit and extraction

```bash
python scripts/audit.py --out scripts/out/audit.json
```

```bash
python scripts/extract.py --out scripts/out/normalised.json --anomalies scripts/out/anomalies.json
```

```bash
python tests/test_ledger.py
```

## The seven cards

Card names are the sheet names, verbatim.

| Card | Txns | Source balance | Ledger balance | Difference |
|---|---:|---:|---:|---:|
| MASTERCARD 5135 (4173) (7206) | 67 | 244,608.37 | 244,608.37 | 0.00 |
| RAK 8871 (8435)(0033) | 21 | 178,885.95 | 178,885.95 | 0.00 |
| AMEX 4000 VPAY | 1,370 | 599,536.31 | 599,536.31 | 0.00 |
| MASTERCARD 6404 VPAY | 458 | 127,930.85 | 127,930.85 | 0.00 |
| AMEX 3024 (3016- COR) | 3 | 25,474.74 | 16,728.96 | 8,745.78 |
| AMEX 2044 (2036- VIP) | 1 | 13,708.16 | 13,708.16 | 0.00 |
| RAK 9825 (6071) | 28 | 165.72 | −1,552.30 | 1,718.02 |

- **source_balance** — what the workbook itself shows.
- **ledger_balance** — real transactions only, no reconciliation plugs.
- **difference** — visible, never absorbed into spend or funding.

## Design rules

1. **Direction comes from each sheet's balance formula, never its headers.**
   Three sheets label the balance-decreasing column `CREDIT`. Verified two
   independent ways and by replaying all 1,946 cached balances.
2. **Nothing is guessed.** An unreadable currency, date or rate is left null,
   flagged `needs_review`, and stays searchable. Never dropped, never inferred.
3. **Balances are computed, never stored.** `card_balances` is a view.
4. **Dedup includes direction and an occurrence number.** A payment and its
   refund never merge; 130 genuine repeat charges never collapse.
5. **Every repair keeps its original.** 17 transposed dates carry
   `source_date_raw`, `date_repaired` and a note saying what changed.
6. **Currencies are never added together.** Spend is reported per currency with
   no grand total; the only cross-card figure is the AED settlement amount.

## Open questions for the account owner

- **AMEX 3024 / FLYNAS RIYADH** (row 5, −8,745.78 AED): in the workbook but
  absent from its balance formula. Completed, or voided?
- **RAK 9825 row 26** (+1,718.02 AED): balance manually overwritten. Is there a
  transaction around 2026-03-16 that was never entered?
- **17 rows flagged `needs_review`** — see `scripts/out/anomalies.json`.
