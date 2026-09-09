-- MASTERCARD 6404's records start three weeks earlier than the workbook shows.
--
-- Two IQD charges at the DIVAN ERBIL HOTEL, 13 December 2025, reached the ledger
-- from a blank sheet rather than from the workbook — whose own sheet for this
-- card begins on 2 January 2026. The opening date was set from that sheet, so
-- the two rows sat outside it: stored, searchable, and counted in no balance.
--
-- The account owner confirms they belong to this card. The opening date moves
-- back to take them in.
--
-- WHAT MOVING IT LETS IN, CHECKED BEFORE MOVING IT
--
-- Exactly these two rows and nothing else. Every other transaction on the card
-- is dated 2 January 2026 or later, so the window between the old date and the
-- new one contains only them, plus two voided copies that stay voided:
--
--     2025-12-13   +1,611.02   DIVAN ERBIL HOTEL - RE 368   confirmed
--     2025-12-13   +2,174.88   DIVAN ERBIL HOTEL - RE 368   confirmed
--
--     77,329.80 + 3,785.90 = 81,115.70
--
-- The opening BALANCE does not change. 167,710.38 is what the statement says
-- the card held, and moving the date it is attached to does not alter the
-- figure — it changes only which transactions are counted after it. That is
-- worth being explicit about, because "the card opened earlier" and "the card
-- opened with a different amount" are different claims and only the first is
-- being made.
--
-- Safe to re-run.

begin;

update cards
   set opening_date = date '2025-12-13',
       updated_at = now()
 where name = 'MASTERCARD 6404 VPAY'
   and opening_date > date '2025-12-13';

insert into card_audit (card_id, card_name, action, detail)
select id, name, 'updated',
       jsonb_build_object(
         'opening_date', jsonb_build_object('from', '2026-01-02', 'to', '2025-12-13'),
         'opening_balance', 'unchanged at 167,710.38',
         'reason',
         'Two IQD charges at the DIVAN ERBIL HOTEL dated 13 Dec 2025 belong to this card, '
         'confirmed by the account owner. The workbook sheet begins on 2 Jan 2026, which is '
         'where the opening date came from, so they fell outside it and counted in no balance. '
         'Only those two rows lie between the old date and the new one. Balance 77,329.80 -> '
         '81,115.70.')
  from cards where name = 'MASTERCARD 6404 VPAY'
   and not exists (
       select 1 from card_audit a
        where a.card_id = cards.id and a.detail ? 'opening_date');

-- The two rows were raised for exactly this decision. Settle them, with the
-- answer recorded on each rather than left as an open question nobody returns to.
update transactions
   set status = 'confirmed', updated_at = now()
 where card_id = (select id from cards where name = 'MASTERCARD 6404 VPAY')
   and txn_date = date '2025-12-13'
   and status = 'needs_review';

insert into transaction_corrections
    (transaction_id, action, from_status, to_status, rationale, action_note)
select t.id, 'status_changed', 'needs_review', 'confirmed',
       'The account owner confirms these belong to this card. The card''s opening date moves '
       'back from 2 Jan 2026 to 13 Dec 2025 to take them in, and the balance becomes 81,115.70.',
       'resolved by migration 024'
  from transactions t
 where t.card_id = (select id from cards where name = 'MASTERCARD 6404 VPAY')
   and t.txn_date = date '2025-12-13'
   and t.status = 'confirmed'
   and not exists (
       select 1 from transaction_corrections tc
        where tc.transaction_id = t.id and tc.action_note = 'resolved by migration 024');

commit;
