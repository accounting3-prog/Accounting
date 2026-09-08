-- Putting a row into the review queue without saying why.
--
-- resolve_review_item changes a row's status and records the decision, but it
-- never touches review_reason — which is the sentence the queue actually shows.
-- So reopening a confirmed row put it in front of someone with no explanation
-- at all, which is the same fault as the four rows that sat there last week
-- describing a problem they did not have.
--
-- A queue entry that cannot say what is wrong is not a question, it is a chore.
--
-- Also here: rows dated before their card's opening date.
--
-- Those are stored, searchable, and deliberately excluded from every balance —
-- the opening date is the line before which nothing counts, and it exists so a
-- historical import cannot charge a card for a period it did not exist. But a
-- row sitting outside that line looks identical to one inside it on every
-- screen except the balance, and nothing ever pointed at it. Two IQD charges
-- dated three weeks before MASTERCARD 6404's records begin were found only
-- because a spreadsheet's own total disagreed by 3,785.90.
--
-- Safe to re-run.

begin;

-- ---------------------------------------------------------------------------
-- 1. A reason can accompany the status change
-- ---------------------------------------------------------------------------

drop function if exists resolve_review_item(uuid, text, text);

create or replace function resolve_review_item(
    p_transaction_id uuid,
    p_action         text,   -- confirm | void | leave_pending | reopen
    p_rationale      text,
    p_review_reason  text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_from   txn_status;
    v_to     txn_status;
    v_email  text;
    v_entry  txn_entry_type;
begin
    if not is_admin() then
        raise exception 'Only a named admin may resolve a review item'
            using errcode = '42501';
    end if;

    if coalesce(btrim(p_rationale), '') = '' then
        raise exception 'A reason is required. A balance changed without a stated reason is not auditable.';
    end if;

    select status, entry_type into v_from, v_entry
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

    -- A row put back in the queue must say what is being asked about it, or it
    -- arrives in front of someone as a task with no question.
    if v_to = 'needs_review' and coalesce(btrim(p_review_reason), '') = ''
       and coalesce(btrim((select review_reason from transactions where id = p_transaction_id)), '') = '' then
        raise exception
            'Say what needs reviewing. A row in the queue with no stated question is a chore, not a decision.';
    end if;

    select email into v_email from admins where user_id = auth.uid();

    insert into transaction_corrections
        (transaction_id, action, from_status, to_status, rationale, action_note,
         corrected_by)
    values
        (p_transaction_id,
         case when p_action = 'leave_pending' then 'annotated' else 'status_changed' end,
         v_from, v_to, btrim(p_rationale),
         p_action || coalesce(' by ' || v_email, ''),
         auth.uid());

    update transactions
       set status = v_to,
           review_reason = case
               when v_to = 'needs_review'
                    then coalesce(nullif(btrim(p_review_reason), ''), review_reason)
               -- A settled row keeps the question it was asked, so the history
               -- still reads as a question and an answer rather than an answer
               -- to nothing.
               else review_reason end,
           updated_at = now()
     where id = p_transaction_id
       and (v_to is distinct from v_from or p_review_reason is not null);

    return p_transaction_id;
end;
$$;

revoke all on function resolve_review_item from public, anon;
grant execute on function resolve_review_item to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Rows outside their card's opening date, so they stop being invisible
-- ---------------------------------------------------------------------------

drop view if exists rows_before_opening;

create view rows_before_opening as
select
    t.id            as transaction_id,
    c.id            as card_id,
    c.name          as card_name,
    to_char(t.txn_date, 'YYYY-MM-DD')     as txn_date,
    to_char(c.opening_date, 'YYYY-MM-DD') as opening_date,
    (c.opening_date - t.txn_date)         as days_before,
    coalesce(t.supplier_raw, t.description, '') as supplier,
    t.amount_aed,
    t.currency,
    t.status,
    coalesce(t.source_sheet, 'entered by hand') as came_from
from transactions t
join cards c on c.id = t.card_id
where c.opening_date is not null
  and t.txn_date < c.opening_date
  and t.status <> 'voided';

alter view rows_before_opening set (security_invoker = on);
revoke all on rows_before_opening from anon;
grant select on rows_before_opening to authenticated;

commit;
