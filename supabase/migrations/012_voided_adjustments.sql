-- Fix: a voided reconciliation adjustment still counted in
-- review_adjustments_total.
--
-- Every other figure in card_balances excludes voided rows. This one did not,
-- so after voiding the RAK 9825 adjustment the card page went on reporting
-- "an unconfirmed adjustment sits in this balance — 1,718.02" about money that
-- had been explicitly written off. The balances themselves were right; the
-- explanation beside them was not, which is its own kind of wrong in a ledger.
--
-- Safe to re-run.

begin;

create or replace view card_balances as
select
    c.id   as card_id,
    c.name as card_name,
    c.settlement_currency,
    c.opening_balance,
    c.opening_date,

    c.opening_balance + coalesce(sum(t.amount_aed)
        filter (where t.included_in_source_balance
                  and t.status <> 'voided'), 0)                as source_balance,

    c.opening_balance + coalesce(sum(t.amount_aed)
        filter (where t.entry_type = 'source_transaction'
                  and t.status <> 'voided'), 0)                as ledger_balance,

    coalesce(sum(t.amount_aed)
        filter (where t.included_in_source_balance
                  and t.status <> 'voided'), 0)
  - coalesce(sum(t.amount_aed)
        filter (where t.entry_type = 'source_transaction'
                  and t.status <> 'voided'), 0)   as reconciliation_difference,

    -- A voided adjustment is a decision already taken. It stays on the row for
    -- the audit trail but must not be reported as still outstanding.
    coalesce(sum(t.amount_aed)
        filter (where t.entry_type = 'reconciliation_adjustment'
                  and t.status <> 'voided'), 0)
                                                  as review_adjustments_total,
    count(*) filter (where t.entry_type = 'reconciliation_adjustment'
                       and t.status <> 'voided')  as review_adjustments_count,

    coalesce(sum(t.amount_aed) filter (where t.direction = 'spend'
                                         and t.status <> 'voided'), 0) as total_spend,
    coalesce(sum(t.amount_aed) filter (where t.direction = 'funding'
                                         and t.status <> 'voided'), 0) as total_funding,

    count(*) filter (where t.entry_type = 'source_transaction'
                       and t.status <> 'voided')                 as transaction_count,
    count(*) filter (where t.status = 'needs_review')             as needs_review_count,
    count(*) filter (where t.status = 'excluded_from_source_balance')
                                                                  as excluded_count,
    min(t.txn_date) filter (where t.status <> 'voided') as first_transaction,
    max(t.txn_date) filter (where t.status <> 'voided') as last_transaction
from cards c
left join transactions t
       on t.card_id = c.id
      and (c.opening_date is null or t.txn_date >= c.opening_date)
group by c.id;

alter view card_balances set (security_invoker = on);
revoke all on card_balances from anon;
grant select on card_balances to authenticated;

commit;
