-- Exchange-rate normalisation, card management fields, and an audited
-- card-creation path.
--
-- Safe to re-run.

begin;

-- ---------------------------------------------------------------------------
-- 1. Normalised operational exchange rate
-- ---------------------------------------------------------------------------
--
-- The workbook's own conversion cells divide the AED figure by a denominator
-- typed into the formula, and on six rows that denominator differs slightly
-- from the original amount stated in the currency cell (=E1032/343.16 against
-- 'BHD 343.035', for instance). The stored rate is therefore not exactly the
-- rate that actually applied to the money that moved.
--
-- Rather than correct the source — which would destroy the audit trail — the
-- original rate and formula are kept untouched and a second, derived figure is
-- added alongside: AED settlement divided by the original amount. That is the
-- rate the transaction actually settled at, computed from the two numbers the
-- ledger holds, and it is what reports should use.

alter table transactions
    add column if not exists normalized_exchange_rate numeric(20,10),
    add column if not exists rate_review_note text;

comment on column transactions.normalized_exchange_rate is
    'AED settlement divided by the original amount: the rate the transaction '
    'actually settled at. Derived, never entered. exchange_rate keeps the '
    'workbook''s own figure for audit.';

comment on column transactions.rate_review_note is
    'Visible explanation shown in the transaction detail and review queue when '
    'the source rate could not be used as-is.';

-- Derived wherever both figures exist. This is arithmetic on values already in
-- the row, not an inference about missing data.
update transactions
   set normalized_exchange_rate = round(abs(amount_aed) / original_amount, 10)
 where original_amount is not null
   and original_amount > 0
   and amount_aed <> 0
   and normalized_exchange_rate is null;

-- Where the workbook's rate and the settled rate disagree, say so on the row.
update transactions
   set rate_review_note =
           'Source exchange rate requires review; normalized rate calculated '
           'from AED settlement amount and original amount.',
       status = case when status = 'confirmed' then 'needs_review'::txn_status
                     else status end
 where exchange_rate is not null
   and normalized_exchange_rate is not null
   and abs(exchange_rate - normalized_exchange_rate) > 1e-9;

-- A conversion rate against no stated currency: the currency stays null — it is
-- never guessed — but the row says why it cannot be normalised or reported on.
update transactions
   set rate_review_note = coalesce(rate_review_note || ' ', '') ||
           'A conversion rate is present but the source states no currency '
           'code, so the original currency is unknown. Raw source text and '
           'formula are preserved.',
       status = case when status = 'confirmed' then 'needs_review'::txn_status
                     else status end
 where exchange_rate is not null
   and currency is null
   and rate_review_note is null;

-- A rate of exactly 1 with no currency and no original amount is not a
-- conversion; it is a placeholder someone typed. Flagged rather than removed.
update transactions
   set rate_review_note = coalesce(rate_review_note || ' ', '') ||
           'The source conversion cell holds a bare 1 with no formula, '
           'currency or original amount, so no rate can be derived.'
 where exchange_rate = 1
   and currency is null
   and original_amount is null
   and exchange_rate_formula is null
   and (rate_review_note is null or rate_review_note not like '%bare 1%');

-- A transaction settled natively in AED cannot also carry a conversion rate.
alter table transactions drop constraint if exists no_rate_on_base_currency;
alter table transactions add constraint no_rate_on_base_currency
    check (not (currency = 'AED' and exchange_rate is not null));

-- ---------------------------------------------------------------------------
-- 2. Card management fields
-- ---------------------------------------------------------------------------

do $$ begin
    if not exists (select 1 from pg_type where typname = 'card_status') then
        create type card_status as enum ('active', 'inactive');
    end if;
end $$;

alter table cards
    add column if not exists card_type         text,
    add column if not exists status            card_status not null default 'active',
    add column if not exists bank_issuer       text,
    add column if not exists account_reference text,
    add column if not exists notes             text,
    add column if not exists credit_limit      numeric(18,2),
    add column if not exists created_by        uuid references auth.users(id);

comment on column cards.account_reference is
    'Last four digits or internal account reference. Never a full card number.';

-- ---------------------------------------------------------------------------
-- 3. Immutable audit record for card creation and changes
-- ---------------------------------------------------------------------------

create table if not exists card_audit (
    id          uuid primary key default gen_random_uuid(),
    card_id     uuid references cards(id) on delete set null,
    card_name   text not null,
    action      text not null check (action in ('created', 'updated', 'deactivated')),
    performed_by uuid references auth.users(id),
    performed_by_email text,
    detail      jsonb,
    created_at  timestamptz not null default now()
);

create index if not exists card_audit_card on card_audit (card_id, created_at desc);

-- Append-only: the record of who created an account must not be editable by
-- the people it holds to account.
alter table card_audit enable row level security;
drop policy if exists card_audit_read on card_audit;
create policy card_audit_read on card_audit
    for select to authenticated using (true);
drop policy if exists card_audit_insert on card_audit;
create policy card_audit_insert on card_audit
    for insert to authenticated with check (is_admin());
-- Deliberately no update or delete policy: rows can be added and read, never
-- altered or removed.

-- ---------------------------------------------------------------------------
-- 4. The audited write path for adding a card
-- ---------------------------------------------------------------------------

create or replace function create_card(
    p_name               text,
    p_opening_balance    numeric,
    p_opening_date       date,
    p_card_type          text,
    p_status             text    default 'active',
    p_settlement_currency text   default 'AED',
    p_bank_issuer        text    default null,
    p_account_reference  text    default null,
    p_credit_limit       numeric default null,
    p_notes              text    default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_id    uuid;
    v_email text;
begin
    if not is_admin() then
        raise exception 'Only a named admin may add a card' using errcode = '42501';
    end if;

    if coalesce(btrim(p_name), '') = '' then
        raise exception 'A card or account name is required';
    end if;
    if exists (select 1 from cards where lower(name) = lower(btrim(p_name))) then
        raise exception 'A card named "%" already exists', btrim(p_name);
    end if;
    if p_opening_balance is null then
        raise exception 'An opening balance is required';
    end if;
    -- Required for a manually added card: without it, historical transactions
    -- that were settled before the account existed would be charged to it.
    if p_opening_date is null then
        raise exception 'An opening balance date is required for a new card';
    end if;
    if coalesce(btrim(p_card_type), '') = '' then
        raise exception 'A card or account type is required';
    end if;
    if p_status not in ('active', 'inactive') then
        raise exception 'Status must be active or inactive';
    end if;
    if not exists (select 1 from currencies where code = p_settlement_currency) then
        raise exception 'Unrecognised settlement currency: %', p_settlement_currency;
    end if;
    if p_account_reference is not null and length(btrim(p_account_reference)) > 8 then
        raise exception 'Use a last-four or short reference, not a full account number';
    end if;

    insert into cards (name, settlement_currency, opening_balance, opening_date,
                       card_type, status, bank_issuer, account_reference,
                       credit_limit, notes, created_by)
    values (btrim(p_name), p_settlement_currency, p_opening_balance, p_opening_date,
            btrim(p_card_type), p_status::card_status, p_bank_issuer,
            p_account_reference, p_credit_limit, p_notes, auth.uid())
    returning id into v_id;

    select email into v_email from admins where user_id = auth.uid();

    insert into card_audit (card_id, card_name, action, performed_by,
                            performed_by_email, detail)
    values (v_id, btrim(p_name), 'created', auth.uid(), v_email,
            jsonb_build_object(
                'opening_balance', p_opening_balance,
                'opening_date', p_opening_date,
                'settlement_currency', p_settlement_currency,
                'card_type', p_card_type,
                'status', p_status,
                'bank_issuer', p_bank_issuer,
                'account_reference', p_account_reference,
                'credit_limit', p_credit_limit));

    return v_id;
end;
$$;

comment on function create_card is
    'The only path for adding a card. Admin-only, enforces a unique name and a '
    'required opening date, and writes an immutable card_audit row naming who '
    'created it and when.';

revoke all on function create_card from public, anon;
grant execute on function create_card to authenticated;

commit;
