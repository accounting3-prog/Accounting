-- One import batch has no record of what it created.
--
-- The browser import of 8 Sep 2026 opened and closed a batch, but the version
-- of finish_import_batch running at the time did not store the list of rows the
-- import wrote. Migration 018 added that; this fills in the one batch that ran
-- between the two.
--
-- The information is not being invented. Every row that import created carries
-- the file name and its source row in its notes, and has a 'created' entry in
-- transaction_corrections naming who wrote it and when. This reads that back.
--
-- It is marked `reconstructed` so nobody later mistakes a record assembled
-- afterwards for one captured at the time. The two are worth the same only when
-- nothing has been deleted in between, and that is a claim about the past that
-- this migration is not in a position to make.
--
-- Safe to re-run: it only touches a batch that still has no snapshot.

begin;

update import_batches b
   set snapshot = jsonb_build_object(
         'reversal', 'void every transaction listed in created_ids',
         'reconstructed', true,
         'reconstructed_at', now(),
         'note', 'Assembled from transaction notes and the history after the fact, '
                 'because the import ran before finish_import_batch recorded this.',
         'created_ids', coalesce((
             select jsonb_agg(jsonb_build_object(
                        'id', t.id,
                        'amount_aed', t.amount_aed,
                        'txn_date', t.txn_date,
                        'source_row', substring(t.notes from 'row (\d+)'))
                    order by t.created_at)
               from transactions t
              where t.notes like '%' || b.source || '%'
                and t.created_at >= b.created_at), '[]'::jsonb))
 where b.dry_run = false
   and b.snapshot is null;

commit;
