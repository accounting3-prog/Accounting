-- The Iraqi Dinar.
--
-- The currency list was closed at the 28 codes the workbook contained, so that
-- a code outside it is reported as unrecognised rather than guessed at. That
-- rule is worth keeping; it just means a genuinely new currency has to be added
-- deliberately, which is what this does.
--
-- Three minor units, per ISO 4217 — the dinar divides into 1,000 fils, as the
-- Kuwaiti, Bahraini, Omani and Jordanian dinars already in the table do. It is
-- commonly quoted and paid in whole dinars, but the subdivision is what the
-- standard defines and what a settlement figure may carry, so it is recorded
-- honestly rather than rounded to the common case.
--
-- Nothing else changes. No existing row references IQD, so no balance moves and
-- no transaction is reinterpreted.
--
-- Safe to re-run.

begin;

insert into currencies (code, name, minor_units)
values ('IQD', 'Iraqi Dinar', 3)
on conflict (code) do update
   set name = excluded.name,
       minor_units = excluded.minor_units;

commit;
