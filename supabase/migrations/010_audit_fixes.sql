-- Three fixes found by adversarial audit.
--
-- Safe to re-run.

begin;

-- ---------------------------------------------------------------------------
-- 1. card_spend_by_currency summed funding in with spend
-- ---------------------------------------------------------------------------
--
-- The view is named for spend, is labelled "Spend by original currency" on the
-- dashboard and on every card page, and had no direction filter — so a top-up
-- counted as spend and the two were netted against each other. On AMEX 4000 the
-- AED line read +24,201,266.46 where actual spend is −1,878,800.98, and the
-- transaction count was 308 against a true 230.
--
-- Nobody would have caught this by eye: the figures look like money and the
-- sign is not obviously wrong on a card where funding happens to be smaller.

create or replace view card_spend_by_currency as
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
  and t.direction = 'spend'          -- the fix: funding is not spend
  and t.entry_type = 'source_transaction'
  and t.status <> 'voided'
  and (c.opening_date is null or t.txn_date >= c.opening_date)
group by t.card_id, c.name, t.currency;

alter view card_spend_by_currency set (security_invoker = on);
revoke all on card_spend_by_currency from anon;
grant select on card_spend_by_currency to authenticated;

-- ---------------------------------------------------------------------------
-- 2. The correction trail was erasable by the people it records
-- ---------------------------------------------------------------------------
--
-- transaction_corrections got the schema's generic "admins may do anything"
-- policy, so an admin could change a balance and then delete the record of
-- having done so. admin_audit and card_audit were already append-only; this
-- was the one that was not, and it is the one that records money moving.

drop policy if exists transaction_corrections_write on transaction_corrections;
drop policy if exists transaction_corrections_read  on transaction_corrections;

create policy transaction_corrections_read on transaction_corrections
    for select to authenticated using (true);
create policy transaction_corrections_insert on transaction_corrections
    for insert to authenticated with check (is_admin());
-- Deliberately no update or delete policy, matching admin_audit and card_audit.

-- ---------------------------------------------------------------------------
-- 3. A resubmitted form created a second transaction
-- ---------------------------------------------------------------------------
--
-- The occurrence counter exists so a genuine repeat charge keeps its own row,
-- and it does that correctly. But it cannot tell a deliberate repeat from a
-- double-clicked button, a retried request or a refresh mid-submit — and it
-- resolved every one of them by creating another transaction, which for a
-- ledger means counting the same money twice.
--
-- An identical submission within a short window is now treated as the same
-- submission and returns the row that already exists. Entering the same charge
-- again deliberately still works: after the window, or immediately with
-- p_allow_duplicate, a new row is created as before. The UI already warns about
-- likely duplicates, so the person entering one can say it is intended.

-- The previous signature must go, or adding a parameter leaves two overloads
-- and every later grant, revoke and call becomes ambiguous — and a client
-- omitting the new argument would silently reach the old, unguarded version.
drop function if exists create_transaction(
    uuid, date, text, numeric, text, text, text, text, numeric, numeric,
    text, text, text, text, text, text, text, text, boolean);

create or replace function create_transaction(
    p_card_id           uuid,
    p_txn_date          date,
    p_kind              text,
    p_amount_aed        numeric,
    p_supplier          text,
    p_req_number        text,
    p_payment_ref       text,
    p_currency          text    default null,
    p_original_amount   numeric default null,
    p_exchange_rate     numeric default null,
    p_supplier_country  text    default null,
    p_crm               text    default null,
    p_lpo_number        text    default null,
    p_invoice           text    default null,
    p_client            text    default null,
    p_sales_operation   text    default null,
    p_description       text    default null,
    p_notes             text    default null,
    p_needs_review      boolean default false,
    p_allow_duplicate   boolean default false
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_direction    txn_direction;
    v_entry_type   txn_entry_type := 'source_transaction';
    v_status       txn_status;
    v_signed       numeric;
    v_supplier_id  uuid;
    v_supplier_raw text;
    v_signature    text;
    v_occurrence   integer;
    v_dedup        text;
    v_recent       uuid;
    v_existing     uuid;
    v_id           uuid;
begin
    if not is_admin() then
        raise exception 'Only a named admin may add a transaction'
            using errcode = '42501';
    end if;

    if p_card_id is null or p_txn_date is null then
        raise exception 'A card and a transaction date are required';
    end if;
    if p_amount_aed is null or p_amount_aed <= 0 then
        raise exception 'Enter a positive AED amount; the direction comes from the type';
    end if;
    if coalesce(btrim(p_supplier), '') = '' then
        raise exception 'A supplier or merchant name is required';
    end if;
    if coalesce(btrim(p_req_number), '') = '' then
        raise exception 'A request number is required';
    end if;
    if coalesce(btrim(p_payment_ref), '') = '' then
        raise exception 'A payment reference number is required';
    end if;
    if p_supplier_country is not null and p_supplier_country !~ '^[0-9]{3}$' then
        raise exception 'Supplier country code must be three digits (ISO-3166 numeric)';
    end if;

    case p_kind
        when 'purchase' then v_direction := 'spend';
        when 'fee'      then v_direction := 'spend';
        when 'refund'   then v_direction := 'funding';
        when 'funding'  then v_direction := 'funding';
        when 'reconciliation_adjustment' then
            v_direction  := null;
            v_entry_type := 'reconciliation_adjustment';
        else
            raise exception 'Unknown transaction type: %', p_kind;
    end case;

    v_signed := case
        when v_direction = 'spend' then -abs(p_amount_aed) else abs(p_amount_aed)
    end;
    v_status := case when p_needs_review then 'needs_review'::txn_status
                     else 'confirmed'::txn_status end;

    if p_currency is not null and not p_needs_review then
        if p_original_amount is null or p_original_amount <= 0 then
            raise exception 'Enter the amount in %, or mark the row for review', p_currency;
        end if;
        if p_exchange_rate is null or p_exchange_rate <= 0 then
            raise exception 'Enter the exchange rate used, or mark the row for review';
        end if;
    end if;
    if p_currency is null and (p_original_amount is not null or p_exchange_rate is not null) then
        raise exception 'Select the currency these figures are in';
    end if;
    if p_currency is not null and not exists (select 1 from currencies where code = p_currency) then
        raise exception 'Unrecognised currency: %', p_currency;
    end if;
    if p_currency = 'AED' and p_exchange_rate is not null then
        raise exception 'An AED transaction cannot carry an exchange rate';
    end if;

    v_supplier_raw := btrim(p_supplier) || coalesce(' ' || p_supplier_country, '');

    -- An identical entry made moments ago is the same submission arriving
    -- twice, not two charges. Returned rather than duplicated.
    if not p_allow_duplicate then
        select id into v_recent
          from transactions
         where card_id = p_card_id
           and txn_date = p_txn_date
           and amount_aed = v_signed
           and upper(coalesce(supplier_raw, '')) = upper(v_supplier_raw)
           and upper(coalesce(payment_ref, '')) = upper(btrim(p_payment_ref))
           and upper(coalesce(req_number, ''))  = upper(btrim(p_req_number))
           and created_at > now() - interval '2 minutes'
         order by created_at desc
         limit 1;
        if v_recent is not null then
            return v_recent;
        end if;
    end if;

    insert into suppliers (name, country_code)
    values (btrim(p_supplier), p_supplier_country)
    on conflict (name, country_code) do update set name = excluded.name
    returning id into v_supplier_id;

    v_signature := concat_ws('|',
        p_card_id::text,
        to_char(p_txn_date, 'YYYY-MM-DD'),
        to_char(v_signed, 'FM9999999990.00'),
        upper(v_supplier_raw),
        upper(btrim(p_payment_ref)),
        upper(btrim(p_req_number)),
        coalesce(v_direction::text, v_entry_type::text));

    select count(*) + 1 into v_occurrence
      from transactions
     where card_id = p_card_id
       and txn_date = p_txn_date
       and amount_aed = v_signed
       and upper(coalesce(supplier_raw, '')) = upper(v_supplier_raw)
       and upper(coalesce(payment_ref, '')) = upper(btrim(p_payment_ref))
       and upper(coalesce(req_number, ''))  = upper(btrim(p_req_number));

    v_dedup := encode(
        sha256(convert_to(v_signature || '|#' || v_occurrence, 'UTF8')), 'hex');

    select id into v_existing from transactions where dedup_key = v_dedup;
    if v_existing is not null then
        return v_existing;
    end if;

    insert into transactions (
        card_id, entry_type, status, description, notes, txn_date,
        supplier_id, supplier_raw, amount_aed, direction,
        included_in_source_balance, currency, original_amount, exchange_rate,
        normalized_exchange_rate,
        req_number, lpo_number, invoice, payment_ref, crm, client,
        sales_operation, occurrence, dedup_key, review_reason
    ) values (
        p_card_id, v_entry_type, v_status, p_description, p_notes, p_txn_date,
        v_supplier_id, v_supplier_raw, v_signed, v_direction,
        true, p_currency, p_original_amount, p_exchange_rate,
        case when p_original_amount > 0
             then round(abs(v_signed) / p_original_amount, 10) end,
        btrim(p_req_number), p_lpo_number, p_invoice, btrim(p_payment_ref),
        p_crm, p_client, p_sales_operation, v_occurrence, v_dedup,
        case when p_needs_review
             then 'Marked for review at manual entry: a currency, amount or rate was not known.'
             else null end
    ) returning id into v_id;

    return v_id;
end;
$$;

revoke all on function create_transaction from public, anon;
grant execute on function create_transaction to authenticated;

commit;
