-- A card's balance column does not always count the same thing.
--
-- Six of the seven sheets write an *available* balance: money spent reduces it,
-- money received raises it. RAK 9825's statement writes the opposite — money
-- spent raises the figure and a payment reduces it — because the figure is what
-- has been drawn on the card, not what is left on it. The header still says
-- "Available Balance", which is why this went unnoticed.
--
-- Replaying the reissued RAK 9825 statement (supplied 5 Sep 2026) settles it.
-- Its opening is -859.01 and its own printed chain runs:
--
--     -859.01 + 277.67 = -581.34      (a 277.67 Amazon purchase RAISES it)
--      9027.52 - 10000 = -972.48      (a 10,000 payment LOWERS it)
--      5334.28 -  5500 = -165.72      (and so does the 5,500 payment)
--
-- Read that way the statement closes at -165.72, which is the figure printed on
-- it. Read the other way it closes at -1,552.30. Both are arithmetically valid;
-- only one is the statement's own.
--
-- The fix is NOT to flip the sign of the transactions. A purchase at Amazon is
-- spending whichever way the bank prints its running total, and flipping the
-- rows would corrupt every spend report, supplier total and currency figure in
-- the system. What changes is how the *balance* is derived from those rows, and
-- that is a property of the card.
--
--   balance_sign = +1  the balance counts money available; spending lowers it
--   balance_sign = -1  the balance counts money drawn; spending raises it
--
-- Safe to re-run.

begin;

-- ---------------------------------------------------------------------------
-- 1. The column
-- ---------------------------------------------------------------------------

alter table cards add column if not exists balance_sign smallint not null default 1;

do $$
begin
    if not exists (
        select 1 from pg_constraint where conname = 'cards_balance_sign_check'
    ) then
        alter table cards add constraint cards_balance_sign_check
            check (balance_sign in (-1, 1));
    end if;
end $$;

comment on column cards.balance_sign is
    'How this card''s statement runs its balance. +1: the balance counts money '
    'available, so a purchase lowers it — six of the seven sheets. -1: the '
    'balance counts money drawn, so a purchase raises it and a payment lowers '
    'it — RAK 9825. Transactions keep their economic sign either way: a '
    'purchase is always negative in amount_aed, so spend reporting is unaffected.';

-- ---------------------------------------------------------------------------
-- 2. The balances, derived through it
-- ---------------------------------------------------------------------------

-- This is migration 012's view with balance_sign applied to the three figures
-- that are balances. Everything else is 012 unchanged, including the join
-- condition that keeps a transaction dated before the card existed out of the
-- balance, and the voided filters on the counts and the first/last dates.
--
-- Dropped rather than replaced: `create or replace view` can only append
-- columns, and balance_sign belongs beside the other card facts rather than
-- tacked on the end. Nothing else depends on this view, and the grants below
-- are restated because dropping it takes them with it.
drop view if exists card_balances;

create view card_balances as
select
    c.id   as card_id,
    c.name as card_name,
    c.settlement_currency,
    c.opening_balance,
    c.opening_date,
    c.balance_sign,

    c.opening_balance + c.balance_sign * coalesce(sum(t.amount_aed)
        filter (where t.included_in_source_balance
                  and t.status <> 'voided'), 0)                as source_balance,

    c.opening_balance + c.balance_sign * coalesce(sum(t.amount_aed)
        filter (where t.entry_type = 'source_transaction'
                  and t.status <> 'voided'), 0)                as ledger_balance,

    c.balance_sign * (
        coalesce(sum(t.amount_aed)
            filter (where t.included_in_source_balance
                      and t.status <> 'voided'), 0)
      - coalesce(sum(t.amount_aed)
            filter (where t.entry_type = 'source_transaction'
                      and t.status <> 'voided'), 0)
    )                                                 as reconciliation_difference,

    -- A voided adjustment is a decision already taken. It stays on the row for
    -- the audit trail but must not be reported as still outstanding.
    coalesce(sum(t.amount_aed)
        filter (where t.entry_type = 'reconciliation_adjustment'
                  and t.status <> 'voided'), 0)
                                                  as review_adjustments_total,
    count(*) filter (where t.entry_type = 'reconciliation_adjustment'
                       and t.status <> 'voided')  as review_adjustments_count,

    -- Spend and funding are economic, not presentational, and are deliberately
    -- NOT touched by balance_sign: a purchase is spending on every card.
    coalesce(sum(t.amount_aed) filter (where t.direction = 'spend'
                                         and t.status <> 'voided'), 0) as total_spend,
    coalesce(sum(t.amount_aed) filter (where t.direction = 'funding'
                                         and t.status <> 'voided'), 0) as total_funding,

    count(*) filter (where t.entry_type = 'source_transaction'
                       and t.status <> 'voided')                 as transaction_count,
    count(*) filter (where t.status = 'needs_review')             as needs_review_count,
    count(*) filter (where t.status = 'excluded_from_source_balance')
                                                                  as excluded_count,
    min(t.txn_date) filter (where t.status <> 'voided') as first_transaction,
    max(t.txn_date) filter (where t.status <> 'voided') as last_transaction
from cards c
left join transactions t
       on t.card_id = c.id
      and (c.opening_date is null or t.txn_date >= c.opening_date)
group by c.id;

-- A view runs as its owner unless told otherwise, which would hand every caller
-- the owner's rights and bypass RLS entirely. Restated because the view was
-- just replaced.
alter view card_balances set (security_invoker = on);
revoke all on card_balances from anon;
grant select on card_balances to authenticated;

-- ---------------------------------------------------------------------------
-- 3. RAK 9825 reads its balance the drawn way
-- ---------------------------------------------------------------------------

update cards set balance_sign = -1, updated_at = now()
 where name like 'RAK 9825%' and balance_sign <> -1;

insert into card_audit (card_id, card_name, action, detail)
select id, name, 'updated',
       jsonb_build_object(
         'balance_sign', jsonb_build_object('from', 1, 'to', -1),
         'reason',
         'The reissued statement of 5 Sep 2026 runs its own balance the drawn '
         'way: a purchase raises the figure and a payment lowers it. Replayed '
         'that way the statement closes on the -165.72 printed at its foot. '
         'Transaction directions are unchanged — a purchase is still spending.')
  from cards where name like 'RAK 9825%'
   and not exists (
       select 1 from card_audit a
        where a.card_id = cards.id and a.detail ? 'balance_sign');

-- ---------------------------------------------------------------------------
-- 4. Creating a card can set it
-- ---------------------------------------------------------------------------

-- Adding a parameter creates an overload rather than replacing the function,
-- and two candidates make every existing call ambiguous. The old signature goes
-- first. Callers passing 8 or 10 positional arguments still resolve, through
-- the defaults.
drop function if exists create_card(
    text, numeric, date, text, text, text, text, text, numeric, text);

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
    p_notes              text    default null,
    p_balance_sign       smallint default 1
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
    -- New. Everything above is unchanged from migration 003.
    if p_balance_sign is null or p_balance_sign not in (-1, 1) then
        raise exception
            'The balance convention must be 1 (the balance counts money available) or -1 (it counts money drawn)';
    end if;

    insert into cards (name, settlement_currency, opening_balance, opening_date,
                       card_type, status, bank_issuer, account_reference,
                       credit_limit, notes, balance_sign, created_by)
    values (btrim(p_name), p_settlement_currency, p_opening_balance, p_opening_date,
            btrim(p_card_type), p_status::card_status, p_bank_issuer,
            p_account_reference, p_credit_limit, p_notes, p_balance_sign, auth.uid())
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
                'credit_limit', p_credit_limit,
                'balance_sign', p_balance_sign));

    return v_id;
end;
$$;

revoke all on function create_card from public, anon;
grant execute on function create_card to authenticated;

commit;
