-- Allow an incomplete conversion to be accepted deliberately.
--
-- `conversion_is_complete` permits a row to hold an exchange rate without a
-- currency and original amount only while it is flagged `needs_review`. That is
-- the right default: an unexplained half-conversion should not sit quietly in a
-- confirmed ledger.
--
-- But it left no way to say "we looked, the AED settlement is correct, the
-- source simply never stated the currency, and we accept it" — confirming such
-- a row failed outright. Eight rows in this workbook are exactly that.
--
-- So the constraint gains a third way to be satisfied: an explicit, recorded
-- acceptance. The distinction that matters is preserved — an incomplete
-- conversion is either awaiting review or has been signed off by a named admin
-- with a reason in transaction_corrections. It is never merely confirmed by
-- accident.
--
-- Safe to re-run.

begin;

alter table transactions
    add column if not exists rate_accepted_incomplete boolean not null default false;

comment on column transactions.rate_accepted_incomplete is
    'Set when an admin has explicitly accepted a conversion the source left '
    'incomplete — a rate with no stated currency, or no recoverable original '
    'amount. The reason is recorded in transaction_corrections. Never set '
    'automatically on import.';

alter table transactions drop constraint if exists conversion_is_complete;
alter table transactions add constraint conversion_is_complete check (
    exchange_rate is null
    or status = 'needs_review'
    or rate_accepted_incomplete
    or (currency is not null and original_amount is not null)
);

-- resolve_review_item marks the acceptance when confirming such a row, so the
-- caller cannot confirm an incomplete conversion without it being recorded.
create or replace function resolve_review_item(
    p_transaction_id uuid,
    p_action         text,
    p_rationale      text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_from       txn_status;
    v_to         txn_status;
    v_email      text;
    v_incomplete boolean;
begin
    if not is_admin() then
        raise exception 'Only a named admin may resolve a review item'
            using errcode = '42501';
    end if;

    if coalesce(btrim(p_rationale), '') = '' then
        raise exception 'A reason is required. A balance changed without a stated reason is not auditable.';
    end if;

    select status,
           (exchange_rate is not null
            and (currency is null or original_amount is null))
      into v_from, v_incomplete
      from transactions where id = p_transaction_id;

    if v_from is null then
        raise exception 'No such transaction';
    end if;

    case p_action
        when 'confirm'       then v_to := 'confirmed';
        when 'void'          then v_to := 'voided';
        when 'leave_pending' then v_to := v_from;
        when 'reopen'        then v_to := 'needs_review';
        else raise exception 'Unknown action: %', p_action;
    end case;

    select email into v_email from admins where user_id = auth.uid();

    insert into transaction_corrections
        (transaction_id, action, from_status, to_status, rationale, action_note,
         corrected_by)
    values
        (p_transaction_id,
         case when p_action = 'leave_pending' then 'annotated' else 'status_changed' end,
         v_from, v_to, btrim(p_rationale),
         p_action || coalesce(' by ' || v_email, '')
           || case when v_incomplete and p_action = 'confirm'
                   then ' (incomplete conversion accepted)' else '' end,
         auth.uid());

    if v_to is distinct from v_from then
        update transactions
           set status = v_to,
               -- Confirming a row whose conversion the source left incomplete
               -- records that acceptance explicitly.
               rate_accepted_incomplete =
                   rate_accepted_incomplete or (v_incomplete and p_action = 'confirm'),
               updated_at = now()
         where id = p_transaction_id;
    end if;

    return p_transaction_id;
end;
$$;

revoke all on function resolve_review_item from public, anon;
grant execute on function resolve_review_item to authenticated;

commit;
