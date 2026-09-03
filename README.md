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
| Database schema | done — `supabase/schema.sql` |
| Test suite | done — 35 tests |
| Live Supabase importer | pending — needs a Supabase project |
| New-transaction form | pending |
| Repo + Supabase + Vercel provisioning | **blocked — no credentials available** |

## Layout

```
scripts/extract.py     Workbook -> normalised ledger. Dry-run only.
scripts/audit.py       Independent re-audit. Shares no code with extract.py.
supabase/schema.sql    Postgres schema, views and RLS policies.
tests/test_ledger.py   35 tests. Run: python tests/test_ledger.py
scripts/out/           Generated output (gitignored).
```

## Running

```bash
python scripts/audit.py   --out scripts/out/audit.json
python scripts/extract.py --out scripts/out/normalised.json --anomalies scripts/out/anomalies.json
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

## Open questions for the account owner

- **AMEX 3024 / FLYNAS RIYADH** (row 5, −8,745.78 AED): in the workbook but
  absent from its balance formula. Completed, or voided?
- **RAK 9825 row 26** (+1,718.02 AED): balance manually overwritten. Is there a
  transaction around 2026-03-16 that was never entered?
- **17 rows flagged `needs_review`** — see `scripts/out/anomalies.json`.
