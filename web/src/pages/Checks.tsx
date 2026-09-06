/**
 * Standing checks: the same payment entered twice, and a figure typed wrong.
 *
 * These are questions, not verdicts, and the page is written to say so. This
 * ledger genuinely contains repeated identical charges — the workbook lists
 * them, the same hotel billed twice on one day — so a screen that called every
 * repeat an error would train its reader to ignore it.
 *
 * That is why the duplicates are split in two. A pair the workbook itself
 * listed is shown quietly as something to be aware of. A pair entered
 * separately — different sittings, or one from the workbook and one typed in
 * later — is the shape of the same payment being recorded twice, and that is
 * the list worth acting on.
 *
 * Nothing on this page changes anything. Acting on a finding means opening the
 * transaction and voiding or correcting it through the audited path, which
 * leaves its own entry in the History.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Page } from '../components/Layout';
import {
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  Money,
  Notice,
  Panel,
  Stat,
  Tag,
} from '../components/ui';
import { listChecks, type ChecksResult } from '../lib/api';
import { formatCount } from '../lib/format';

const num = (v: string | number) => Number(v);

export function Checks() {
  const [checks, setChecks] = useState<ChecksResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showExpected, setShowExpected] = useState(false);

  const load = () => {
    setChecks(null);
    setError(null);
    listChecks().then((r) => (r.ok ? setChecks(r.checks) : setError(r.error)));
  };
  useEffect(load, []);

  const split = useMemo(() => {
    const all = checks?.duplicates ?? [];
    return {
      separate: all.filter((d) => d.entered_separately),
      expected: all.filter((d) => !d.entered_separately),
    };
  }, [checks]);

  const findings =
    (split.separate.length ?? 0) +
    (checks?.amounts.length ?? 0) +
    (checks?.rates.length ?? 0);

  return (
    <Page
      title="Checks"
      description="Three questions asked of the whole ledger every time this page opens: was a payment recorded twice, was a figure keyed with the decimal in the wrong place, and does an exchange rate disagree with the rest of its month."
      actions={<Button onClick={load}>Run again</Button>}
    >
      {error ? (
        <ErrorState title="Could not run the checks" detail={error} onRetry={load} />
      ) : checks === null ? (
        <LoadingState label="Checking the ledger" />
      ) : (
        <>
          {findings === 0 ? (
            <div className="mb-5">
              <Notice tone="accent" title="Nothing needs your attention">
                No payment was recorded twice by mistake, no amount has the shape of a
                misplaced decimal point, and every exchange rate agrees with the others in
                its month.
                {split.expected.length > 0 && (
                  <>
                    {' '}
                    {formatCount(split.expected.length)} groups of identical rows do exist,
                    but the workbook itself lists them side by side — they are repeated
                    charges, not entry errors.
                  </>
                )}
              </Notice>
            </div>
          ) : (
            <div className="mb-5 grid gap-3 sm:grid-cols-3">
              <Stat
                label="Recorded twice"
                value={formatCount(split.separate.length)}
                tone={split.separate.length ? 'negative' : 'plain'}
                hint="Entered on separate occasions"
              />
              <Stat
                label="Decimal point"
                value={formatCount(checks.amounts.length)}
                tone={checks.amounts.length ? 'review' : 'plain'}
                hint="Exactly 10x, 100x or 1000x another charge"
              />
              <Stat
                label="Exchange rates"
                value={formatCount(checks.rates.length)}
                tone={checks.rates.length ? 'review' : 'plain'}
                hint="Out of step with their month"
              />
            </div>
          )}

          {/* ------------------------------------------ recorded twice */}
          <div className="mb-5">
            <Panel
              title="The same payment, recorded twice"
              description="Identical card, date, amount and supplier, entered on separate occasions — the shape of one payment being recorded more than once."
            >
              {split.separate.length === 0 ? (
                <EmptyState
                  title="Nothing was recorded twice"
                  description="Every set of identical rows in the ledger came from one sheet, listed that way at source."
                />
              ) : (
                <ul className="divide-y divide-line">
                  {split.separate.map((d) => (
                    <li key={d.transaction_ids.join()} className="px-4 py-3">
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <Tag tone="negative">{d.copies} copies</Tag>
                        <span className="text-[13px] font-medium text-ink">{d.supplier}</span>
                        <span className="tnum text-[13px]">
                          <Money amount={num(d.amount_aed)} signed code={false} />
                        </span>
                        <span className="text-xs text-ink-faint">
                          {d.txn_date_text} · {d.card_name}
                        </span>
                        <span className="ml-auto tnum text-[13px] text-negative">
                          <Money amount={num(d.amount_at_risk)} code={false} /> if duplicated
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-ink-muted">
                        {d.distinct_sources > 1
                          ? 'From different sources — one imported, one entered by hand.'
                          : 'Entered at different times from the same source.'}
                        {d.payment_ref && <> Payment reference {d.payment_ref}.</>}{' '}
                        <Link
                          to={`/transactions?q=${encodeURIComponent(d.supplier)}`}
                          className="underline decoration-line underline-offset-2 hover:decoration-ink-muted"
                        >
                          Open these rows
                        </Link>
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          {/* ------------------------------------------ decimal point */}
          <div className="mb-5">
            <Panel
              title="A decimal point in the wrong place"
              description="An amount that is almost exactly ten, a hundred or a thousand times another charge to the same supplier on the same card."
            >
              {checks.amounts.length === 0 ? (
                <EmptyState title="No amount has that shape" />
              ) : (
                <ul className="divide-y divide-line">
                  {checks.amounts.map((a) => (
                    <li key={a.transaction_id} className="px-4 py-3">
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <Tag tone={a.same_day ? 'negative' : 'review'}>{a.factor}× </Tag>
                        <span className="text-[13px] font-medium text-ink">{a.supplier}</span>
                        <span className="text-xs text-ink-faint">
                          {a.txn_date} · {a.card_name}
                        </span>
                        {a.same_day && <Tag tone="negative">same day</Tag>}
                      </div>
                      <p className="mt-1 flex flex-wrap items-baseline gap-x-2 text-[13px]">
                        <span className="tnum font-medium">
                          <Money amount={num(a.amount_aed)} signed code={false} />
                        </span>
                        <span className="text-ink-faint">against</span>
                        <span className="tnum">
                          <Money amount={num(a.compare_with_amount)} signed code={false} />
                        </span>
                        <span className="text-xs text-ink-faint">
                          of {a.compare_with_date}
                          {a.same_day
                            ? ''
                            : ` — ${a.days_apart} day${a.days_apart === 1 ? '' : 's'} apart`}
                        </span>
                      </p>
                      <p className="mt-1 text-xs text-ink-muted">
                        {a.source_sheet
                          ? `From ${a.source_sheet}, row ${a.source_row}. Check it against the statement before changing anything.`
                          : 'Entered by hand. Check it against the receipt before changing anything.'}{' '}
                        <Link
                          to={`/transactions?q=${encodeURIComponent(a.supplier)}`}
                          className="underline decoration-line underline-offset-2 hover:decoration-ink-muted"
                        >
                          Open both rows
                        </Link>
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          {/* ------------------------------------------ rates */}
          <div className="mb-5">
            <Panel
              title="An exchange rate out of step with its month"
              description="The rate a row actually settled at — its AED amount divided by the original amount — against what every other row in that currency settled at the same month."
            >
              {checks.rates.length === 0 ? (
                <EmptyState
                  title="Every rate agrees with its month"
                  description="Where a rate is out, either the AED figure or the original amount was keyed wrong, and the row's own arithmetic cannot say which."
                />
              ) : (
                <ul className="divide-y divide-line">
                  {checks.rates.map((r) => (
                    <li key={r.transaction_id} className="px-4 py-3">
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <Tag tone="review">{r.currency}</Tag>
                        <span className="text-[13px] font-medium text-ink">{r.supplier}</span>
                        <span className="text-xs text-ink-faint">
                          {r.txn_date} · {r.card_name}
                        </span>
                      </div>
                      <p className="mt-1 tnum text-[13px] text-ink-muted">
                        settled at {String(r.settled_rate)}, the month's usual is{' '}
                        {String(r.usual_rate)} over {r.comparable_rows} rows —{' '}
                        {String(r.times_usual)}× out. {String(r.original_amount)} {r.currency}{' '}
                        became <Money amount={num(r.amount_aed)} signed code={false} />.
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          {/* ------------------------------------------ the expected repeats */}
          {split.expected.length > 0 && (
            <Panel
              title="Repeated charges the workbook itself lists"
              description="Identical rows that arrived together from one sheet. Kept, because the source shows them that way — a business really does buy the same thing twice."
              action={
                <Button variant="ghost" onClick={() => setShowExpected((v) => !v)}>
                  {showExpected ? 'Hide' : `Show ${formatCount(split.expected.length)}`}
                </Button>
              }
            >
              {showExpected ? (
                <ul className="divide-y divide-line">
                  {split.expected.map((d) => (
                    <li
                      key={d.transaction_ids.join()}
                      className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-4 py-2 text-[13px]"
                    >
                      <span className="text-ink-faint">×{d.copies}</span>
                      <span className="font-medium text-ink">{d.supplier}</span>
                      <span className="tnum">
                        <Money amount={num(d.amount_aed)} signed code={false} />
                      </span>
                      <span className="text-xs text-ink-faint">
                        {d.txn_date_text} · {d.card_name} · rows {d.source_rows.join(', ')}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-4 py-3 text-[13px] text-ink-muted">
                  {formatCount(split.expected.length)} groups, {' '}
                  {formatCount(
                    split.expected.reduce((s, d) => s + (d.copies - 1), 0),
                  )}{' '}
                  rows beyond the first. None of them was entered twice by this system.
                </p>
              )}
            </Panel>
          )}
        </>
      )}
    </Page>
  );
}
