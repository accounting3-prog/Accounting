-- A reference that can be typed in can be taken out again.
--
-- Clearing a request number and pressing Save was refused with "Nothing was
-- changed". The field really was empty on screen and really did hold a value
-- in the ledger, so the message was not just unhelpful, it was untrue.
--
-- Two separate faults, and both had to be fixed or the other would still show.
--
-- Here: only lpo_number and notes read an empty string as "remove this". Every
-- other reference used coalesce(p_x, x), which folds "not supplied" and
-- "supplied as empty" into the same thing, so an emptied field arrived looking
-- exactly like a field nobody touched. Migration 028 gave two fields the three
-- states they needed and left the other seven on two.
--
-- And in the edit screen, which sent null for an emptied box rather than the
-- empty string, so even the two fields that could be cleared were only
-- clearable by something other than the screen built to clear them.
--
-- The rule is written once now instead of nine times. Stated as a function, it
-- is also a thing a later field can be given rather than a pattern a later
-- field can quietly be written without.
--
-- Rebuilt from pg_get_functiondef — what the database is running — not from
-- migration 033, which is what it was last asked to run.

begin;

/**
 * What a text field becomes after an edit.
 *
 * Three states, not two:
 *   null           the field was not supplied — leave what is there
 *   '' or spaces   the field was supplied empty — remove what is there
 *   anything else  the field was supplied — trim it and store it
 *
 * The middle one is the whole point. A value that can be corrected but never
 * erased is a trap: it means a reference typed onto the wrong row stays on it
 * for good.
 */
create or replace function public.edited_text(p_supplied text, p_current text)
returns text
language sql
immutable
as $$
    select case
        when p_supplied is null     then p_current
        when btrim(p_supplied) = '' then null
        else btrim(p_supplied)
    end;
$$;

create or replace function public.update_transaction(
    p_id uuid,
    p_rationale text,
    p_txn_date date default null::date,
    p_amount_aed numeric default null::numeric,
    p_kind text default null::text,
    p_supplier text default null::text,
    p_supplier_country text default null::text,
    p_req_number text default null::text,
    p_payment_ref text default null::text,
    p_currency text default null::text,
    p_original_amount numeric default null::numeric,
    p_exchange_rate numeric default null::numeric,
    p_crm text default null::text,
    p_lpo_number text default null::text,
    p_invoice text default null::text,
    p_client text default null::text,
    p_sales_operation text default null::text,
    p_description text default null::text,
    p_notes text default null::text,
    p_clear_currency boolean default false)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    old            transactions%rowtype;
    v_direction    txn_direction;
    v_signed       numeric;
    v_supplier_raw text;
    v_supplier_id  uuid;
    v_currency     text;
    v_original     numeric;
    v_rate         numeric;
    v_req          text;
    v_pay          text;
    v_lpo          text;
    v_notes        text;
    v_invoice      text;
    v_crm          text;
    v_client       text;
    v_sales        text;
    v_description  text;
    v_changes      jsonb := '{}'::jsonb;
    v_email        text;
begin
    if not is_admin() then
        raise exception 'Only a named admin may edit a transaction'
            using errcode = '42501';
    end if;

    select * into old from transactions where id = p_id;
    if old.id is null then
        raise exception 'No such transaction';
    end if;
    if old.entry_type = 'reconciliation_adjustment' then
        raise exception
            'A reconciliation adjustment is not edited. Resolve it, or replace it with the real transaction.';
    end if;

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

    if p_amount_aed is null then
        v_signed := case when v_direction = 'spend' then -abs(old.amount_aed)
                         else abs(old.amount_aed) end;
    else
        if p_amount_aed <= 0 then
            raise exception 'Enter a positive AED amount; the direction comes from the type';
        end if;
        v_signed := case when v_direction = 'spend' then -p_amount_aed else p_amount_aed end;
    end if;

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
    if v_rate is not null and old.status <> 'needs_review'
       and not old.rate_accepted_incomplete
       and (v_currency is null or v_original is null) then
        raise exception
            'An exchange rate needs the currency and original amount it applied to, or the row must be marked for review';
    end if;
    if v_currency is not null and v_original is null and v_rate is not null then
        raise exception 'Enter the original amount in %, or clear the rate', v_currency;
    end if;

    -- Every reference reads an empty string as "remove it", by the one rule
    -- above. They used to differ from each other, which meant the answer to
    -- "can I take this out again" depended on which box it was typed into.
    v_req         := edited_text(p_req_number,      old.req_number);
    v_pay         := edited_text(p_payment_ref,     old.payment_ref);
    v_lpo         := edited_text(p_lpo_number,      old.lpo_number);
    v_notes       := edited_text(p_notes,           old.notes);
    v_invoice     := edited_text(p_invoice,         old.invoice);
    v_crm         := edited_text(p_crm,             old.crm);
    v_client      := edited_text(p_client,          old.client);
    v_sales       := edited_text(p_sales_operation, old.sales_operation);
    v_description := edited_text(p_description,     old.description);

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

    -- Clearing one records a 'to' of null, so removing a value is as traceable
    -- as setting it. That is what makes an erasable field safe to allow.
    if old.req_number is distinct from v_req then
        v_changes := v_changes || jsonb_build_object('req_number',
            jsonb_build_object('from', old.req_number, 'to', v_req));
    end if;
    if old.payment_ref is distinct from v_pay then
        v_changes := v_changes || jsonb_build_object('payment_ref',
            jsonb_build_object('from', old.payment_ref, 'to', v_pay));
    end if;
    if old.lpo_number is distinct from v_lpo then
        v_changes := v_changes || jsonb_build_object('lpo_number',
            jsonb_build_object('from', old.lpo_number, 'to', v_lpo));
    end if;
    if old.notes is distinct from v_notes then
        v_changes := v_changes || jsonb_build_object('notes',
            jsonb_build_object('from', old.notes, 'to', v_notes));
    end if;
    if old.invoice is distinct from v_invoice then
        v_changes := v_changes || jsonb_build_object('invoice',
            jsonb_build_object('from', old.invoice, 'to', v_invoice));
    end if;
    if old.crm is distinct from v_crm then
        v_changes := v_changes || jsonb_build_object('crm',
            jsonb_build_object('from', old.crm, 'to', v_crm));
    end if;
    if old.client is distinct from v_client then
        v_changes := v_changes || jsonb_build_object('client',
            jsonb_build_object('from', old.client, 'to', v_client));
    end if;
    if old.sales_operation is distinct from v_sales then
        v_changes := v_changes || jsonb_build_object('sales_operation',
            jsonb_build_object('from', old.sales_operation, 'to', v_sales));
    end if;
    if old.description is distinct from v_description then
        v_changes := v_changes || jsonb_build_object('description',
            jsonb_build_object('from', old.description, 'to', v_description));
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
        req_number      = v_req,
        payment_ref     = v_pay,
        lpo_number      = v_lpo,
        notes           = v_notes,
        crm             = v_crm,
        invoice         = v_invoice,
        client          = v_client,
        sales_operation = v_sales,
        description     = v_description,
        updated_at      = now()
      where id = p_id;

    select email into v_email from admins where user_id = auth.uid();
    insert into transaction_corrections
        (transaction_id, action, from_status, to_status, rationale, action_note,
         field_changes, corrected_by)
    values (p_id, 'annotated', old.status, old.status, nullif(btrim(p_rationale), ''),
            'edited by ' || coalesce(v_email, 'an admin'), v_changes, auth.uid());

    return p_id;
end;
$function$;

commit;
