-- Editing an existing transaction.
--
-- Until now a wrong figure could only be voided and re-entered, which leaves
-- two rows where one transaction happened and makes the ledger read as though
-- money moved twice and came back.
--
-- This edits in place, but never quietly: it is admin-only, requires a stated
-- reason, and records the before and after of every field it changes in
-- transaction_corrections. The source columns are untouchable — the sheet name,
-- row number, raw date text, raw currency text and the original rate formula
-- are what make a figure traceable back to the workbook, and an edit must not
-- be able to rewrite the evidence it is being judged against.
--
-- Safe to re-run.

begin;

alter table transaction_corrections
    add column if not exists field_changes jsonb;

comment on column transaction_corrections.field_changes is
    'Before and after for each field an edit changed, so the previous value is '
    'recoverable from the audit trail alone.';

create or replace function update_transaction(
    p_id                uuid,
    p_rationale         text,
    p_txn_date          date    default null,
    p_amount_aed        numeric default null,   -- positive; sign comes from kind
    p_kind              text    default null,   -- purchase | refund | funding | fee
    p_supplier          text    default null,
    p_supplier_country  text    default null,
    p_req_number        text    default null,
    p_payment_ref       text    default null,
    p_currency          text    default null,
    p_original_amount   numeric default null,
    p_exchange_rate     numeric default null,
    p_crm               text    default null,
    p_lpo_number        text    default null,
    p_invoice           text    default null,
    p_client            text    default null,
    p_sales_operation   text    default null,
    p_description       text    default null,
    p_notes             text    default null,
    p_clear_currency    boolean default false   -- explicitly blank the currency
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    old            transactions%rowtype;
    v_direction    txn_direction;
    v_signed       numeric;
    v_supplier_raw text;
    v_supplier_id  uuid;
    v_currency     text;
    v_original     numeric;
    v_rate         numeric;
    v_changes      jsonb := '{}'::jsonb;
    v_email        text;
begin
    if not is_admin() then
        raise exception 'Only a named admin may edit a transaction'
            using errcode = '42501';
    end if;
    if coalesce(btrim(p_rationale), '') = '' then
        raise exception 'A reason is required. A figure changed without a stated reason is not auditable.';
    end if;

    select * into old from transactions where id = p_id;
    if old.id is null then
        raise exception 'No such transaction';
    end if;
    if old.entry_type = 'reconciliation_adjustment' then
        raise exception
            'A reconciliation adjustment is not edited. Resolve it, or replace it with the real transaction.';
    end if;

    -- Direction: from the new kind if one was given, otherwise unchanged.
    if p_kind is null then
        v_direction := old.direction;
    else
        case p_kind
            when 'purchase' then v_direction := 'spend';
            when 'fee'      then v_direction := 'spend';
            when 'refund'   then v_direction := 'funding';
            when 'funding'  then v_direction := 'funding';
            else raise exception 'Unknown transaction type: %', p_kind;
        end case;
    end if;

    -- Amount is supplied positive; the sign is applied here, as on create.
    if p_amount_aed is null then
        v_signed := case
            when v_direction = 'spend' then -abs(old.amount_aed)
            else abs(old.amount_aed)
        end;
    else
        if p_amount_aed <= 0 then
            raise exception 'Enter a positive AED amount; the direction comes from the type';
        end if;
        v_signed := case
            when v_direction = 'spend' then -p_amount_aed else p_amount_aed
        end;
    end if;

    -- Currency: cleared only on an explicit instruction, never by omission.
    if p_clear_currency then
        v_currency := null; v_original := null; v_rate := null;
    else
        v_currency := coalesce(p_currency, old.currency);
        v_original := coalesce(p_original_amount, old.original_amount);
        v_rate     := coalesce(p_exchange_rate, old.exchange_rate);
    end if;

    if v_currency is not null and not exists (select 1 from currencies where code = v_currency) then
        raise exception 'Unrecognised currency: %', v_currency;
    end if;
    if v_currency = 'AED' and v_rate is not null then
        raise exception 'An AED transaction cannot carry an exchange rate';
    end if;
    if v_currency is not null and old.status <> 'needs_review'
       and not old.rate_accepted_incomplete
       and (v_original is null or v_rate is null) then
        raise exception
            'A converted transaction needs both an original amount and a rate, or must be marked for review';
    end if;

    v_supplier_raw := case
        when p_supplier is null then old.supplier_raw
        else btrim(p_supplier) ||
             coalesce(' ' || coalesce(p_supplier_country,
                        substring(old.supplier_raw from '\s(\d{3})\s*$')), '')
    end;

    if p_supplier is not null then
        insert into suppliers (name, country_code)
        values (btrim(p_supplier),
                coalesce(p_supplier_country,
                         substring(old.supplier_raw from '\s(\d{3})\s*$')))
        on conflict (name, country_code) do update set name = excluded.name
        returning id into v_supplier_id;
    else
        v_supplier_id := old.supplier_id;
    end if;

    -- Record what actually changed, field by field, before writing.
    if old.txn_date is distinct from coalesce(p_txn_date, old.txn_date) then
        v_changes := v_changes || jsonb_build_object('txn_date',
            jsonb_build_object('from', old.txn_date, 'to', coalesce(p_txn_date, old.txn_date)));
    end if;
    if old.amount_aed is distinct from v_signed then
        v_changes := v_changes || jsonb_build_object('amount_aed',
            jsonb_build_object('from', old.amount_aed, 'to', v_signed));
    end if;
    if old.direction is distinct from v_direction then
        v_changes := v_changes || jsonb_build_object('direction',
            jsonb_build_object('from', old.direction, 'to', v_direction));
    end if;
    if old.supplier_raw is distinct from v_supplier_raw then
        v_changes := v_changes || jsonb_build_object('supplier',
            jsonb_build_object('from', old.supplier_raw, 'to', v_supplier_raw));
    end if;
    if old.currency is distinct from v_currency then
        v_changes := v_changes || jsonb_build_object('currency',
            jsonb_build_object('from', old.currency, 'to', v_currency));
    end if;
    if old.original_amount is distinct from v_original then
        v_changes := v_changes || jsonb_build_object('original_amount',
            jsonb_build_object('from', old.original_amount, 'to', v_original));
    end if;
    if old.exchange_rate is distinct from v_rate then
        v_changes := v_changes || jsonb_build_object('exchange_rate',
            jsonb_build_object('from', old.exchange_rate, 'to', v_rate));
    end if;
    if old.req_number is distinct from coalesce(p_req_number, old.req_number) then
        v_changes := v_changes || jsonb_build_object('req_number',
            jsonb_build_object('from', old.req_number, 'to', coalesce(p_req_number, old.req_number)));
    end if;
    if old.payment_ref is distinct from coalesce(p_payment_ref, old.payment_ref) then
        v_changes := v_changes || jsonb_build_object('payment_ref',
            jsonb_build_object('from', old.payment_ref, 'to', coalesce(p_payment_ref, old.payment_ref)));
    end if;

    if v_changes = '{}'::jsonb then
        raise exception 'Nothing was changed';
    end if;

    update transactions set
        txn_date        = coalesce(p_txn_date, txn_date),
        amount_aed      = v_signed,
        direction       = v_direction,
        supplier_id     = v_supplier_id,
        supplier_raw    = v_supplier_raw,
        currency        = v_currency,
        original_amount = v_original,
        exchange_rate   = v_rate,
        normalized_exchange_rate = case
            when v_original > 0 then round(abs(v_signed) / v_original, 10) end,
        req_number      = coalesce(p_req_number, req_number),
        payment_ref     = coalesce(p_payment_ref, payment_ref),
        crm             = coalesce(p_crm, crm),
        lpo_number      = coalesce(p_lpo_number, lpo_number),
        invoice         = coalesce(p_invoice, invoice),
        client          = coalesce(p_client, client),
        sales_operation = coalesce(p_sales_operation, sales_operation),
        description     = coalesce(p_description, description),
        notes           = coalesce(p_notes, notes),
        updated_at      = now()
        -- Deliberately absent: card_id, source_sheet, source_row,
        -- source_date_raw, currency_raw, exchange_rate_formula, dedup_key,
        -- occurrence, included_in_source_balance. Those record where the figure
        -- came from. An edit that could rewrite them would be editing the
        -- evidence, not the entry.
      where id = p_id;

    select email into v_email from admins where user_id = auth.uid();
    insert into transaction_corrections
        (transaction_id, action, from_status, to_status, rationale, action_note,
         field_changes, corrected_by)
    values (p_id, 'annotated', old.status, old.status, btrim(p_rationale),
            'edited by ' || coalesce(v_email, 'an admin'), v_changes, auth.uid());

    return p_id;
end;
$$;

comment on function update_transaction is
    'The only path for editing a transaction. Admin-only, requires a reason, '
    'records every field''s before and after, and cannot touch the columns that '
    'trace a figure back to the source workbook.';

revoke all on function update_transaction from public, anon;
grant execute on function update_transaction to authenticated;

commit;
