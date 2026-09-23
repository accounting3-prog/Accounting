-- A request number is no longer required.
--
-- 016 made the payment reference optional and deliberately left this rule
-- alone, with its reason written down: only 4 of the workbook's 1,948 rows
-- lacked a request number, so the rule held in practice. It held because every
-- row came from a card sheet where the number is assigned before the charge.
--
-- A bank statement is not that. The bank writes what it writes, and the
-- reference is attached afterwards by the person reconciling it: 36 of the 186
-- rows in the KSA workbook have none yet, and inventing one to get the import
-- through would put a number in the ledger that means nothing.
--
-- THE SAME THREE TRAPS 016 DOCUMENTED, STILL SET FOR THIS FIELD
--
-- They are silent faults, not errors, and each would have surfaced as
-- corrupted data rather than a failed import:
--
--   upper(NULL) is NULL, and NULL = anything is NULL rather than true. The
--   two-minute double-submit guard and the occurrence counter both compare on
--   the request number. With a null one, neither would ever match: a
--   double-clicked form would write the charge twice, and every row would be
--   counted as occurrence 1 — the number the dedup key is built from, so
--   re-uploading a statement would have written every unreferenced row again.
--
--   concat_ws SKIPS a null argument instead of writing an empty field. A row
--   with no request number would produce a six-field signature where every
--   other row produces seven, sliding the direction into the request number's
--   place and making two different rows hash alike.
--
--   An empty string and NULL are different values in a column. Stored as '',
--   a blank reference would not be found by the "no request number" filter,
--   so the rows most needing one would be the ones it never showed.
--
-- All three are fixed here, the same way 016 fixed them for the payment
-- reference.
--
-- Safe to re-run.

begin;

-- The signature as 029 left it, including p_statement_balance.
drop function if exists create_transaction(
    uuid, date, text, numeric, text, text, text, text, numeric, numeric, text,
    text, text, text, text, text, text, text, boolean, boolean, text, numeric);

create or replace function create_transaction(
    p_card_id uuid,
    p_txn_date date,
    p_kind text,
    p_amount_aed numeric,
    p_supplier text,
    p_req_number text,
    p_payment_ref text,
    p_currency text DEFAULT NULL::text,
    p_original_amount numeric DEFAULT NULL::numeric,
    p_exchange_rate numeric DEFAULT NULL::numeric,
    p_supplier_country text DEFAULT NULL::text,
    p_crm text DEFAULT NULL::text,
    p_lpo_number text DEFAULT NULL::text,
    p_invoice text DEFAULT NULL::text,
    p_client text DEFAULT NULL::text,
    p_sales_operation text DEFAULT NULL::text,
    p_description text DEFAULT NULL::text,
    p_notes text DEFAULT NULL::text,
    p_needs_review boolean DEFAULT false,
    p_allow_duplicate boolean DEFAULT false,
    p_review_reason text DEFAULT NULL::text,
    p_statement_balance numeric DEFAULT NULL::numeric
)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
           and upper(coalesce(req_number, ''))  = upper(coalesce(btrim(p_req_number), ''))
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
        upper(coalesce(btrim(p_req_number), '')),
        coalesce(v_direction::text, v_entry_type::text));

    select count(*) + 1 into v_occurrence
      from transactions
     where card_id = p_card_id
       and txn_date = p_txn_date
       and amount_aed = v_signed
       and upper(coalesce(supplier_raw, '')) = upper(v_supplier_raw)
       and upper(coalesce(payment_ref, '')) = upper(coalesce(btrim(p_payment_ref), ''))
       and upper(coalesce(req_number, ''))  = upper(coalesce(btrim(p_req_number), ''));

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
        sales_operation, occurrence, dedup_key, review_reason, statement_balance
    ) values (
        p_card_id, v_entry_type, v_status, p_description, p_notes, p_txn_date,
        v_supplier_id, v_supplier_raw, v_signed, v_direction,
        true, p_currency, p_original_amount, p_exchange_rate,
        case when p_original_amount > 0
             then round(abs(v_signed) / p_original_amount, 10) end,
        nullif(btrim(p_req_number), ''), p_lpo_number, p_invoice, nullif(btrim(p_payment_ref), ''),
        p_crm, p_client, p_sales_operation, v_occurrence, v_dedup,
        -- The caller's own words when it has them. The default is what this
        -- said before, so the manual form is unchanged.
        case when p_needs_review
             then coalesce(nullif(btrim(p_review_reason), ''),
                           'Marked for review at manual entry: a currency, amount or rate was not known.')
             else null end,
        p_statement_balance
    ) returning id into v_id;

    return v_id;
end;
$function$;

revoke all on function create_transaction from public, anon;
grant execute on function create_transaction to authenticated;

commit;
