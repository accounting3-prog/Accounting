-- Make supplier upserts idempotent when the country code is NULL.
--
-- Postgres treats NULLs as distinct in a UNIQUE constraint, so
-- `UNIQUE (name, country_code)` never matched for a supplier with no country
-- code and `ON CONFLICT ... DO UPDATE` inserted a fresh row on every import.
-- Re-running the historical import grew the supplier table from 702 rows to
-- 1,169: the 467 suppliers whose name carries no ISO-3166 suffix were
-- duplicated, and the copies were orphans that no transaction referenced.
--
-- NULLS NOT DISTINCT (PostgreSQL 15+) makes two NULL country codes collide, so
-- the upsert matches and the import becomes idempotent for suppliers as well as
-- transactions.
--
-- Safe to re-run.

begin;

-- 1. Re-point any transaction that landed on a duplicate at the row that was
--    created first, so nothing is left dangling when the copies are removed.
with canonical as (
    select id,
           first_value(id) over (
               partition by name, coalesce(country_code, '') order by created_at, id
           ) as keep_id
    from suppliers
)
update transactions t
   set supplier_id = c.keep_id
  from canonical c
 where t.supplier_id = c.id
   and c.id <> c.keep_id;

-- 2. Drop the duplicates now that nothing references them.
delete from suppliers s
 where exists (
     select 1 from suppliers other
      where other.name = s.name
        and other.country_code is not distinct from s.country_code
        and (other.created_at, other.id) < (s.created_at, s.id)
 );

-- 3. Replace the constraint so a NULL country code can collide.
alter table suppliers drop constraint if exists suppliers_name_country_code_key;
alter table suppliers add constraint suppliers_name_country_code_key
    unique nulls not distinct (name, country_code);

commit;
