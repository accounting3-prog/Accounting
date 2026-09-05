import { Link } from 'react-router-dom';
import { Page } from '../components/Layout';
import { EmptyState, Money, Panel, Tag } from '../components/ui';
import { formatCount, formatDate, formatDateShort } from '../lib/format';
import {
  activityByMonth,
  getCards,
  getReviewItems,
  getTotals,
  getTransactions,
  spendByCurrencyOverall,
  topSuppliers,
} from '../lib/ledger';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (ym: string) => {
  const [y, m] = ym.split('-');
  return `${MONTHS[Number(m) - 1]} ${y.slice(2)}`;
};

/**
 * The headline.
 *
 * One figure dominates — what the accounts are worth — because that is the
 * question the page exists to answer. Whether anything needs a person is said
 * beside it in a line, not given a panel of its own: with every card reconciled
 * that panel was mostly restating "nothing is wrong" at the top of the screen.
 */
function Headline() {
  const totals = getTotals();
  const cards = getCards();
  const lastActivity = cards.map((c) => c.lastTransaction).filter(Boolean).sort().at(-1);
  const open = totals.needsReview + totals.excluded;
  const hasDifference = Math.abs(totals.reconciliationDifference) > 0.005;
  const negative = cards.filter((c) => c.ledgerBalance < 0);

  return (
    <section className="rounded-md border border-line bg-surface">
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4 px-5 py-5">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">
            Total across {totals.cardCount} cards
          </div>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-2.5">
            <span className="tnum text-[2rem] leading-none font-semibold tracking-tight text-ink">
              {totals.liveBalance.toLocaleString('en-US', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </span>
            <span className="text-sm font-medium text-ink-muted">AED</span>
          </div>
          <p className="mt-1.5 text-[13px] text-ink-muted">
            {formatCount(totals.transactionCount)} transactions · latest{' '}
            {formatDate(lastActivity)}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px]">
          {hasDifference ? (
            <span className="text-negative">
              <span className="font-medium">
                <Money amount={totals.reconciliationDifference} />
              </span>{' '}
              unreconciled on {totals.cardsWithDifference.length}{' '}
              {totals.cardsWithDifference.length === 1 ? 'card' : 'cards'}
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-ink-muted">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-positive" />
              Every card agrees with its statement
            </span>
          )}
          {open > 0 ? (
            <Link to="/review" className="font-medium text-review hover:underline underline-offset-2">
              {open} awaiting review
            </Link>
          ) : (
            <span className="flex items-center gap-1.5 text-ink-muted">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-positive" />
              Nothing awaiting review
            </span>
          )}
          {negative.length > 0 && (
            <span className="text-negative">
              {negative.length} {negative.length === 1 ? 'card is' : 'cards are'} below zero
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

/** Rendered only when something is actually wrong. */
function Exceptions() {
  const cards = getCards();
  const reviewItems = getReviewItems();
  const rows = cards
    .map((card) => ({
      card,
      open: reviewItems.filter((r) => r.card?.id === card.id).length,
    }))
    .filter((r) => r.open > 0 || Math.abs(r.card.reconciliationDifference) > 0.005);
  if (rows.length === 0) return null;

  return (
    <div className="mt-5">
      <Panel
        title="Needs attention"
        description="Cards where the statement and the ledger do not agree, or where a row is still awaiting a decision."
      >
        <ul className="divide-y divide-line">
          {rows.map(({ card, open }) => (
            <li key={card.id} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3">
              <div className="min-w-0">
                <Link
                  to={`/cards/${card.id}`}
                  className="text-[13px] font-semibold text-ink hover:text-accent hover:underline underline-offset-2"
                >
                  {card.name}
                </Link>
                {open > 0 && (
                  <span className="ml-2">
                    <Tag tone="review">{open} awaiting review</Tag>
                  </span>
                )}
              </div>
              <dl className="tnum flex gap-6 text-[13px]">
                <div className="text-right">
                  <dt className="text-xs text-ink-faint">Statement</dt>
                  <dd><Money amount={card.sourceBalance} code={false} /></dd>
                </div>
                <div className="text-right">
                  <dt className="text-xs text-ink-faint">Ledger</dt>
                  <dd className="font-semibold"><Money amount={card.ledgerBalance} code={false} /></dd>
                </div>
                <div className="text-right">
                  <dt className="text-xs text-ink-faint">Difference</dt>
                  <dd className="font-medium text-negative">
                    <Money amount={card.reconciliationDifference} code={false} />
                  </dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

/**
 * Spend and funding, month by month.
 *
 * Two bars per month rather than one net figure: a month that spent 6.7m and
 * received 6.8m is not a quiet month, and a net of +110k would say it was.
 */
function MonthlyActivity() {
  const months = activityByMonth(6);
  if (months.length < 2) return null;
  const peak = Math.max(
    ...months.map((m) => Math.max(Math.abs(m.spend), Math.abs(m.funding))),
    1,
  );

  return (
    <Panel
      title="Spend and funding by month"
      description="Shown separately. A net figure would hide a busy month that happened to balance."
    >
      <div className="space-y-2.5 px-4 py-4">
        {months.map((m) => (
          <div key={m.month} className="grid grid-cols-[54px_1fr] items-center gap-3">
            <div className="text-xs text-ink-muted">{monthLabel(m.month)}</div>
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <div
                  className="h-2 shrink-0 rounded-sm bg-negative/70"
                  style={{ width: `${(Math.abs(m.spend) / peak) * 70}%` }}
                />
                <span className="tnum shrink-0 text-[11px] text-ink-muted">
                  <Money amount={m.spend} code={false} />
                </span>
              </div>
              <div className="flex items-center gap-2">
                <div
                  className="h-2 shrink-0 rounded-sm bg-positive/60"
                  style={{ width: `${(Math.abs(m.funding) / peak) * 70}%` }}
                />
                <span className="tnum shrink-0 text-[11px] text-ink-muted">
                  <Money amount={m.funding} code={false} />
                </span>
              </div>
            </div>
          </div>
        ))}
        <div className="flex gap-4 border-t border-line pt-2.5 text-[11px] text-ink-muted">
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="h-2 w-3 rounded-sm bg-negative/70" /> spend
          </span>
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="h-2 w-3 rounded-sm bg-positive/60" /> funding
          </span>
        </div>
      </div>
    </Panel>
  );
}

export function Dashboard() {
  const cards = getCards();
  const totals = getTotals();
  const recent = [...getTransactions()]
    .filter((t) => t.txn_date)
    .sort((a, b) => (b.txn_date ?? '').localeCompare(a.txn_date ?? ''))
    .slice(0, 8);
  const currencies = spendByCurrencyOverall();
  const suppliers = topSuppliers(8);

  return (
    <Page
      title="Dashboard"
      description="Every balance is computed live from the ledger. The statement's own figure sits beside it, and any difference is stated rather than reconciled away."
    >
      <Headline />
      <Exceptions />

      <div className="mt-5">
        <Panel
          title="Card balances"
          description="Statement is what the source workbook shows. Ledger is the real transactions."
        >
          <div className="scroll-x">
            <table className="w-full min-w-[860px] border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-faint">
                  <th className="px-4 py-2 font-medium">Card</th>
                  <th className="px-4 py-2 text-right font-medium">Statement</th>
                  <th className="px-4 py-2 text-right font-medium">Ledger balance</th>
                  <th className="px-4 py-2 text-right font-medium">Spend</th>
                  <th className="px-4 py-2 text-right font-medium">Funding</th>
                  <th className="px-4 py-2 text-right font-medium">Last activity</th>
                </tr>
              </thead>
              <tbody>
                {cards.map((c) => (
                  <tr key={c.id} className="border-b border-line last:border-0 hover:bg-canvas">
                    <td className="px-4 py-2.5">
                      <Link
                        to={`/cards/${c.id}`}
                        className="font-medium text-ink hover:text-accent hover:underline underline-offset-2"
                      >
                        {c.name}
                      </Link>
                      <div className="mt-0.5 text-xs text-ink-faint">
                        {formatCount(c.transactionCount)} transactions
                        {Math.abs(c.reconciliationDifference) > 0.005 && (
                          <span className="ml-1.5 text-negative">
                            · <Money amount={c.reconciliationDifference} code={false} /> unreconciled
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right text-ink-muted">
                      <Money amount={c.sourceBalance} code={false} />
                    </td>
                    <td
                      className={`px-4 py-2.5 text-right text-[14px] font-semibold ${
                        c.ledgerBalance < 0 ? 'text-negative' : ''
                      }`}
                    >
                      <Money amount={c.ledgerBalance} code={false} />
                    </td>
                    <td className="px-4 py-2.5 text-right text-ink-muted">
                      <Money amount={c.totalSpend} code={false} />
                    </td>
                    <td className="px-4 py-2.5 text-right text-ink-muted">
                      <Money amount={c.totalFunding} code={false} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right text-ink-muted">
                      {formatDateShort(c.lastTransaction)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-line-strong bg-sunken font-medium">
                  <td className="px-4 py-2.5">Total, AED</td>
                  <td className="px-4 py-2.5 text-right text-ink-muted">
                    <Money amount={totals.sourceBalance} code={false} />
                  </td>
                  <td className="px-4 py-2.5 text-right text-[14px] font-semibold">
                    <Money amount={totals.liveBalance} code={false} />
                  </td>
                  <td colSpan={3} />
                </tr>
              </tfoot>
            </table>
          </div>
        </Panel>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2 2xl:grid-cols-3">
        <MonthlyActivity />

        <Panel
          title="Largest suppliers"
          description="By AED settled — the one figure comparable across currencies."
        >
          {suppliers.length === 0 ? (
            <EmptyState title="No spend recorded" />
          ) : (
            <table className="w-full border-collapse text-[13px]">
              <tbody>
                {suppliers.map((s) => (
                  <tr key={s.supplier} className="border-b border-line last:border-0">
                    <td className="max-w-[240px] truncate px-4 py-2" title={s.supplier}>
                      {s.supplier}
                    </td>
                    <td className="tnum whitespace-nowrap px-2 py-2 text-right text-xs text-ink-faint">
                      {s.count}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-right">
                      <Money amount={s.aed} code={false} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel
          title="Spend by original currency"
          description="One row per currency, never a total. A sum across currencies would look like money and would not be."
        >
          <div className="scroll-x">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-faint">
                  <th className="px-4 py-2 font-medium">Currency</th>
                  <th className="px-2 py-2 text-right font-medium">Txns</th>
                  <th className="px-4 py-2 text-right font-medium">Original</th>
                  <th className="px-4 py-2 text-right font-medium">AED</th>
                </tr>
              </thead>
              <tbody>
                {currencies.slice(0, 8).map((s) => (
                  <tr key={s.currency} className="border-b border-line last:border-0">
                    <td className="px-4 py-2 font-medium">{s.currency}</td>
                    <td className="tnum px-2 py-2 text-right text-xs text-ink-faint">
                      {formatCount(s.count)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-right">
                      <Money amount={s.originalTotal} currency={s.currency} code={false} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-right text-ink-muted">
                      <Money amount={s.aedTotal} code={false} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {currencies.length > 8 && (
            <p className="border-t border-line px-4 py-2 text-xs text-ink-muted">
              {currencies.length - 8} further currencies.{' '}
              <Link to="/transactions" className="text-accent hover:underline underline-offset-2">
                See all
              </Link>
            </p>
          )}
        </Panel>
      </div>

      <div className="mt-5">
        <Panel
          title="Recent transactions"
          action={
            <Link
              to="/transactions"
              className="text-[13px] font-medium text-accent hover:underline underline-offset-2"
            >
              View all
            </Link>
          }
        >
          {recent.length === 0 ? (
            <EmptyState title="No transactions yet" />
          ) : (
            <div className="scroll-x">
              <table className="w-full min-w-[700px] border-collapse text-[13px]">
                <thead>
                  <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-faint">
                    <th className="px-4 py-2 font-medium">Date</th>
                    <th className="px-4 py-2 font-medium">Supplier</th>
                    <th className="px-4 py-2 font-medium">Card</th>
                    <th className="px-4 py-2 text-right font-medium">Original</th>
                    <th className="px-4 py-2 text-right font-medium">AED</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((t) => {
                    const card = cards.find((c) => c.id === t.cardId);
                    const foreign = t.currency && t.currency !== 'AED';
                    return (
                      <tr key={t.id} className="border-b border-line last:border-0">
                        <td className="whitespace-nowrap px-4 py-2 text-ink-muted">
                          {formatDateShort(t.txn_date)}
                        </td>
                        <td className="max-w-[240px] truncate px-4 py-2">
                          {t.supplier ?? t.description ?? '—'}
                        </td>
                        <td className="max-w-[180px] truncate px-4 py-2 text-ink-muted">
                          {card?.name}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2 text-right text-ink-muted">
                          {foreign && t.original_amount != null ? (
                            <>
                              <Money amount={t.original_amount} currency={t.currency!} code={false} />
                              <span className="ml-1 text-xs text-ink-faint">{t.currency}</span>
                            </>
                          ) : (
                            <span className="text-ink-faint">—</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2 text-right">
                          <Money amount={t.amount_aed} signed tone="ledger" code={false} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      <p className="mt-5 text-xs text-ink-faint">
        Balances are recomputed from the transactions on every read, never stored.
      </p>
    </Page>
  );
}
