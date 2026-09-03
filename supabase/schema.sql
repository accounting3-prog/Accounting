-- Multi-currency card ledger — schema
--
-- Designed from the real workbook (2026 Cards Monitoring.xlsx, 7 sheets,
-- 1,948 transactions), not ahead of it. Every column here exists because
-- something in the source needs somewhere to land without being reshaped.
--
-- The workbook itself is read-only input. Nothing in this system writes back
-- to it, and no source value is altered on the way in: where a value had to be
-- repaired to be usable (a transposed date), the original is kept alongside
-- the repair and the row is flagged as corrected.
--
-- Three facts drive the design:
--
--   1. These are credit accounts settled in AED. The running balance is in
--      AED on every sheet. A transaction may ORIGINATE in one of 28
--      currencies, but it settles to AED, and the AED figure is what moves
--      the balance. So the balance is single-currency; the original currency
--      is per-transaction detail that must never be summed across currencies.
--
--   2. Each sheet's balance formula defines its own direction, and two sheets
--      are inverted while a third has transposed headers. Direction is
--      resolved at import from the formula and stored, so no consumer has to
--      remember which way a given card runs.
--
--   3. The workbook's own balance and the true ledger balance are not the same
--      number on two cards. Rather than pick one, both are computed and the
--      difference between them is a first-class, visible figure.

begin;

create extension if not exists "pgcrypto";
create extension if not exists "pg_trgm";

-- ---------------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------------

-- Closed set. An import that meets a code outside this table leaves the
-- transaction's currency null and files an anomaly, rather than guessing.
create table currencies (
    code        text primary key check (code ~ '^[A-Z]{3}$'),
    name        text not null,
    minor_units smallint not null default 2
);

insert into currencies (code, name, minor_units) values
    ('AED','UAE Dirham',2),        ('USD','US Dollar',2),
    ('EUR','Euro',2),              ('GBP','Pound Sterling',2),
    ('SAR','Saudi Riyal',2),       ('JPY','Japanese Yen',0),
    ('EGP','Egyptian Pound',2),    ('CHF','Swiss Franc',2),
    ('TRY','Turkish Lira',2),      ('OMR','Omani Rial',3),
    ('QAR','Qatari Riyal',2),      ('BHD','Bahraini Dinar',3),
    ('KRW','South Korean Won',0),  ('MYR','Malaysian Ringgit',2),
    ('SGD','Singapore Dollar',2),  ('KWD','Kuwaiti Dinar',3),
    ('VND','Vietnamese Dong',0),   ('HKD','Hong Kong Dollar',2),
    ('MOP','Macanese Pataca',2),   ('JOD','Jordanian Dinar',3),
    ('INR','Indian Rupee',2),      ('ZAR','South African Rand',2),
    ('MAD','Moroccan Dirham',2),   ('SEK','Swedish Krona',2),
    ('CZK','Czech Koruna',2),      ('MUR','Mauritian Rupee',2),
    ('CAD','Canadian Dollar',2),   ('NZD','New Zealand Dollar',2);

-- ---------------------------------------------------------------------------
-- Cards
-- ---------------------------------------------------------------------------

create table cards (
    id                  uuid primary key default gen_random_uuid(),

    -- The sheet name, verbatim: 'MASTERCARD 5135 (4173) (7206)'. Kept whole
    -- because the parenthesised numbers are supplementary cards sharing the
    -- one balance, and splitting them would invent a structure the sheet
    -- does not have.
    name                text not null unique,

    settlement_currency text not null references currencies(code) default 'AED',

    opening_balance     numeric(18,2) not null,

    -- Nothing before this date is charged against this card. Set to the date
    -- of the card's first transaction, so the historical import counts in
    -- full. Null means count everything.
    opening_date        date,

    -- How the source sheet ran its arithmetic, preserved so any figure can be
    -- traced back to the cell it came from.
    source_sheet        text,
    source_header_row   smallint,
    decreasing_column   text,   -- the column that reduces the balance
    decreasing_header   text,   -- what that column was *labelled* — on three
                                -- sheets this reads 'CREDIT' and is misleading
    increasing_column   text,
    increasing_header   text,
    balance_formula     text,   -- e.g. '=F3+D4-E4'

    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

comment on column cards.decreasing_header is
    'The source sheet''s own label for the spend column. On AMEX 4000 VPAY, '
    'AMEX 3024 and AMEX 2044 this says CREDIT while the column reduces the '
    'balance. Retained for traceability; never used to determine direction.';

-- ---------------------------------------------------------------------------
-- Suppliers
-- ---------------------------------------------------------------------------

-- Card statements append the merchant's ISO-3166 numeric country code to the
-- name ('GALLUP 840'). Split out, or 'GALLUP 840' and 'GALLUP 784' are two
-- different suppliers. 703 raw names collapse to 687 once split.
create table suppliers (
    id           uuid primary key default gen_random_uuid(),
    name         text not null,
    country_code text check (country_code ~ '^[0-9]{3}$'),
    created_at   timestamptz not null default now(),
    unique (name, country_code)
);

create index suppliers_name_trgm on suppliers using gin (name gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Import batches — every write is attributable and reversible
-- ---------------------------------------------------------------------------

create table import_batches (
    id             uuid primary key default gen_random_uuid(),
    source         text not null,          -- filename, or 'manual entry'
    source_sha256  text,                   -- identifies a re-uploaded file
    parser         text,                   -- which format parser ran
    dry_run        boolean not null default true,
    row_count      integer not null default 0,
    inserted_count integer not null default 0,
    skipped_count  integer not null default 0,
    anomaly_count  integer not null default 0,
    snapshot       jsonb,                  -- rollback snapshot taken pre-write
    imported_by    uuid references auth.users(id),
    created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Transactions
-- ---------------------------------------------------------------------------

create type txn_direction as enum ('spend', 'funding');

-- A reconciliation_adjustment is not a transaction that happened. It is the
-- named, visible difference between what the workbook asserts and what its own
-- arithmetic produces. Keeping it a distinct entry type is what stops it being
-- absorbed into spend or funding totals.
create type txn_entry_type as enum ('source_transaction', 'reconciliation_adjustment');

create type txn_status as enum (
    'confirmed',                     -- read cleanly, part of the live balance
    'needs_review',                  -- something about it could not be trusted
    'excluded_from_source_balance',  -- in the workbook, absent from its balance
    'voided'                         -- confirmed as not a real charge
);

create table transactions (
    id              uuid primary key default gen_random_uuid(),
    card_id         uuid not null references cards(id) on delete restrict,

    entry_type      txn_entry_type not null default 'source_transaction',
    status          txn_status     not null default 'confirmed',
    review_reason   text,            -- why this row is not plain 'confirmed'
    description     text,            -- set for adjustments; else the sheet speaks

    -- Dates ----------------------------------------------------------------
    -- txn_date is the single sortable date used for ordering and reporting.
    txn_date        date,
    -- The cell exactly as the workbook holds it, so the repair is auditable
    -- and the original is never lost: '16/1/2026', or '2026-05-01 00:00:00'.
    source_date_raw text,
    -- True where Excel had read a day/month source value as month/day and the
    -- import transposed it back. Every such row is a traceable correction.
    date_repaired   boolean not null default false,
    date_repair_note text,

    -- Parties ---------------------------------------------------------------
    supplier_id     uuid references suppliers(id),
    supplier_raw    text,           -- exactly as written in the sheet

    -- Money -----------------------------------------------------------------
    -- Signed against the balance: spend negative, funding positive. Because
    -- the sign is resolved at import from the card's own formula, the balance
    -- is a plain sum and no consumer needs to know a card's direction.
    amount_aed      numeric(18,2) not null,
    direction       txn_direction,  -- null only for reconciliation adjustments

    -- Whether the workbook's own running-balance formula consumed this row.
    -- False for the FLYNAS row on AMEX 3024, which sits in the sheet with an
    -- amount but no balance formula. This is what lets source_balance and
    -- ledger_balance be computed from the same table.
    included_in_source_balance boolean not null default true,

    -- Original currency detail. currency is null where the source held a code
    -- this system does not recognise — blank, never guessed.
    currency        text references currencies(code),
    original_amount numeric(18,4),
    currency_raw    text,           -- 'TRY  934000.00' as written

    -- The rate the sheet computed for THIS transaction, on its own date:
    -- AED per one unit of `currency`. Stored, not recomputed, so a historical
    -- transaction keeps the rate that applied when it happened.
    exchange_rate         numeric(20,10),
    exchange_rate_formula text,     -- '=E5/934000' — the rate's provenance

    -- Reference fields. Searched, never parsed apart: req values are compound
    -- ('SA 993 | REQ 11973') and splitting them would lose the pairing.
    req_number      text,
    lpo_number      text,
    invoice         text,
    payment_ref     text,
    account         text,
    crm             text,
    client          text,
    event_end       text,
    sales_operation text,
    notes           text,

    -- Provenance ------------------------------------------------------------
    batch_id        uuid references import_batches(id),
    source_sheet    text,
    source_row      integer,        -- row in the originating sheet

    -- An adjustment is never deleted when the real transaction turns up. It is
    -- superseded, and the chain stays readable.
    superseded_by   uuid references transactions(id),

    -- Direction is in the key, so a payment and its refund sharing one
    -- reference number stay two rows and never collapse into one.
    --
    -- 217 rows in the historical workbook share every identifying field with
    -- another row — the same supplier charged the same amount twice on the
    -- same day against the same request — and the balance chain confirms both
    -- are real. So the key is content plus `occurrence`: a re-uploaded file
    -- reproduces the same numbering and dedups exactly, while a genuine repeat
    -- keeps its own key. A row added by hand takes the next occurrence after
    -- those already stored with the same signature.
    occurrence      integer not null default 1 check (occurrence >= 1),
    dedup_key       text not null unique,

    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),

    -- A real transaction always has a direction; an adjustment never does,
    -- which is what keeps it out of the spend and funding totals below.
    constraint direction_required_for_transactions check (
        (entry_type = 'source_transaction'       and direction is not null) or
        (entry_type = 'reconciliation_adjustment' and direction is null)
    ),
    constraint amount_sign_matches_direction check (
        direction is null
        or (direction = 'spend'   and amount_aed <= 0)
        or (direction = 'funding' and amount_aed >= 0)
    ),
    -- An adjustment must say what it is; silence is how a plug becomes
    -- invisible.
    constraint adjustment_is_explained check (
        entry_type <> 'reconciliation_adjustment'
        or (description is not null and review_reason is not null)
    ),
    -- A converted transaction needs all three parts or none; a rate without
    -- the amount it applied to cannot be checked. A row explicitly marked for
    -- review is exempt: six rows in the historical workbook carry a conversion
    -- rate with a blank currency cell, and the honest record of that is an
    -- incomplete row flagged for a human, not a currency the sheet never
    -- stated.
    constraint conversion_is_complete check (
        exchange_rate is null
        or status = 'needs_review'
        or (currency is not null and original_amount is not null)
    ),
    -- A repaired date must keep the value it was repaired from.
    constraint repair_keeps_original check (
        not date_repaired or source_date_raw is not null
    )
);

create index transactions_card_date  on transactions (card_id, txn_date);
create index transactions_supplier   on transactions (supplier_id);
create index transactions_currency   on transactions (currency);
create index transactions_batch      on transactions (batch_id);
create index transactions_status     on transactions (status)
    where status <> 'confirmed';
create index transactions_entry_type on transactions (entry_type)
    where entry_type <> 'source_transaction';

-- ---------------------------------------------------------------------------
-- Search
-- ---------------------------------------------------------------------------

-- Every searchable field concatenated into one column, trigram-indexed, so a
-- partial match works anywhere in any field — 'REQ 11973' finds the row whose
-- req_number is 'SA 993 | REQ 11973' without that value having been split.
alter table transactions add column search_text text
    generated always as (
        coalesce(supplier_raw,'')    || ' ' ||
        coalesce(req_number,'')      || ' ' ||
        coalesce(lpo_number,'')      || ' ' ||
        coalesce(payment_ref,'')     || ' ' ||
        coalesce(invoice,'')         || ' ' ||
        coalesce(account,'')         || ' ' ||
        coalesce(crm,'')             || ' ' ||
        coalesce(client,'')          || ' ' ||
        coalesce(sales_operation,'') || ' ' ||
        coalesce(event_end,'')       || ' ' ||
        coalesce(currency_raw,'')    || ' ' ||
        coalesce(source_date_raw,'') || ' ' ||
        coalesce(description,'')     || ' ' ||
        coalesce(notes,'')
    ) stored;

create index transactions_search on transactions using gin (search_text gin_trgm_ops);
create index cards_name_trgm     on cards        using gin (name gin_trgm_ops);

-- Card name is searchable alongside the transaction's own fields.
create view transactions_searchable as
select t.*, c.name as card_name, c.name || ' ' || t.search_text as full_search_text
from transactions t
join cards c on c.id = t.card_id;

-- ---------------------------------------------------------------------------
-- Audited corrections — an adjustment is superseded, never deleted
-- ---------------------------------------------------------------------------

create table transaction_corrections (
    id              uuid primary key default gen_random_uuid(),
    transaction_id  uuid not null references transactions(id) on delete restrict,
    action          text not null check (action in
                        ('superseded','status_changed','linked','annotated')),
    from_status     txn_status,
    to_status       txn_status,
    replacement_id  uuid references transactions(id),
    rationale       text not null,
    corrected_by    uuid references auth.users(id),
    created_at      timestamptz not null default now()
);

create index transaction_corrections_txn on transaction_corrections (transaction_id);

-- ---------------------------------------------------------------------------
-- Anomalies — what the importer refused to guess about
-- ---------------------------------------------------------------------------

create table import_anomalies (
    id           uuid primary key default gen_random_uuid(),
    batch_id     uuid references import_batches(id) on delete cascade,
    transaction_id uuid references transactions(id) on delete cascade,
    card_name    text,
    source_row   integer,
    kind         text not null,   -- currency_unrecognised, date_unparseable,
                                  -- rate_denominator_mismatch, balance_chain_broken,
                                  -- balance_reseeded, ...
    detail       text not null,
    resolved     boolean not null default false,
    resolved_by  uuid references auth.users(id),
    resolved_at  timestamptz,
    created_at   timestamptz not null default now()
);

create index import_anomalies_open on import_anomalies (resolved, kind);

-- ---------------------------------------------------------------------------
-- Balances — computed live, never stored
-- ---------------------------------------------------------------------------

-- Three distinct figures, all derived, none editable:
--
--   source_balance  what the workbook itself shows — including the manual
--                   overwrite on RAK 9825 and excluding the FLYNAS row on
--                   AMEX 3024, because that is what the sheet does.
--   ledger_balance  the real transactions only: every source transaction that
--                   is not voided, and no reconciliation plugs.
--   reconciliation_difference
--                   source_balance - ledger_balance. Non-zero means the
--                   workbook and the ledger disagree, and by how much.
create view card_balances as
select
    c.id   as card_id,
    c.name as card_name,
    c.settlement_currency,
    c.opening_balance,
    c.opening_date,

    c.opening_balance + coalesce(sum(t.amount_aed)
        filter (where t.included_in_source_balance
                  and t.status <> 'voided'), 0)                as source_balance,

    c.opening_balance + coalesce(sum(t.amount_aed)
        filter (where t.entry_type = 'source_transaction'
                  and t.status <> 'voided'), 0)                as ledger_balance,

    coalesce(sum(t.amount_aed)
        filter (where t.included_in_source_balance
                  and t.status <> 'voided'), 0)
  - coalesce(sum(t.amount_aed)
        filter (where t.entry_type = 'source_transaction'
                  and t.status <> 'voided'), 0)   as reconciliation_difference,

    -- Kept out of spend and funding by construction: an adjustment has no
    -- direction, so neither filter below can reach it.
    coalesce(sum(t.amount_aed)
        filter (where t.entry_type = 'reconciliation_adjustment'), 0)
                                                  as review_adjustments_total,
    count(*) filter (where t.entry_type = 'reconciliation_adjustment')
                                                  as review_adjustments_count,

    coalesce(sum(t.amount_aed) filter (where t.direction = 'spend'
                                         and t.status <> 'voided'), 0) as total_spend,
    coalesce(sum(t.amount_aed) filter (where t.direction = 'funding'
                                         and t.status <> 'voided'), 0) as total_funding,

    count(*) filter (where t.entry_type = 'source_transaction')  as transaction_count,
    count(*) filter (where t.status = 'needs_review')            as needs_review_count,
    count(*) filter (where t.status = 'excluded_from_source_balance')
                                                                 as excluded_count,
    min(t.txn_date) as first_transaction,
    max(t.txn_date) as last_transaction
from cards c
left join transactions t
       on t.card_id = c.id
      and (c.opening_date is null or t.txn_date >= c.opening_date)
group by c.id;

-- Spend broken out by the currency it originated in. Deliberately returns one
-- row per (card, currency) and never a total: adding 1,835,294 EUR to
-- 56,365,582 JPY produces a number that looks like money and is not. Consumers
-- that want a single figure must use the AED settlement amount.
create view card_spend_by_currency as
select
    t.card_id,
    c.name          as card_name,
    t.currency,
    count(*)                        as transaction_count,
    sum(t.original_amount)          as total_original_amount,
    sum(t.amount_aed)               as total_settled_aed,
    min(t.exchange_rate)            as min_rate,
    max(t.exchange_rate)            as max_rate
from transactions t
join cards c on c.id = t.card_id
where t.currency is not null
  and t.entry_type = 'source_transaction'
  and t.status <> 'voided'
  and (c.opening_date is null or t.txn_date >= c.opening_date)
group by t.card_id, c.name, t.currency;

-- Everything awaiting a human decision, in one place.
create view review_queue as
select t.id, c.name as card_name, t.source_sheet, t.source_row, t.txn_date,
       t.supplier_raw, t.amount_aed, t.currency, t.currency_raw,
       t.entry_type, t.status, t.review_reason, t.description
from transactions t
join cards c on c.id = t.card_id
where t.status in ('needs_review','excluded_from_source_balance')
   or t.entry_type = 'reconciliation_adjustment';

-- ---------------------------------------------------------------------------
-- Access control — enforced here, not only in the UI
-- ---------------------------------------------------------------------------

-- Named explicitly. Membership of this table is what grants write access;
-- there is no "is admin" boolean on a user row to drift out of sync.
create table admins (
    user_id    uuid primary key references auth.users(id) on delete cascade,
    email      text not null unique,
    added_by   uuid references auth.users(id),
    created_at timestamptz not null default now()
);

create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
    select exists (select 1 from admins where user_id = auth.uid());
$$;

alter table cards                   enable row level security;
alter table suppliers               enable row level security;
alter table transactions            enable row level security;
alter table import_batches          enable row level security;
alter table import_anomalies        enable row level security;
alter table transaction_corrections enable row level security;
alter table admins                  enable row level security;
alter table currencies              enable row level security;

-- Everyone signed in reads; only named admins write.
do $$
declare t text;
begin
    foreach t in array array['cards','suppliers','transactions','import_batches',
                             'import_anomalies','transaction_corrections','currencies']
    loop
        execute format(
            'create policy %I on %I for select to authenticated using (true)',
            t || '_read', t);
        execute format(
            'create policy %I on %I for all to authenticated '
            'using (is_admin()) with check (is_admin())',
            t || '_write', t);
    end loop;
end $$;

create policy admins_read  on admins for select to authenticated using (true);
create policy admins_write on admins for all to authenticated
    using (is_admin()) with check (is_admin());

commit;
