-- CRITICAL: every view bypassed Row Level Security.
--
-- A PostgreSQL view executes with the privileges of its OWNER unless
-- security_invoker is set. These views are owned by postgres, so RLS on the
-- tables beneath them never applied to anyone querying the view. The policies
-- on `transactions` and `cards` were real and enforced — and completely
-- sidestepped by selecting from `transactions_searchable` instead.
--
-- The anon key is embedded in the public JavaScript bundle by design, because
-- RLS is what protects the data. With the views open, that reasoning failed:
-- anyone on the internet could read the entire ledger — all 1,949 transactions
-- with supplier names, amounts, request numbers and payment references, every
-- card balance, the review queue and the correction history — with a single
-- unauthenticated request.
--
-- security_invoker = on makes each view run as the user querying it, so the
-- underlying policies apply. Requires PostgreSQL 15+; this project is on 17.
--
-- Safe to re-run.

begin;

alter view card_balances            set (security_invoker = on);
alter view card_spend_by_currency   set (security_invoker = on);
alter view review_queue             set (security_invoker = on);
alter view transactions_searchable  set (security_invoker = on);
alter view transaction_history      set (security_invoker = on);

-- Belt and braces: anon has no business selecting from any of these even with
-- the invoker check in place. Revoking makes the refusal explicit rather than
-- relying on a policy returning zero rows.
revoke all on card_balances           from anon;
revoke all on card_spend_by_currency  from anon;
revoke all on review_queue            from anon;
revoke all on transactions_searchable from anon;
revoke all on transaction_history     from anon;

grant select on card_balances           to authenticated;
grant select on card_spend_by_currency  to authenticated;
grant select on review_queue            to authenticated;
grant select on transactions_searchable to authenticated;
grant select on transaction_history     to authenticated;

-- Guard against the same mistake on any view added later: this fails loudly if
-- a view in the public schema is left running as its owner.
do $$
declare
    leaky text;
begin
    select string_agg(c.relname, ', ')
      into leaky
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind = 'v'
       and not coalesce(
             (select option_value::boolean
                from pg_options_to_table(c.reloptions)
               where option_name = 'security_invoker'), false);
    if leaky is not null then
        raise exception
            'These views still run as their owner and would bypass RLS: %', leaky;
    end if;
end $$;

commit;
