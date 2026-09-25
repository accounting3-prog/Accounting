-- An edit no longer has to say why.
--
-- Asked for directly. The rule it removes was one of this ledger's first, and
-- it is worth writing down what is being given up rather than quietly
-- dropping it: an edit with no reason is still recorded — who changed it,
-- when, from what to what — but in six months the answer to "why is this
-- figure not what the statement says" is no longer in the system. It is in
-- whoever's memory made the change.
--
-- Everything else about the audit trail stands. The entry is still written,
-- still append-only, still names its author, and still carries the before and
-- after of every field that moved. Only the sentence is optional.
--
-- The column becomes nullable rather than taking a placeholder. "No reason
-- given" is a sentence nobody wrote, and a history that contains sentences
-- nobody wrote is worse than one with a blank.
--
-- resolve_review_item is NOT changed. Answering a flagged row is a different
-- act from correcting a figure — it is the decision itself, and the queue
-- exists to record decisions. If that should go too, it is a separate change.
--
-- Safe to re-run.

begin;

alter table transaction_corrections
    alter column rationale drop not null;

comment on column transaction_corrections.rationale is
    'Why the change was made, in the editor''s own words. Optional since 033: '
    'null means none was given, which is not the same as an empty one.';

drop function if exists update_transaction(
    uuid, text, date, numeric, text, text, text, text, text, text, numeric,
    numeric, text, text, text, text, text, text, text, boolean);

create or replace function update_transaction(
    p_id uuid,
    p_rationale text,
    p_txn_date date DEFAULT NULL::date,
    p_amount_aed numeric DEFAULT NULL::numeric,
    p_kind text DEFAULT NULL::text,
    p_supplier text DEFAULT NULL::text,
    p_supplier_country text DEFAULT NULL::text,
    p_req_number text DEFAULT NULL::text,
    p_payment_ref text DEFAULT NULL::text,
    p_currency text DEFAULT NULL::text,
    p_original_amount numeric DEFAULT NULL::numeric,
    p_exchange_rate numeric DEFAULT NULL::numeric,
    p_crm text DEFAULT NULL::text,
    p_lpo_number text DEFAULT NULL::text,
    p_invoice text DEFAULT NULL::text,
    p_client text DEFAULT NULL::text,
    p_sales_operation text DEFAULT NULL::text,
    p_description text DEFAULT NULL::text,
    p_notes text DEFAULT NULL::text,
    p_clear_currency boolean DEFAULT false
)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    old            transactions%rowtype;
    v_direction    txn_direction;
    v_signed       numeric;
    v_supplier_raw text;
    v_supplier_id  uuid;
    v_currency     text;
    v_original     numeric;
    v_rate         numeric;
    v_lpo          text;
    v_notes        text;
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

    -- Three states, not two. Null means "not supplied, leave it alone". An
    -- empty string means "remove it". Both of these are typed by hand on the
    -- edit screen, where a value that could be corrected but never erased
    -- would be a trap.
    v_lpo := case
        when p_lpo_number is null     then old.lpo_number
        when btrim(p_lpo_number) = '' then null
        else btrim(p_lpo_number)
    end;
    v_notes := case
        when p_notes is null     then old.notes
        when btrim(p_notes) = '' then null
        else btrim(p_notes)
    end;

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
    if old.req_number is distinct from coalesce(p_req_number, old.req_number) then
        v_changes := v_changes || jsonb_build_object('req_number',
            jsonb_build_object('from', old.req_number, 'to', coalesce(p_req_number, old.req_number)));
    end if;
    if old.payment_ref is distinct from coalesce(p_payment_ref, old.payment_ref) then
        v_changes := v_changes || jsonb_build_object('payment_ref',
            jsonb_build_object('from', old.payment_ref, 'to', coalesce(p_payment_ref, old.payment_ref)));
    end if;

    -- The five that were written but never recorded. Clearing one records a
    -- 'to' of null, so removing a value is as traceable as setting it.
    if old.lpo_number is distinct from v_lpo then
        v_changes := v_changes || jsonb_build_object('lpo_number',
            jsonb_build_object('from', old.lpo_number, 'to', v_lpo));
    end if;
    if old.notes is distinct from v_notes then
        v_changes := v_changes || jsonb_build_object('notes',
            jsonb_build_object('from', old.notes, 'to', v_notes));
    end if;
    if old.invoice is distinct from coalesce(p_invoice, old.invoice) then
        v_changes := v_changes || jsonb_build_object('invoice',
            jsonb_build_object('from', old.invoice, 'to', coalesce(p_invoice, old.invoice)));
    end if;
    if old.crm is distinct from coalesce(p_crm, old.crm) then
        v_changes := v_changes || jsonb_build_object('crm',
            jsonb_build_object('from', old.crm, 'to', coalesce(p_crm, old.crm)));
    end if;
    if old.client is distinct from coalesce(p_client, old.client) then
        v_changes := v_changes || jsonb_build_object('client',
            jsonb_build_object('from', old.client, 'to', coalesce(p_client, old.client)));
    end if;
    if old.sales_operation is distinct from coalesce(p_sales_operation, old.sales_operation) then
        v_changes := v_changes || jsonb_build_object('sales_operation',
            jsonb_build_object('from', old.sales_operation,
                              'to', coalesce(p_sales_operation, old.sales_operation)));
    end if;
    if old.description is distinct from coalesce(p_description, old.description) then
        v_changes := v_changes || jsonb_build_object('description',
            jsonb_build_object('from', old.description, 'to', coalesce(p_description, old.description)));
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
        lpo_number      = v_lpo,
        notes           = v_notes,
        crm             = coalesce(p_crm, crm),
        invoice         = coalesce(p_invoice, invoice),
        client          = coalesce(p_client, client),
        sales_operation = coalesce(p_sales_operation, sales_operation),
        description     = coalesce(p_description, description),
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

revoke all on function update_transaction from public, anon;
grant execute on function update_transaction to authenticated;

commit;
