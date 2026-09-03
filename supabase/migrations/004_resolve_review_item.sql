-- Resolving a review item.
--
-- The review queue's buttons change what a card is worth, so they go through
-- the same kind of audited, admin-only path as every other write. Nothing is
-- ever deleted: the transaction keeps its row, its history and its source
-- traceability, and each decision is recorded in transaction_corrections with
-- who made it, what it changed, and why.
--
-- Safe to re-run.

begin;

-- A rationale is part of the record, so the audit table must demand one.
alter table transaction_corrections
    add column if not exists action_note text;

create or replace function resolve_review_item(
    p_transaction_id uuid,
    p_action         text,   -- confirm | void | leave_pending | reopen
    p_rationale      text
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
        -- The row is a real transaction. It counts in the official live
        -- balance and leaves the queue. For a row the workbook's own formula
        -- chain skipped, included_in_source_balance stays false: that remains
        -- a true statement about the workbook, and it is what keeps the
        -- reconciliation difference visible.
        when 'confirm' then v_to := 'confirmed';

        -- Not a real charge. It drops out of the live balance but keeps its
        -- row, so the decision stays visible rather than the money simply
        -- disappearing.
        when 'void' then v_to := 'voided';

        -- Explicitly deferred. The status does not move; the decision to wait
        -- is still recorded, so "nobody looked at it" and "we looked and chose
        -- to wait" are distinguishable later.
        when 'leave_pending' then v_to := v_from;

        -- Put a settled row back in the queue.
        when 'reopen' then v_to := 'needs_review';

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
         p_action || coalesce(' by ' || v_email, ''),
         auth.uid());

    if v_to is distinct from v_from then
        update transactions
           set status = v_to,
               updated_at = now()
         where id = p_transaction_id;
    end if;

    return p_transaction_id;
end;
$$;

comment on function resolve_review_item is
    'The only path for resolving a review item. Admin-only, requires a stated '
    'reason, records the decision in transaction_corrections, and never '
    'deletes a row.';

revoke all on function resolve_review_item from public, anon;
grant execute on function resolve_review_item to authenticated;

-- The history of a row, for the audit trail in the UI.
create or replace view transaction_history as
select tc.transaction_id,
       tc.action,
       tc.from_status,
       tc.to_status,
       tc.rationale,
       tc.action_note,
       tc.created_at,
       a.email as corrected_by_email
  from transaction_corrections tc
  left join admins a on a.user_id = tc.corrected_by
 order by tc.created_at desc;

commit;
