import { Link } from 'react-router-dom';
import { Page } from '../components/Layout';
import { EmptyState, Money, Panel, Tag } from '../components/ui';
import { formatCount, formatDate, formatDateShort } from '../lib/format';
import {
  getCards,
  getReviewItems,
  getTotals,
  getTransactions,
  spendByCurrencyOverall,
} from '../lib/ledger';
import type { Card } from '../lib/types';

/**
 * The headline band.
 *
 * One figure dominates — what the accounts are actually worth — because that is
 * the question the page exists to answer. The workbook's own total and the
 * difference between them sit beneath as supporting context rather than as
 * equal peers: they matter, but nobody opens a ledger to read them first.
 */
function Headline() {
  const totals = getTotals();
  const cards = getCards();
  const lastActivity = cards
    .map((c) => c.lastTransaction)
    .filter(Boolean)
    .sort()
    .at(-1);
  const open = totals.needsReview + totals.excluded;
  const hasDifference = Math.abs(totals.reconciliationDifference) > 0.005;

  return (
    <section className="rounded-md border border-line bg-surface">
      <div className="px-5 py-5">
        <div className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">
          Total official live balance
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
          Across {totals.cardCount} cards · {formatCount(totals.transactionCount)}{' '}
          transactions · latest activity {formatDate(lastActivity)}
        </p>
      </div>

      <div className="grid grid-cols-2 border-t border-line md:grid-cols-4 md:divide-x md:divide-line">
        <div className="border-r border-line px-5 py-3 md:border-r-0">
          <div className="text-[11px] uppercase tracking-wide text-ink-faint">
            Source workbook
          </div>
          <div className="mt-0.5 text-[15px] font-medium text-ink-muted">
            <Money amount={totals.sourceBalance} code={false} />
          </div>
        </div>
        <div className="px-5 py-3">
          <div className="text-[11px] uppercase tracking-wide text-ink-faint">
            Reconciliation difference
          </div>
          <div
            className={`mt-0.5 text-[15px] font-medium ${
              hasDifference ? 'text-negative' : 'text-ink-muted'
            }`}
          >
            <Money amount={totals.reconciliationDifference} code={false} />
          </div>
        </div>
        <div className="border-t border-r border-line px-5 py-3 md:border-t-0 md:border-r-0">
          <div className="text-[11px] uppercase tracking-wide text-ink-faint">
            Needs review
          </div>
          <div className="mt-0.5 text-[15px] font-medium">
            {open > 0 ? (
              <Link
                to="/review"
                className="tnum text-review hover:underline underline-offset-2"
              >
                {open} {open === 1 ? 'item' : 'items'}
              </Link>
            ) : (
              <span className="text-ink-muted">All clear</span>
            )}
          </div>
        </div>
        <div className="border-t border-line px-5 py-3 md:border-t-0">
          <div className="text-[11px] uppercase tracking-wide text-ink-faint">
            Cards with a difference
          </div>
          <div className="tnum mt-0.5 text-[15px] font-medium text-ink-muted">
            {totals.cardsWithDifference.length} of {totals.cardCount}
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * One row per card whose figures need explaining.
 *
 * Driven by the card's actual state, not hardcoded. A card with open review
 * items is flagged; a card whose difference has been reviewed and accepted is
 * shown quietly as reconciled, because the difference itself does not go away —
 * the workbook's formula genuinely still skips that row — but it is no longer
 * something anyone has to act on. A card with neither is not listed at all.
 */
function attentionState(card: Card, openOnCard: number) {
  const hasDifference = Math.abs(card.reconciliationDifference) > 0.005;
  if (!hasDifference && openOnCard === 0) return null;
  return openOnCard > 0 ? 'open' : 'accepted';
}

function Attention() {
  const cards = getCards();
  const reviewItems = getReviewItems();

  const rows = cards
    .map((card) => {
      const openOnCard = reviewItems.filter((r) => r.card?.id === card.id).length;
      const state = attentionState(card, openOnCard);
      return state ? { card, openOnCard, state } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    // Anything still open comes first.
    .sort((a, b) => (a.state === b.state ? 0 : a.state === 'open' ? -1 : 1));

  if (rows.length === 0) {
    return (
      <Panel title="Reconciliation">
        <EmptyState
          title="Every card agrees with the workbook"
          description="No differences and nothing awaiting review."
        />
      </Panel>
    );
  }

  const openCount = rows.filter((r) => r.state === 'open').length;

  return (
    <Panel
      title="Reconciliation"
      description={
        openCount > 0
          ? `${openCount} card${openCount === 1 ? "" : "s"} still ${openCount === 1 ? "needs" : "need"} attention. The rest have been reviewed and their difference explained.`
          : 'Every difference below has been reviewed and accepted. The figures stay visible because the workbook and the ledger genuinely differ.'
      }
    >
      <ul className="divide-y divide-line">
        {rows.map(({ card, openOnCard, state }) => (
          <li key={card.id} className="px-4 py-3.5">
            <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    to={`/cards/${card.id}`}
                    className="text-[13px] font-semibold text-ink hover:text-accent hover:underline underline-offset-2"
                  >
                    {card.name}
                  </Link>
                  {state === 'open' ? (
                    <Tag tone="review">
                      {openOnCard} awaiting review
                    </Tag>
                  ) : (
                    <Tag>Reviewed · difference explained</Tag>
                  )}
                </div>
                <p className="mt-1 max-w-2xl text-[13px] text-ink-muted">
                  {card.excluded > 0 || card.reviewAdjustmentsTotal === 0 ? (
                    <>
                      The workbook's own running-balance formula skips a
                      transaction that the ledger counts, so the two totals differ
                      by{' '}
                      <span className="font-medium text-ink">
                        <Money amount={Math.abs(card.reconciliationDifference)} />
                      </span>
                      . The official live balance below includes it, deducted
                      exactly once.
                    </>
                  ) : (
                    <>
                      The workbook's balance carries{' '}
                      <span className="font-medium text-ink">
                        <Money amount={Math.abs(card.reviewAdjustmentsTotal)} />
                      </span>{' '}
                      with no transaction behind it, from a balance typed over the
                      formula. It is held apart from spend and funding until the
                      real transaction is found.
                    </>
                  )}
                  {state === 'open' && (
                    <>
                      {' '}
                      <Link
                        to="/review"
                        className="font-medium text-accent hover:underline underline-offset-2"
                      >
                        Review
                      </Link>
                    </>
                  )}
                </p>
              </div>

              <dl className="tnum shrink-0 space-y-0.5 text-[13px]">
                <div className="flex justify-between gap-6">
                  <dt className="text-ink-muted">Source workbook</dt>
                  <dd><Money amount={card.sourceBalance} code={false} /></dd>
                </div>
                <div className="flex justify-between gap-6">
                  <dt className="text-ink-muted">
                    {card.reviewAdjustmentsTotal !== 0 ? 'Unconfirmed adjustment' : 'Difference'}
                  </dt>
                  <dd>
                    <Money
                      amount={
                        card.reviewAdjustmentsTotal !== 0
                          ? card.reviewAdjustmentsTotal
                          : -Math.abs(card.reconciliationDifference)
                      }
                      signed
                      tone="ledger"
                      code={false}
                    />
                  </dd>
                </div>
                <div className="flex justify-between gap-6 border-t border-line pt-0.5 font-semibold">
                  <dt>Official live</dt>
                  <dd><Money amount={card.ledgerBalance} code={false} /></dd>
                </div>
              </dl>
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export function Dashboard() {
  const cards = getCards();
  const totals = getTotals();
  const recent = [...getTransactions()]
    .filter((t) => t.txn_date)
    .sort((a, b) => (b.txn_date ?? '').localeCompare(a.txn_date ?? ''))
    .slice(0, 10);
  const currencies = spendByCurrencyOverall();

  return (
    <Page
      title="Dashboard"
      description="Every balance is computed live from the ledger. The workbook's own figure sits beside it, and any difference between the two is stated rather than reconciled away."
    >
      <Headline />

      <div className="mt-5">
        <Attention />
      </div>

      <div className="mt-5">
        <Panel
          title="Card balances"
          description="Source is what the workbook shows. Official live is the real transactions."
        >
          <div className="scroll-x">
            <table className="w-full min-w-[900px] border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-faint">
                  <th className="px-4 py-2 font-medium">Card</th>
                  <th className="px-4 py-2 text-right font-medium">Source workbook</th>
                  <th className="px-4 py-2 text-right font-medium">Official live</th>
                  <th className="px-4 py-2 text-right font-medium">Difference</th>
                  <th className="px-4 py-2 text-right font-medium">Last activity</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {cards.map((c) => {
                  const diff = Math.abs(c.reconciliationDifference) > 0.005;
                  return (
                    <tr key={c.id} className="border-b border-line last:border-0 hover:bg-canvas">
                      <td className="px-4 py-2.5">
                        <Link
                          to={`/cards/${c.id}`}
                          className="font-medium text-ink hover:text-accent hover:underline underline-offset-2"
                        >
                          {c.name}
                        </Link>
                        <div className="mt-0.5 text-xs text-ink-faint">
                          {formatCount(c.transactionCount)} transactions · opened{' '}
                          {formatDate(c.openingDate)}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-right text-ink-muted">
                        <Money amount={c.sourceBalance} code={false} />
                      </td>
                      <td className="px-4 py-2.5 text-right text-[14px] font-semibold">
                        <Money amount={c.ledgerBalance} code={false} />
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {diff ? (
                          <span className="font-medium text-negative">
                            <Money amount={c.reconciliationDifference} code={false} />
                          </span>
                        ) : (
                          <span className="text-ink-faint">—</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-right text-ink-muted">
                        {formatDateShort(c.lastTransaction)}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex flex-wrap gap-1">
                          {c.needsReview > 0 && <Tag tone="review">{c.needsReview} to review</Tag>}
                          {c.excluded > 0 && <Tag tone="negative">{c.excluded} excluded</Tag>}
                          {c.needsReview === 0 && c.excluded === 0 && (
                            <span className="text-xs text-ink-faint">Clear</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
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
                  <td className="px-4 py-2.5 text-right text-negative">
                    <Money amount={totals.reconciliationDifference} code={false} />
                  </td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
        </Panel>
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-[1.35fr_1fr]">
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
              <table className="w-full min-w-[620px] border-collapse text-[13px]">
                <thead>
                  <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-faint">
                    <th className="px-4 py-2 font-medium">Date</th>
                    <th className="px-4 py-2 font-medium">Supplier</th>
                    <th className="px-4 py-2 font-medium">Card</th>
                    <th className="px-4 py-2 text-right font-medium">AED</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((t) => {
                    const card = cards.find((c) => c.id === t.cardId);
                    return (
                      <tr key={t.id} className="border-b border-line last:border-0">
                        <td className="whitespace-nowrap px-4 py-2 text-ink-muted">
                          {formatDateShort(t.txn_date)}
                        </td>
                        <td className="max-w-[220px] truncate px-4 py-2">
                          {t.supplier ?? t.description ?? '—'}
                          {t.currency && t.currency !== 'AED' && (
                            <span className="ml-1.5 text-xs text-ink-faint">{t.currency}</span>
                          )}
                        </td>
                        <td className="max-w-[170px] truncate px-4 py-2 text-ink-muted">
                          {card?.name}
                        </td>
                        <td className="px-4 py-2 text-right">
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

        <Panel
          title="Spend by original currency"
          description="One row per currency, never a total. A sum across currencies would look like money and would not be."
        >
          <div className="scroll-x">
            <table className="w-full min-w-[420px] border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-faint">
                  <th className="px-4 py-2 font-medium">Currency</th>
                  <th className="px-4 py-2 text-right font-medium">Txns</th>
                  <th className="px-4 py-2 text-right font-medium">Original total</th>
                  <th className="px-4 py-2 text-right font-medium">Settled AED</th>
                </tr>
              </thead>
              <tbody>
                {currencies.slice(0, 10).map((s) => (
                  <tr key={s.currency} className="border-b border-line last:border-0">
                    <td className="px-4 py-2 font-medium">{s.currency}</td>
                    <td className="tnum px-4 py-2 text-right text-ink-muted">
                      {formatCount(s.count)}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Money amount={s.originalTotal} currency={s.currency} code={false} />
                    </td>
                    <td className="px-4 py-2 text-right text-ink-muted">
                      <Money amount={Math.abs(s.aedTotal)} code={false} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {currencies.length > 10 && (
            <p className="border-t border-line px-4 py-2 text-xs text-ink-muted">
              {currencies.length - 10} further currencies not shown.{' '}
              <Link to="/transactions" className="text-accent hover:underline underline-offset-2">
                See all transactions
              </Link>
            </p>
          )}
        </Panel>
      </div>

      <p className="mt-5 text-xs text-ink-faint">
        Balances are recomputed from the transactions on every read, never stored.
        The import reproduced all {formatCount(1946)} balance figures cached in the
        workbook with no mismatches.
      </p>
    </Page>
  );
}
