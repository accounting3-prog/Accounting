-- An import kept no record of what it did NOT import.
--
-- A file of 36 rows was uploaded and 31 transactions appeared. The balance was
-- 64,297.17 short of the figure on the sheet, and there was no way to find out
-- why: the five rows that never reached the database left no trace anywhere.
-- Not in transactions, obviously; but not in import_batches either, because the
-- file importer in the browser never wrote to it — those tables were built for
-- the one-off workbook import and the UI grew up beside them.
--
-- The screen said "31 imported" while the run was on screen. Close the tab and
-- the question becomes unanswerable, which is how it ended up being answered by
-- subtracting two balances and guessing.
--
-- So the browser import now opens a batch before it writes anything and closes
-- it afterwards, recording every row of the file it did not create and why:
-- refused by the database, stopped by the parser, or left unticked. A row left
-- out on purpose and a row lost by accident look identical in a balance; they
-- do not look identical here.
--
-- Both functions are security definer and check the caller, like every other
-- write path. Neither touches transactions.
--
-- Safe to re-run.

begin;

-- ---------------------------------------------------------------------------
-- 1. Opening a batch
-- ---------------------------------------------------------------------------

create or replace function begin_import_batch(
    p_source     text,
    p_row_count  integer,
    p_parser     text default 'browser xlsx/csv'
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_id uuid;
begin
    if not is_admin() then
        raise exception 'Only a named admin may import' using errcode = '42501';
    end if;

    insert into import_batches (source, parser, dry_run, row_count, imported_by)
    values (coalesce(nullif(btrim(p_source), ''), 'an uploaded file'),
            p_parser, false, coalesce(p_row_count, 0), auth.uid())
    returning id into v_id;
    return v_id;
end;
$$;

revoke all on function begin_import_batch from public, anon;
grant execute on function begin_import_batch to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Closing it, with everything the file held that the ledger did not take
-- ---------------------------------------------------------------------------

-- p_left_out is one object per row that did not become a transaction:
--   { "source_row": 7, "supplier": "...", "amount": -1234.56,
--     "kind": "refused" | "stopped" | "unticked", "detail": "why" }
create or replace function finish_import_batch(
    p_batch_id  uuid,
    p_inserted  integer,
    p_left_out  jsonb default '[]'::jsonb,
    p_card_name text default null
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
    v_row   jsonb;
    v_count integer := 0;
begin
    if not is_admin() then
        raise exception 'Only a named admin may import' using errcode = '42501';
    end if;
    if not exists (select 1 from import_batches where id = p_batch_id) then
        raise exception 'No such import batch';
    end if;

    for v_row in select * from jsonb_array_elements(coalesce(p_left_out, '[]'::jsonb))
    loop
        insert into import_anomalies (batch_id, card_name, source_row, kind, detail)
        values (
            p_batch_id,
            p_card_name,
            nullif(v_row ->> 'source_row', '')::integer,
            'import_' || coalesce(nullif(v_row ->> 'kind', ''), 'left_out'),
            concat_ws(' — ',
                nullif(v_row ->> 'supplier', ''),
                case when v_row ? 'amount' and v_row ->> 'amount' <> ''
                     then (v_row ->> 'amount') || ' AED' end,
                coalesce(nullif(v_row ->> 'detail', ''), 'not imported')));
        v_count := v_count + 1;
    end loop;

    update import_batches
       set inserted_count = coalesce(p_inserted, 0),
           skipped_count  = v_count,
           anomaly_count  = v_count
     where id = p_batch_id;

    return v_count;
end;
$$;

revoke all on function finish_import_batch from public, anon;
grant execute on function finish_import_batch to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Reading it back
-- ---------------------------------------------------------------------------

-- import_anomalies had no read policy of its own and inherited the schema's
-- generic one. Stated explicitly here so the Checks page can show what a file
-- left behind, to anyone who may write.
drop policy if exists import_anomalies_read on import_anomalies;
create policy import_anomalies_read on import_anomalies
    for select to authenticated using (true);

drop policy if exists import_batches_read on import_batches;
create policy import_batches_read on import_batches
    for select to authenticated using (true);

drop view if exists import_history;

create view import_history as
select
    b.id            as batch_id,
    b.source,
    b.created_at,
    coalesce(a.email, 'the system')       as imported_by,
    b.row_count     as rows_in_file,
    b.inserted_count as imported,
    b.skipped_count  as left_out,
    -- The figure that answers "why is the balance short": what the file held
    -- and the ledger did not take.
    (select coalesce(jsonb_agg(jsonb_build_object(
                'source_row', ia.source_row,
                'kind',       replace(ia.kind, 'import_', ''),
                'detail',     ia.detail)
             order by ia.source_row), '[]'::jsonb)
       from import_anomalies ia where ia.batch_id = b.id) as left_out_rows
from import_batches b
left join admins a on a.user_id = b.imported_by
where b.dry_run = false;

alter view import_history set (security_invoker = on);
revoke all on import_history from anon;
grant select on import_history to authenticated;

commit;
