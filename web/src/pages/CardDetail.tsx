import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Page } from '../components/Layout';
import { TransactionDrawer } from '../components/TransactionDrawer';
import { EditTransactionDialog } from '../components/EditTransactionDialog';
import { useLedgerState } from '../components/LedgerProvider';
import { matchesQuery, searchHaystack } from '../lib/search';
import { exportCsv, exportXlsx } from '../lib/export';
import { EMPTY_FILTERS } from '../lib/search';
import {
  Button,
  EmptyState,
  Money,
  Notice,
  Panel,
  Stat,
  StatusPill,
  Tag,
  fieldClass,
} from '../components/ui';
import { formatCount, formatDate, formatDateShort } from '../lib/format';
import {
  REVIEW_KIND_LABEL,
  getCard,
  getCardTransactions,
  getSpendByCurrency,
  reviewKind,
  round2,
} from '../lib/ledger';
import type { Transaction } from '../lib/types';

/**
 * Balance over time, drawn from the transactions themselves.
 *
 * A plain sparkline of the real running balance — not a decorative chart. It
 * exists to answer one question: has this account been trending down.
 */
function BalanceHistory({
  card,
  transactions,
}: {
  card: NonNullable<ReturnType<typeof getCard>>;
  transactions: Transaction[];
}) {
  const points = useMemo(() => {
    const dated = transactions
      .filter((t) => t.txn_date && t.entry_type === 'source_transaction')
      .sort((a, b) => (a.txn_date ?? '').localeCompare(b.txn_date ?? ''));
    let running = card.openingBalance;
    const out: { date: string; balance: number }[] = [
      { date: card.openingDate ?? '', balance: running },
    ];
    for (const t of dated) {
      running += t.amount_aed;
      out.push({ date: t.txn_date!, balance: round2(running) });
    }
    return out;
  }, [card, transactions]);

  if (points.length < 3) return null;

  const values = points.map((p) => p.balance);
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const range = max - min || 1;
  const W = 640;
  const H = 120;
  const d = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * W;
      const y = H - ((p.balance - min) / range) * H;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const zeroY = H - ((0 - min) / range) * H;
  const showZero = min < 0 && max > 0;

  return (
    <Panel
      title="Balance history"
      description={`Opening balance through ${formatCount(points.length - 1)} transactions, computed from the ledger.`}
    >
      <div className="px-4 py-4">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="h-32 w-full"
          role="img"
          aria-label={`Balance from ${formatDate(points[0].date)} to ${formatDate(points[points.length - 1].date)}`}
        >
          {showZero && (
            <line
              x1="0"
              x2={W}
              y1={zeroY}
              y2={zeroY}
              stroke="#d3cfc7"
              strokeWidth="1"
              strokeDasharray="3 3"
              vectorEffect="non-scaling-stroke"
            />
          )}
          <path
            d={d}
            fill="none"
            stroke="#1f4a73"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
          />
        </svg>
        <div className="mt-2 flex justify-between text-xs text-ink-muted">
          <span>
            {formatDateShort(points[0].date)} ·{' '}
            <Money amount={points[0].balance} code={false} />
          </span>
          <span>
            {formatDateShort(points[points.length - 1].date)} ·{' '}
            <Money amount={points[points.length - 1].balance} code={false} />
          </span>
        </div>
      </div>
    </Panel>
  );
}

export function CardDetail() {
  const { id } = useParams<{ id: string }>();
  const card = getCard(id ?? '');
  const [selected, setSelected] = useState<Transaction | null>(null);
  const [editing, setEditing] = useState<Transaction | null>(null);
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const { reload, signedIn, source } = useLedgerState();
  const canEdit = signedIn && source === 'supabase';

  if (!card) {
    return (
      <Page title="Card not found">
        <Panel>
          <EmptyState
            title="No such card"
            description="This account does not exist in the ledger."
            action={
              <Link to="/cards">
                <Button>Back to cards</Button>
              </Link>
            }
          />
        </Panel>
      </Page>
    );
  }

  const transactions = getCardTransactions(card.id);

  // Searching within one card, over the same fields the main list searches, so
  // a 1,370-transaction account does not have to be filtered from elsewhere.
  const sorted = [...transactions].sort((a, b) =>
    (b.txn_date ?? '').localeCompare(a.txn_date ?? ''),
  );
  const matched = query.trim()
    ? sorted.filter((t) => matchesQuery(searchHaystack(t, card.name), query))
    : sorted;
  const recent = showAll || query.trim() ? matched.slice(0, 200) : matched.slice(0, 15);
  const currencies = getSpendByCurrency(card.id);
  const exceptions = transactions.filter(
    (t) => t.status !== 'confirmed' || t.entry_type === 'reconciliation_adjustment',
  );
  const hasDifference = Math.abs(card.reconciliationDifference) > 0.005;

  return (
    <Page
      title={card.name}
      description={
        <>
          Sheet <span className="font-medium text-ink">{card.name}</span>,
          header row {card.sourceHeaderRow}. The balance formula is{' '}
          <code className="rounded-sm bg-sunken px-1 font-mono text-xs">
            {card.balanceFormula}
          </code>
          , so column {card.decreasingColumn} reduces the balance
          {card.headerIsMisleading && (
            <> — even though it is labelled “{card.decreasingHeader}”</>
          )}
          .
        </>
      }
      actions={
        <Link to="/transactions">
          <Button>All transactions</Button>
        </Link>
      }
    >
      {card.headerIsMisleading && (
        <div className="mb-5">
          <Notice tone="accent" title="This sheet's column labels are misleading">
            Column {card.decreasingColumn} is headed “{card.decreasingHeader}” but it
            is the spend side: the sheet's own formula subtracts it. Direction was
            taken from the formula, never the header, and confirmed by replaying
            all {formatCount(card.verifiedRows)} cached balances.
          </Notice>
        </div>
      )}

      {/* The three balances, never conflated */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Opening balance"
          value={<Money amount={card.openingBalance} code={false} />}
          hint={`On ${formatDate(card.openingDate)} — its first transaction`}
        />
        <Stat
          label="Source workbook balance"
          value={<Money amount={card.sourceBalance} code={false} />}
          hint="What the sheet's own formula chain produces"
        />
        <Stat
          label="Official live balance"
          value={<Money amount={card.ledgerBalance} code={false} />}
          hint="Real transactions only, computed on read"
        />
        <Stat
          label="Reconciliation difference"
          value={
            hasDifference ? (
              <Money amount={card.reconciliationDifference} code={false} />
            ) : (
              <span className="text-ink-muted">None</span>
            )
          }
          tone={hasDifference ? 'negative' : 'plain'}
          hint={hasDifference ? 'Source and ledger disagree' : 'Source and ledger agree'}
        />
      </div>

      {card.reviewAdjustmentsTotal !== 0 && (
        <div className="mt-4">
          <Notice tone="review" title="An unconfirmed adjustment sits in this balance">
            <p>
              The workbook's balance includes{' '}
              <Money amount={card.reviewAdjustmentsTotal} signed /> with no
              transaction behind it. It is held separately and is not part of
              spend or funding.
            </p>
            <dl className="mt-2.5 max-w-sm space-y-1 text-[13px]">
              <div className="flex justify-between gap-4">
                <dt className="text-ink-muted">Source workbook balance</dt>
                <dd><Money amount={card.sourceBalance} code={false} /></dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-ink-muted">Ledger without the adjustment</dt>
                <dd><Money amount={card.ledgerBalance} code={false} /></dd>
              </div>
              <div className="flex justify-between gap-4 border-t border-[#e8d5ab] pt-1 font-medium">
                <dt>Review adjustment</dt>
                <dd><Money amount={card.reviewAdjustmentsTotal} signed code={false} /></dd>
              </div>
            </dl>
          </Notice>
        </div>
      )}

      <div className="mt-5 grid gap-5 xl:grid-cols-[1.4fr_1fr]">
        <div className="space-y-5">
          <BalanceHistory card={card} transactions={transactions} />

          <Panel
            title={query.trim() ? 'Search results' : 'Recent activity'}
            description={
              query.trim()
                ? `${formatCount(matched.length)} of ${formatCount(transactions.length)} transactions match.`
                : `${formatCount(card.transactionCount)} transactions in total.`
            }
            action={
              matched.length > 0 && (
                <div className="flex gap-1.5">
                  <Button
                    onClick={() =>
                      exportCsv(matched, [card], query, {
                        ...EMPTY_FILTERS,
                        query,
                        cardIds: [card.id],
                      })
                    }
                  >
                    CSV
                  </Button>
                  <Button
                    onClick={() =>
                      exportXlsx(matched, [card], query, {
                        ...EMPTY_FILTERS,
                        query,
                        cardIds: [card.id],
                      })
                    }
                  >
                    Excel
                  </Button>
                </div>
              )
            }
          >
            <div className="border-b border-line px-4 py-3">
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search this card — supplier, request number, payment reference, invoice, LPO…"
                className={fieldClass}
                aria-label={`Search transactions on ${card.name}`}
              />
            </div>
            {recent.length === 0 ? (
              <EmptyState
                title={query.trim() ? 'Nothing matches that search' : 'No activity on this card'}
                description={query.trim() ? 'Try a shorter term.' : undefined}
                action={
                  query.trim() ? (
                    <Button onClick={() => setQuery('')}>Clear search</Button>
                  ) : undefined
                }
              />
            ) : (
              <div className="scroll-x">
                <table className="w-full min-w-[620px] border-collapse text-[13px]">
                  <thead>
                    <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-faint">
                      <th className="px-4 py-2 font-medium">Date</th>
                      <th className="px-4 py-2 font-medium">Supplier</th>
                      <th className="px-4 py-2 text-right font-medium">Original</th>
                      <th className="px-4 py-2 text-right font-medium">AED</th>
                      <th className="px-4 py-2 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.map((t) => (
                      <tr
                        key={t.id}
                        onClick={() => setSelected(t)}
                        className="cursor-pointer border-b border-line last:border-0 hover:bg-canvas"
                      >
                        <td className="whitespace-nowrap px-4 py-2 text-ink-muted">
                          {formatDateShort(t.txn_date)}
                        </td>
                        <td className="max-w-[200px] truncate px-4 py-2">
                          {t.supplier ?? t.description ?? '—'}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2 text-right text-ink-muted">
                          {t.currency && t.currency !== 'AED' && t.original_amount != null ? (
                            <>
                              <Money
                                amount={t.original_amount}
                                currency={t.currency}
                                code={false}
                              />{' '}
                              <span className="text-xs text-ink-faint">{t.currency}</span>
                            </>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2 text-right font-medium">
                          <Money amount={t.amount_aed} signed tone="ledger" code={false} />
                        </td>
                        <td className="px-4 py-2">
                          <StatusPill status={t.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {!query.trim() && !showAll && matched.length > recent.length && (
              <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3">
                <span className="text-xs text-ink-muted">
                  Showing the {recent.length} most recent of {formatCount(matched.length)}
                </span>
                <Button onClick={() => setShowAll(true)}>Show more</Button>
              </div>
            )}
          </Panel>
        </div>

        <div className="space-y-5">
          <Panel
            title="Spending by original currency"
            description="Each currency stands alone. These figures are never added together."
          >
            {currencies.length === 0 ? (
              <EmptyState title="No spend recorded" />
            ) : (
              <div className="scroll-x">
                <table className="w-full min-w-[380px] border-collapse text-[13px]">
                  <thead>
                    <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-faint">
                      <th className="px-4 py-2 font-medium">Currency</th>
                      <th className="px-4 py-2 text-right font-medium">Txns</th>
                      <th className="px-4 py-2 text-right font-medium">Original total</th>
                      <th className="px-4 py-2 text-right font-medium">Settled AED</th>
                    </tr>
                  </thead>
                  <tbody>
                    {currencies.map((s) => (
                      <tr key={s.currency} className="border-b border-line last:border-0">
                        <td className="px-4 py-2 font-medium">{s.currency}</td>
                        <td className="tnum px-4 py-2 text-right text-ink-muted">
                          {formatCount(s.count)}
                        </td>
                        <td className="px-4 py-2 text-right">
                          <Money
                            amount={s.originalTotal}
                            currency={s.currency}
                            code={false}
                          />
                        </td>
                        <td className="px-4 py-2 text-right text-ink-muted">
                          <Money amount={Math.abs(s.aedTotal)} code={false} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <Panel
            title="Exceptions and review items"
            description={
              exceptions.length === 0
                ? undefined
                : 'Imported in full and flagged — never dropped or corrected.'
            }
          >
            {exceptions.length === 0 ? (
              <EmptyState
                title="Nothing flagged"
                description="Every row on this card read cleanly."
              />
            ) : (
              <ul className="divide-y divide-line">
                {exceptions.map((t) => (
                  <li key={t.id} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <Tag
                          tone={
                            t.status === 'excluded_from_source_balance'
                              ? 'negative'
                              : 'review'
                          }
                        >
                          {REVIEW_KIND_LABEL[reviewKind(t)]}
                        </Tag>
                        <div className="mt-1 truncate text-[13px] text-ink">
                          {t.supplier ?? t.description ?? '—'}
                        </div>
                        <div className="text-xs text-ink-faint">
                          row {t.source_row} · {formatDate(t.txn_date)}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setSelected(t)}
                        className="shrink-0 text-xs font-medium text-accent hover:underline underline-offset-2"
                      >
                        Open
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>

      <TransactionDrawer
        transaction={selected}
        card={card}
        onClose={() => setSelected(null)}
        canEdit={canEdit}
        onEdit={(t) => {
          setSelected(null);
          setEditing(t);
        }}
      />

      <EditTransactionDialog
        transaction={editing}
        card={card}
        onClose={() => setEditing(null)}
        onDone={reload}
      />
    </Page>
  );
}
