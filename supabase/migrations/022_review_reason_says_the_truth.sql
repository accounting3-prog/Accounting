-- A flagged row said the wrong thing about itself.
--
-- Four transactions sit in the review queue reading "Marked for review at
-- manual entry: a currency, amount or rate was not known." All four carry a
-- currency, an original amount AND a rate. The sentence is false about every
-- one of them.
--
-- create_transaction had one hardcoded sentence for p_needs_review, written
-- when the only thing that set the flag was a manual entry with a figure
-- missing. The file importer now raises it for anything it wants a second
-- opinion on — an ambiguous date, an unknown currency code, a charge the file
-- lists twice — and every one of those inherited a reason that describes none
-- of them.
--
-- That is worse than a cosmetic fault. The point of the queue is that someone
-- opens a row and knows what to look at. Open one of these, find the currency
-- and the amount and the rate all present and correct, and the only thing
-- learned is that the queue cannot be trusted — after which the real ones stop
-- being read too.
--
-- So the caller says why. The default is the old sentence, so the manual form
-- and anything else that does not pass a reason behaves exactly as before.
--
-- Safe to re-run.

begin;

-- ---------------------------------------------------------------------------
-- 1. The caller can state the reason
-- ---------------------------------------------------------------------------

drop function if exists create_transaction(
    uuid, date, text, numeric, text, text, text, text, numeric, numeric, text,
    text, text, text, text, text, text, text, boolean, boolean);

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
    p_allow_duplicate   boolean default false,
    p_review_reason     text    default null
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
    v_existing     uuid;
    v_recent       uuid;
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

    if not p_allow_duplicate then
        select id into v_recent
          from transactions
         where card_id = p_card_id
           and txn_date = p_txn_date
           and amount_aed = v_signed
           and upper(coalesce(supplier_raw, '')) = upper(v_supplier_raw)
           and upper(coalesce(payment_ref, '')) = upper(coalesce(btrim(p_payment_ref), ''))
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
        upper(coalesce(btrim(p_payment_ref), '')),
        upper(btrim(p_req_number)),
        coalesce(v_direction::text, v_entry_type::text));

    select count(*) + 1 into v_occurrence
      from transactions
     where card_id = p_card_id
       and txn_date = p_txn_date
       and amount_aed = v_signed
       and upper(coalesce(supplier_raw, '')) = upper(v_supplier_raw)
       and upper(coalesce(payment_ref, '')) = upper(coalesce(btrim(p_payment_ref), ''))
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
        btrim(p_req_number), p_lpo_number, p_invoice, nullif(btrim(p_payment_ref), ''),
        p_crm, p_client, p_sales_operation, v_occurrence, v_dedup,
        -- The caller's own words when it has them. The default is what this
        -- said before, so the manual form is unchanged.
        case when p_needs_review
             then coalesce(nullif(btrim(p_review_reason), ''),
                           'Marked for review at manual entry: a currency, amount or rate was not known.')
             else null end
    ) returning id into v_id;

    return v_id;
end;
$$;

revoke all on function create_transaction from public, anon;
grant execute on function create_transaction to authenticated;

-- ---------------------------------------------------------------------------
-- 2. The four rows that already say the wrong thing
-- ---------------------------------------------------------------------------

-- They are the second copy of a charge their statement lists twice, which is
-- why the importer wanted a second opinion. Their currency, amount and rate
-- were never in doubt. The correction is recorded like any other.

insert into transaction_corrections
    (transaction_id, action, from_status, to_status, rationale, action_note, field_changes)
select t.id, 'annotated', t.status, t.status,
       'The stated reason was untrue of this row: it has a currency, an original amount and a '
       'rate. It was flagged because the file lists this charge twice and this is the second '
       'copy. Corrected so the review queue says what is actually in question.',
       'reason corrected by migration 022',
       jsonb_build_object('review_reason', jsonb_build_object(
           'from', t.review_reason,
           'to',   'The file listed this charge more than once and this is a further copy. '
                   'Confirm it is a genuine repeat rather than the same charge entered twice.'))
  from transactions t
 where t.status = 'needs_review'
   and t.review_reason = 'Marked for review at manual entry: a currency, amount or rate was not known.'
   and t.currency is not null
   and t.original_amount is not null
   and t.exchange_rate is not null;

update transactions
   set review_reason =
       'The file listed this charge more than once and this is a further copy. '
       'Confirm it is a genuine repeat rather than the same charge entered twice.'
 where status = 'needs_review'
   and review_reason = 'Marked for review at manual entry: a currency, amount or rate was not known.'
   and currency is not null
   and original_amount is not null
   and exchange_rate is not null;

commit;
