-- A row on a bank account cannot be taken off the balance.
--
-- A card statement is a record of what the company did and a line on it can be
-- wrong: entered twice, charged to the wrong card, a duplicate the importer
-- could not tell apart. Removing one is a real answer there.
--
-- A bank statement is not that. It is the bank's own record of what the bank
-- did, and the ledger's job against it is to agree with it. A row removed from
-- the balance makes the ledger disagree with the bank by exactly that amount,
-- and the reconciliation that would have caught it is the same arithmetic that
-- now reports a difference with no cause. Nothing about the account is served
-- by being able to do it.
--
-- So it is refused here rather than hidden in the screens. A button that is not
-- drawn is not a rule: the same call can be made from anywhere that can reach
-- the database, and the reason this matters is that the balance has to be
-- defensible, not that the button is inconvenient.
--
-- What remains possible on a bank row is everything that does not move money:
-- confirming it, putting a question on it, answering one, and filling in the
-- request number, which is the whole point of holding these rows.
--
-- No bank row is voided today, so this takes nothing away that is in use.
--
-- Rebuilt from the live definition, not from migration 010: pg_get_functiondef
-- is what the database is actually running, and the file it came from is two
-- migrations behind it.

begin;

create or replace function public.resolve_review_item(
    p_transaction_id uuid,
    p_action         text,
    p_rationale      text,
    p_review_reason  text default null::text)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    v_from   txn_status;
    v_to     txn_status;
    v_email  text;
    v_entry  txn_entry_type;
    v_card   text;
    v_type   text;
begin
    if not is_admin() then
        raise exception 'Only a named admin may resolve a review item'
            using errcode = '42501';
    end if;

    if coalesce(btrim(p_rationale), '') = '' then
        raise exception 'A reason is required. A balance changed without a stated reason is not auditable.';
    end if;

    select t.status, t.entry_type, c.name, c.card_type
      into v_from, v_entry, v_card, v_type
      from transactions t join cards c on c.id = t.card_id
     where t.id = p_transaction_id;
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

    -- The bank's record is not ours to edit. Taking a line off the balance
    -- would put the ledger out by that amount against a statement that still
    -- shows it, and the check that reconciles the two would then report a
    -- difference with nothing to explain it.
    if v_to = 'voided' and v_type = 'bank_account' then
        raise exception
            '% is a bank account. A line on a bank statement cannot be taken off the balance — the ledger has to agree with the bank.',
            v_card
            using errcode = '42501';
    end if;

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
$function$;

commit;
