-- A history of everything, and two ways to catch a figure that is wrong.
--
-- Part 1 — HISTORY
--
-- The pieces existed but did not add up to an answer to "who did this?".
-- Edits and status changes were recorded in transaction_corrections, card
-- changes in card_audit, access changes in admin_audit — but the creation of a
-- transaction was recorded nowhere, so the most common event in the system was
-- the one event with no history. A row could appear and nothing said who put it
-- there.
--
-- So: create_transaction now writes its own history entry, and a single view
-- puts every event in one chronological feed.
--
-- Deletion does not appear in the feed because there is no way to delete. There
-- is no delete policy on transactions, and no function that removes one; a row
-- that should not count is voided, which is a status change and is recorded.
-- That is deliberate — a ledger you can delete from is not a ledger — and the
-- adversarial suite proves an admin cannot delete a transaction or an audit row.
--
-- Part 2 — CHECKS
--
-- Two views for finding a figure that should not be there:
--
--   possible_duplicates  rows that look like the same payment entered twice.
--   amount_outliers      a figure far outside what this supplier normally
--                        costs on this card — the shape of a typo, where 1,200
--                        was typed as 12,000 or a decimal point moved.
--
-- Neither changes anything. They are questions to look at, not verdicts: this
-- ledger genuinely contains repeated identical charges, which is why the
-- importer keeps them and why these are reported rather than removed.
--
-- Safe to re-run.

begin;

-- ---------------------------------------------------------------------------
-- 1. 'created' becomes a recordable action
-- ---------------------------------------------------------------------------

alter table transaction_corrections drop constraint if exists transaction_corrections_action_check;
alter table transaction_corrections add constraint transaction_corrections_action_check
    check (action in ('created', 'superseded', 'status_changed', 'linked', 'annotated'));

-- The rationale for a creation is the note the row was entered with, and a
-- creation has no "from" status. Existing rows are untouched.
alter table transaction_corrections add column if not exists action_note text;
alter table transaction_corrections add column if not exists field_changes jsonb;

-- Who did it, kept on the row itself rather than looked up later.
--
-- Two reasons, and the first is the one that matters. auth.users is not
-- readable by the authenticated role, so a view that resolved the email by
-- joining it would fail for every signed-in user — which is exactly what the
-- first version of this migration did. The second: an audit trail that loses
-- the name when the account is removed is not an audit trail, and access is
-- revoked from admins routinely.
alter table transaction_corrections add column if not exists corrected_by_email text;

update transaction_corrections tc
   set corrected_by_email = a.email
  from admins a
 where a.user_id = tc.corrected_by
   and tc.corrected_by_email is null;

-- ---------------------------------------------------------------------------
-- 2. create_transaction records who created the row
-- ---------------------------------------------------------------------------

create or replace function log_transaction_created(
    p_id uuid, p_note text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_email text;
    v_row   transactions%rowtype;
begin
    -- security definer, so it must say for itself who is allowed to write —
    -- not rely on the grants around it or on the fact that only an admin can
    -- reach the insert that triggers it. A history entry attributed to someone
    -- who was not there is worse than no history entry.
    if not is_admin() then
        raise exception 'Only a named admin may write to the history'
            using errcode = '42501';
    end if;

    select * into v_row from transactions where id = p_id;
    if v_row.id is null then return; end if;
    select email into v_email from admins where user_id = auth.uid();

    insert into transaction_corrections
        (transaction_id, action, from_status, to_status, rationale, action_note,
         field_changes, corrected_by, corrected_by_email)
    values (p_id, 'created', null, v_row.status,
            coalesce(nullif(btrim(p_note), ''), 'Entered into the ledger'),
            'created by ' || coalesce(v_email, 'an admin'),
            jsonb_build_object(
                'txn_date',   v_row.txn_date,
                'amount_aed', v_row.amount_aed,
                'direction',  v_row.direction,
                'supplier',   v_row.supplier_raw,
                'currency',   v_row.currency,
                'payment_ref', v_row.payment_ref),
            auth.uid(), v_email);
end;
$$;

revoke all on function log_transaction_created from public, anon;

-- Wired as a trigger rather than as a line inside create_transaction, for two
-- reasons. It cannot be bypassed: any future write path, however it is added,
-- is recorded. And it does not require restating create_transaction, which is
-- a hundred lines of validation that should not be copied around to add a log
-- line to it.
--
-- The guard on auth.uid() is what keeps the original bulk import out of the
-- feed. That import ran server-side with no signed-in user and is already
-- recorded, batch and anomalies and all, in import_batches — 1,948 entries
-- saying "imported by nobody in particular" would bury the events a person
-- actually performed.
create or replace function transactions_log_insert() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if auth.uid() is not null then
        perform log_transaction_created(new.id, new.notes);
    end if;
    return null;
end;
$$;

drop trigger if exists transactions_log_insert on transactions;
create trigger transactions_log_insert
    after insert on transactions
    for each row execute function transactions_log_insert();

-- Every other writer of this table — update_transaction, resolve_review_item —
-- sets corrected_by but not the email. Filled in here rather than by restating
-- each of those functions, so a future writer cannot forget it either.
create or replace function transaction_corrections_stamp_actor() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if new.corrected_by_email is null and new.corrected_by is not null then
        select email into new.corrected_by_email from admins where user_id = new.corrected_by;
    end if;
    return new;
end;
$$;

drop trigger if exists transaction_corrections_stamp_actor on transaction_corrections;
create trigger transaction_corrections_stamp_actor
    before insert on transaction_corrections
    for each row execute function transaction_corrections_stamp_actor();

-- ---------------------------------------------------------------------------
-- 3. One feed for every event in the system
-- ---------------------------------------------------------------------------

drop view if exists activity_log;

create view activity_log as
-- Transactions: created, edited, status changed.
select
    tc.created_at,
    'transaction'::text                              as area,
    tc.action                                        as action,
    coalesce(tc.corrected_by_email, a.email, 'an admin') as actor,
    c.name                                           as card_name,
    t.id                                             as transaction_id,
    coalesce(t.supplier_raw, t.description, '(no supplier)') as subject,
    t.amount_aed                                     as amount_aed,
    to_char(t.txn_date, 'YYYY-MM-DD')                as txn_date,
    tc.rationale                                     as rationale,
    tc.action_note                                   as note,
    tc.field_changes                                 as changes,
    tc.from_status::text                             as from_status,
    tc.to_status::text                               as to_status
from transaction_corrections tc
join transactions t on t.id = tc.transaction_id
join cards c        on c.id = t.card_id
left join admins a  on a.user_id = tc.corrected_by

union all

-- Cards: created, updated, deactivated.
select
    ca.created_at,
    'card',
    ca.action,
    coalesce(ca.performed_by_email, a2.email, 'the system'),
    ca.card_name,
    null::uuid,
    ca.card_name,
    null::numeric,
    null::text,
    coalesce(ca.detail ->> 'reason', 'Card ' || ca.action),
    null::text,
    ca.detail,
    null::text,
    null::text
from card_audit ca
left join admins a2 on a2.user_id = ca.performed_by

union all

-- Access: granted, revoked.
select
    aa.created_at,
    'access',
    aa.action,
    coalesce(aa.performed_by_email, 'the system'),
    null::text,
    null::uuid,
    aa.target_email,
    null::numeric,
    null::text,
    coalesce(aa.rationale, 'Write access ' || aa.action),
    null::text,
    null::jsonb,
    null::text,
    null::text
from admin_audit aa;

alter view activity_log set (security_invoker = on);

-- The owner asked that the history be theirs to read. security_invoker means
-- this view is subject to the reader's own row-level policies, and the policy
-- below narrows transaction_corrections to admins — so a viewer signed in to
-- read the ledger sees the ledger, and not who touched it.
revoke all on activity_log from anon, authenticated;
grant select on activity_log to authenticated;

drop policy if exists transaction_corrections_read on transaction_corrections;
create policy transaction_corrections_read on transaction_corrections
    for select to authenticated using (is_admin());

drop policy if exists card_audit_read on card_audit;
create policy card_audit_read on card_audit
    for select to authenticated using (is_admin());

-- admin_audit too. It was readable by anyone signed in, so a viewer could see
-- who had been given and denied write access — which is the same question the
-- rest of this feed answers, and belongs behind the same door.
drop policy if exists admin_audit_read on admin_audit;
create policy admin_audit_read on admin_audit
    for select to authenticated using (is_admin());

-- ---------------------------------------------------------------------------
-- 4. Rows that look like the same payment twice
-- ---------------------------------------------------------------------------

drop view if exists possible_duplicates;

create view possible_duplicates as
with candidates as (
    select
        t.card_id,
        c.name as card_name,
        t.txn_date,
        t.amount_aed,
        coalesce(t.supplier_raw, t.description, '') as supplier,
        coalesce(t.payment_ref, '')                 as payment_ref,
        count(*)                                    as copies,
        array_agg(t.id order by t.source_row nulls last, t.created_at) as transaction_ids,
        array_agg(coalesce(t.source_row, 0) order by t.source_row nulls last, t.created_at) as source_rows,
        -- A row imported from the workbook and a row typed in later are a more
        -- interesting pair than two rows from the same sheet, which the source
        -- itself already showed side by side.
        count(distinct coalesce(t.source_sheet, 'manual entry')) as distinct_sources,
        min(t.created_at) as first_entered,
        max(t.created_at) as last_entered
    from transactions t
    join cards c on c.id = t.card_id
    where t.entry_type = 'source_transaction'
      and t.status <> 'voided'
    group by 1, 2, 3, 4, 5, 6
    having count(*) > 1
)
select
    card_id, card_name, txn_date,
    to_char(txn_date, 'YYYY-MM-DD') as txn_date_text,
    amount_aed, supplier, payment_ref,
    copies, transaction_ids, source_rows, distinct_sources,
    first_entered, last_entered,
    -- How much money is at stake if these really are duplicates.
    abs(amount_aed) * (copies - 1) as amount_at_risk,
    -- Entered on different days, or from different places, is the pattern of a
    -- mistake. The same sheet listing a repeated charge is the pattern of a
    -- business that buys the same thing twice, and this ledger is full of them.
    (distinct_sources > 1 or last_entered - first_entered > interval '1 minute')
                                                     as entered_separately
from candidates;

alter view possible_duplicates set (security_invoker = on);
revoke all on possible_duplicates from anon;
grant select on possible_duplicates to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Figures that have the shape of a typing mistake
-- ---------------------------------------------------------------------------
--
-- The first attempt here reported anything ten times its supplier's usual
-- figure, and the result was almost entirely legitimate: HEXNODE costs 28.43 a
-- month and 1,807 a year, OPENAI and AIRTABLE the same shape. "Unusually large"
-- is not the same question as "typed wrong", and a check that cries wolf is
-- worse than no check.
--
-- What a mis-keyed figure actually looks like is a decimal point in the wrong
-- place: the same supplier, the same card, and an amount that is almost exactly
-- ten, a hundred or a thousand times another amount already on file. That is a
-- narrow, checkable shape, and it names the row it should be compared against.

drop view if exists amount_outliers;
drop view if exists suspect_amounts;

-- distinct on keeps one row per suspect transaction. Without it a 2,000,000
-- figure that matches six separate 200,000 rows is reported six times, and the
-- list stops looking like a list of problems. The nearest comparison in time is
-- kept, and a same-day pair is preferred over any other, because two charges to
-- one supplier on one day differing by exactly ten times is the strongest form
-- this signal takes.
create view suspect_amounts as
select distinct on (t.id)
    t.id                                  as transaction_id,
    t.card_id,
    c.name                                as card_name,
    to_char(t.txn_date, 'YYYY-MM-DD')     as txn_date,
    coalesce(t.supplier_raw, t.description, '') as supplier,
    t.amount_aed,
    o.id                                  as compare_with_id,
    to_char(o.txn_date, 'YYYY-MM-DD')     as compare_with_date,
    o.amount_aed                          as compare_with_amount,
    round(abs(t.amount_aed) / nullif(abs(o.amount_aed), 0))::int as factor,
    (o.txn_date = t.txn_date)             as same_day,
    abs(o.txn_date - t.txn_date)          as days_apart,
    t.currency,
    t.source_sheet,
    t.source_row
from transactions t
join cards c on c.id = t.card_id
join transactions o
      on o.card_id = t.card_id
     and o.id <> t.id
     and o.entry_type = 'source_transaction'
     and o.status <> 'voided'
     and coalesce(o.supplier_raw, o.description, '')
       = coalesce(t.supplier_raw, t.description, '')
     -- Almost exactly 10x, 100x or 1000x: a decimal point one, two or three
     -- places out. The half-percent tolerance allows for a genuine difference
     -- in tax or fees between the two charges without opening the net wide.
     and abs(o.amount_aed) > 0
     and abs(abs(t.amount_aed) / abs(o.amount_aed) - round(abs(t.amount_aed) / abs(o.amount_aed)))
         < 0.005
     and round(abs(t.amount_aed) / abs(o.amount_aed)) in (10, 100, 1000)
where t.entry_type = 'source_transaction'
  and t.status <> 'voided'
  -- Only the larger of the pair is reported, so a match appears once.
  and abs(t.amount_aed) > abs(o.amount_aed)
  -- Below this, a decimal slip is not worth a person's morning.
  and abs(t.amount_aed) >= 500
order by t.id, (o.txn_date = t.txn_date) desc, abs(o.txn_date - t.txn_date);

alter view suspect_amounts set (security_invoker = on);
revoke all on suspect_amounts from anon;
grant select on suspect_amounts to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Exchange rates that disagree with every other row in the same currency
-- ---------------------------------------------------------------------------
--
-- normalized_exchange_rate is the rate a row actually settled at: its AED
-- amount divided by its original amount. Every row in one currency in one month
-- should agree closely, so one that does not means either the AED figure or the
-- original amount was entered wrong — and the row's own arithmetic cannot tell
-- which, so it is reported rather than corrected.

drop view if exists suspect_rates;

create view suspect_rates as
with monthly as (
    select
        currency,
        date_trunc('month', txn_date)::date as month,
        percentile_cont(0.5) within group (order by normalized_exchange_rate)::numeric as median_rate,
        count(*) as n
    from transactions
    where entry_type = 'source_transaction'
      and status <> 'voided'
      and normalized_exchange_rate is not null
      and normalized_exchange_rate > 0
    group by 1, 2
    having count(*) >= 4
)
select
    t.id                              as transaction_id,
    t.card_id,
    c.name                            as card_name,
    to_char(t.txn_date, 'YYYY-MM-DD') as txn_date,
    coalesce(t.supplier_raw, t.description, '') as supplier,
    t.currency,
    t.original_amount,
    t.amount_aed,
    round(t.normalized_exchange_rate, 6) as settled_rate,
    round(m.median_rate, 6)              as usual_rate,
    round(t.normalized_exchange_rate / nullif(m.median_rate, 0), 2) as times_usual,
    m.n                                  as comparable_rows,
    t.source_sheet,
    t.source_row
from transactions t
join cards c   on c.id = t.card_id
join monthly m on m.currency = t.currency
              and m.month = date_trunc('month', t.txn_date)::date
where t.entry_type = 'source_transaction'
  and t.status <> 'voided'
  and t.normalized_exchange_rate is not null
  and m.median_rate > 0
  -- A fifth of the usual rate, or five times it. Real movement inside a month
  -- is a few percent; this is the range where something was keyed wrong.
  and (t.normalized_exchange_rate > m.median_rate * 5
    or t.normalized_exchange_rate < m.median_rate / 5);

alter view suspect_rates set (security_invoker = on);
revoke all on suspect_rates from anon;
grant select on suspect_rates to authenticated;

commit;
