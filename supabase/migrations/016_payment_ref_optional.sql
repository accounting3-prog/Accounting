-- A payment reference is no longer required.
--
-- 577 of the workbook's own 1,948 rows have none — on every one of the seven
-- cards, from 1 of 1 on AMEX 2044 to 445 of 1,370 on AMEX 4000. The rule was
-- never true of this ledger's data. It went unnoticed because the bulk import
-- writes rows directly, and only the manual form and the file importer go
-- through create_transaction — which is why an import of 36 real rows refused
-- all 36 of them.
--
-- A request number is still required: 4 of 1,948 rows lack one, so that rule
-- does hold in practice.
--
-- THREE THINGS HAD TO CHANGE WITH IT, each a silent fault rather than an error:
--
--   upper(NULL) is NULL, and NULL = anything is NULL rather than true. The
--   two-minute double-submit guard and the occurrence counter both compare on
--   the reference, so with a null one they would have stopped matching, and a
--   double-clicked form would have written the charge twice.
--
--   concat_ws SKIPS a null argument instead of writing an empty field. A row
--   with no reference would have produced a six-field content signature where
--   every other row produces seven — sliding the request number into the
--   reference's place and the direction into the request number's.
--
--   The value is stored as NULL rather than '', which is what the 577 imported
--   rows carry. Two spellings of "nothing" in one column is how a search for
--   the blanks starts missing half of them.
--
-- The empty-string coalesce is what the extraction already did in Python —
-- `(payment_ref or "").upper()` — so a dedup key computed here and one computed
-- there still agree for a row with no reference.
--
-- Safe to re-run.

begin;

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
