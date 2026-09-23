-- Some accounts are a record of payments, not a balance to reconcile.
--
-- The NBD account is a payment rail: money is sent through it in whatever
-- currency the beneficiary is paid in, and what is recorded is the cost, its
-- currency, the dirham equivalent, who was paid, and the request it belongs
-- to. There is no running balance to agree with and none is wanted.
--
-- WHY THIS IS A CORRECTNESS FIX AND NOT A PREFERENCE
--
-- An account's balance is its opening figure plus its rows, and the dashboard
-- adds those together per settlement currency. NBD settles in AED. Left as an
-- ordinary account it would open at nothing, hold 222 payments, and carry a
-- "balance" of -13,674,062.24 — which is not a balance, it is the total paid,
-- and it would have gone straight into the AED figure the business reads
-- first.
--
-- So an account either tracks a balance or it does not, and one that does not
-- is left out of every balance total rather than contributing a number that
-- looks like money and is not. Its transactions are still counted, searched
-- and exported; it is the BALANCE that does not exist.
--
-- create_card is rebuilt from the definition the database actually holds, not
-- from a copy written out here. A hand-written version of it differed in four
-- rules — it dropped the requirement for a card type, dropped the active or
-- inactive check, measured an account reference by counting digits instead of
-- its length, and compared names in a different case. None of that would have
-- raised an error; it would simply have started accepting accounts the ledger
-- had always refused.
--
-- Safe to re-run.

begin;

alter table cards
    add column if not exists tracks_balance boolean not null default true;

comment on column cards.tracks_balance is
    'False for an account that records payments rather than holding a balance: '
    'no opening figure, no reconciliation, and left out of every balance total. '
    'Its transactions count normally everywhere else.';

-- The 11-argument signature, before the parameter is added.
drop function if exists create_card(
    text, numeric, date, text, text, text, text, text, numeric, text, smallint);

create or replace function create_card(
    p_name text,
    p_opening_balance numeric,
    p_opening_date date,
    p_card_type text,
    p_status text DEFAULT 'active'::text,
    p_settlement_currency text DEFAULT 'AED'::text,
    p_bank_issuer text DEFAULT NULL::text,
    p_account_reference text DEFAULT NULL::text,
    p_credit_limit numeric DEFAULT NULL::numeric,
    p_notes text DEFAULT NULL::text,
    p_balance_sign smallint DEFAULT 1,
    p_tracks_balance boolean DEFAULT true
)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    if p_tracks_balance and p_opening_balance is null then
        raise exception 'An opening balance is required';
    end if;
    -- The other way round for an account that holds no balance: an opening
    -- figure on a record of payments is a number with nothing to mean.
    if not p_tracks_balance and coalesce(p_opening_balance, 0) <> 0 then
        raise exception
            'An account that does not track a balance cannot have an opening balance';
    end if;
    -- Required for a manually added card: without it, historical transactions
    -- that were settled before the account existed would be charged to it.
    if p_tracks_balance and p_opening_date is null then
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
                       credit_limit, notes, balance_sign, tracks_balance, created_by)
    values (btrim(p_name), p_settlement_currency, coalesce(p_opening_balance, 0), p_opening_date,
            btrim(p_card_type), p_status::card_status, p_bank_issuer,
            p_account_reference, p_credit_limit, p_notes, p_balance_sign,
            p_tracks_balance, auth.uid())
    returning id into v_id;

    select email into v_email from admins where user_id = auth.uid();

    insert into card_audit (card_id, card_name, action, performed_by,
                            performed_by_email, detail)
    values (v_id, btrim(p_name), 'created', auth.uid(), v_email,
            jsonb_build_object(
                'tracks_balance', p_tracks_balance,
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
$function$;

revoke all on function create_card from public, anon;
grant execute on function create_card to authenticated;

commit;
