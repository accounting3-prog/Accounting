-- An edit left the dedup key describing the row as it used to be.
--
-- dedup_key is a hash of a row's identifying content: card, date, signed
-- amount, supplier, payment reference, request number, direction, and which
-- occurrence of that combination it is. create_transaction computes it and then
-- looks it up, so an import that would recreate an existing row finds it
-- instead of writing it twice.
--
-- update_transaction changed the content and left the key alone. That was
-- harmless while it stayed theoretical, and stops being harmless now: filling
-- in a missing payment reference is exactly an edit to a field the key is built
-- from, and it is about to be done to hundreds of rows at once. After it, every
-- one of those rows carries a key describing a version of itself that no longer
-- exists — so re-importing the very same transaction would compute a different
-- key, find nothing, and write a duplicate.
--
-- The signature is spelled the same way create_transaction spells it, including
-- the empty-string coalesce for a null reference, so a key computed by an edit
-- and a key computed by an insert agree for the same content.
--
-- The occurrence is kept as it stands. It records which repeat of an identical
-- charge this row is, and editing a reference does not renumber history.
--
-- If the new key collides with another row's, the unique constraint refuses the
-- edit. That is correct: it means the change would make this row identical to
-- one already in the ledger, and the ledger should say so rather than absorb it.
--
-- Safe to re-run.

begin;

create or replace function transactions_refresh_dedup_key() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_signature text;
begin
    -- Only when something the key is built from actually moved. An edit to a
    -- note or an invoice number leaves the key alone, and rewriting it anyway
    -- would churn a column other code compares on.
    if new.card_id     is not distinct from old.card_id
   and new.txn_date    is not distinct from old.txn_date
   and new.amount_aed  is not distinct from old.amount_aed
   and new.supplier_raw is not distinct from old.supplier_raw
   and new.payment_ref is not distinct from old.payment_ref
   and new.req_number  is not distinct from old.req_number
   and new.direction   is not distinct from old.direction
   and new.entry_type  is not distinct from old.entry_type then
        return new;
    end if;

    v_signature := concat_ws('|',
        new.card_id::text,
        to_char(new.txn_date, 'YYYY-MM-DD'),
        to_char(new.amount_aed, 'FM9999999990.00'),
        upper(coalesce(new.supplier_raw, '')),
        upper(coalesce(btrim(new.payment_ref), '')),
        upper(coalesce(btrim(new.req_number), '')),
        coalesce(new.direction::text, new.entry_type::text));

    new.dedup_key := encode(
        sha256(convert_to(v_signature || '|#' || coalesce(new.occurrence, 1), 'UTF8')), 'hex');
    return new;
end;
$$;

drop trigger if exists transactions_refresh_dedup_key on transactions;
create trigger transactions_refresh_dedup_key
    before update on transactions
    for each row execute function transactions_refresh_dedup_key();

commit;
