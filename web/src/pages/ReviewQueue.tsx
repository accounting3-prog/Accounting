import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Page } from '../components/Layout';
import { TransactionDrawer } from '../components/TransactionDrawer';
import { Button, EmptyState, Money, Panel, StatusPill, Tag } from '../components/ui';
import { formatDate } from '../lib/format';
import { REVIEW_KIND_LABEL, getCards, getReviewItems } from '../lib/ledger';
import type { ReviewKind, Transaction } from '../lib/types';

/** What resolving an item would mean, stated plainly before it is done. */
const ACTIONS: Record<ReviewKind, string[]> = {
  currency_unreadable: [
    'Confirm the currency and original amount',
    'Leave pending review',
  ],
  rate_mismatch: [
    'Confirm which figure is right',
    'Leave pending review',
  ],
  rate_without_currency: [
    'Confirm the currency this was charged in',
    'Leave pending review',
  ],
  rate_hardcoded: [
    'Record the original amount',
    'Leave pending review',
  ],
  manual_balance_adjustment: [
    'Link the underlying transaction',
    'Confirm as a real adjustment',
    'Leave pending review',
  ],
  excluded_from_source_balance: [
    'Confirm as completed and include in the balance',
    'Mark as voided',
    'Leave pending review',
  ],
  duplicate_candidate: ['Keep both', 'Mark one as voided'],
  other: ['Confirm', 'Leave pending review'],
};

export function ReviewQueue() {
  const cards = getCards();
  const items = getReviewItems();
  const [kindFilter, setKindFilter] = useState<ReviewKind | 'all'>('all');
  const [selected, setSelected] = useState<Transaction | null>(null);

  const counts = useMemo(() => {
    const c = new Map<ReviewKind, number>();
    for (const i of items) c.set(i.kind, (c.get(i.kind) ?? 0) + 1);
    return c;
  }, [items]);

  const filtered =
    kindFilter === 'all' ? items : items.filter((i) => i.kind === kindFilter);

  const balanceAffecting = items.filter(
    (i) =>
      i.kind === 'manual_balance_adjustment' ||
      i.kind === 'excluded_from_source_balance',
  );

  return (
    <Page
      title="Review queue"
      description="Rows the import refused to interpret, and the two places where the workbook and its own arithmetic disagree. Everything here was imported in full and flagged — nothing was dropped, merged or corrected."
    >
      {items.length === 0 ? (
        <Panel>
          <EmptyState
            title="Nothing awaiting review"
            description="Every imported row read cleanly and every card reconciles."
          />
        </Panel>
      ) : (
        <>
          {/* The two that move a balance get stated first and in full. */}
          {balanceAffecting.length > 0 && (
            <Panel
              title="Affecting a balance"
              description="These change what a card is worth, so they are listed apart from the rows that only need a value confirmed."
              className="mb-5"
            >
              <div className="divide-y divide-line">
                {balanceAffecting.map(({ transaction: t, card, kind, reason }) => (
                  <div key={t.id} className="px-4 py-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <Tag
                            tone={
                              kind === 'excluded_from_source_balance'
                                ? 'negative'
                                : 'review'
                            }
                          >
                            {REVIEW_KIND_LABEL[kind]}
                          </Tag>
                          <span className="text-[13px] font-medium text-ink">
                            {t.supplier ?? t.description}
                          </span>
                        </div>
                        <div className="mt-1 text-xs text-ink-muted">
                          <Link
                            to={`/cards/${card.id}`}
                            className="text-accent hover:underline underline-offset-2"
                          >
                            {card.name}
                          </Link>
                          {' · '}
                          {t.source_sheet} row {t.source_row}
                          {' · '}
                          {formatDate(t.txn_date)}
                        </div>
                      </div>
                      <div className="text-right">
                        <Money amount={t.amount_aed} signed tone="ledger" />
                        <div className="mt-0.5 text-xs text-ink-faint">
                          effect on balance
                        </div>
                      </div>
                    </div>

                    <p className="mt-2.5 max-w-3xl text-[13px] text-ink">{reason}</p>

                    {kind === 'excluded_from_source_balance' && (
                      <dl className="mt-3 max-w-md space-y-1 rounded-sm border border-line bg-sunken px-3 py-2.5 text-[13px]">
                        <div className="flex justify-between gap-4">
                          <dt className="text-ink-muted">Source workbook balance</dt>
                          <dd><Money amount={card.sourceBalance} code={false} /></dd>
                        </div>
                        <div className="flex justify-between gap-4">
                          <dt className="text-ink-muted">This transaction</dt>
                          <dd><Money amount={t.amount_aed} signed tone="ledger" code={false} /></dd>
                        </div>
                        <div className="flex justify-between gap-4 border-t border-line pt-1 font-medium">
                          <dt>Ledger balance including it</dt>
                          <dd><Money amount={card.ledgerBalance} code={false} /></dd>
                        </div>
                      </dl>
                    )}

                    {kind === 'manual_balance_adjustment' && (
                      <dl className="mt-3 max-w-md space-y-1 rounded-sm border border-line bg-sunken px-3 py-2.5 text-[13px]">
                        <div className="flex justify-between gap-4">
                          <dt className="text-ink-muted">Source workbook balance</dt>
                          <dd><Money amount={card.sourceBalance} code={false} /></dd>
                        </div>
                        <div className="flex justify-between gap-4">
                          <dt className="text-ink-muted">Ledger without this adjustment</dt>
                          <dd><Money amount={card.ledgerBalance} code={false} /></dd>
                        </div>
                        <div className="flex justify-between gap-4 border-t border-line pt-1 font-medium">
                          <dt>Unexplained difference</dt>
                          <dd><Money amount={t.amount_aed} signed tone="ledger" code={false} /></dd>
                        </div>
                      </dl>
                    )}

                    <div className="mt-3 flex flex-wrap gap-2">
                      {ACTIONS[kind].map((label, i) => (
                        <Button key={label} variant={i === 0 ? 'primary' : 'secondary'}>
                          {label}
                        </Button>
                      ))}
                      <Button variant="ghost" onClick={() => setSelected(t)}>
                        View audit trail
                      </Button>
                    </div>
                    <p className="mt-2 text-xs text-ink-faint">
                      Any change here is recorded as an audited correction. Nothing is
                      deleted — a superseded record keeps its history.
                    </p>
                  </div>
                ))}
              </div>
            </Panel>
          )}

          {/* Everything else */}
          <div className="mb-3 flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setKindFilter('all')}
              className={`rounded-sm border px-2 py-1 text-xs font-medium ${
                kindFilter === 'all'
                  ? 'border-accent bg-accent-soft text-accent'
                  : 'border-line bg-surface text-ink-muted hover:bg-sunken'
              }`}
            >
              All ({items.length})
            </button>
            {[...counts.entries()].map(([kind, n]) => (
              <button
                key={kind}
                type="button"
                onClick={() => setKindFilter(kind)}
                className={`rounded-sm border px-2 py-1 text-xs font-medium ${
                  kindFilter === kind
                    ? 'border-accent bg-accent-soft text-accent'
                    : 'border-line bg-surface text-ink-muted hover:bg-sunken'
                }`}
              >
                {REVIEW_KIND_LABEL[kind]} ({n})
              </button>
            ))}
          </div>

          <Panel title={kindFilter === 'all' ? 'All flagged rows' : REVIEW_KIND_LABEL[kindFilter]}>
            {filtered.length === 0 ? (
              <EmptyState title="No items of this kind" />
            ) : (
              <div className="scroll-x">
                <table className="w-full min-w-[900px] border-collapse text-[13px]">
                  <thead>
                    <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-faint">
                      <th className="px-4 py-2 font-medium">Reason</th>
                      <th className="px-4 py-2 font-medium">Source</th>
                      <th className="px-4 py-2 font-medium">Supplier</th>
                      <th className="px-4 py-2 text-right font-medium">Effect</th>
                      <th className="px-4 py-2 font-medium">Status</th>
                      <th className="px-4 py-2 font-medium" />
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map(({ transaction: t, card, kind, reason }) => (
                      <tr key={t.id} className="border-b border-line last:border-0 hover:bg-canvas">
                        <td className="max-w-[320px] px-4 py-2.5">
                          <Tag tone={kind === 'excluded_from_source_balance' ? 'negative' : 'review'}>
                            {REVIEW_KIND_LABEL[kind]}
                          </Tag>
                          <div className="mt-1 line-clamp-2 text-xs text-ink-muted">
                            {reason}
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-xs text-ink-muted">
                          <div>{card.name}</div>
                          <div className="text-ink-faint">
                            {t.source_sheet ? `row ${t.source_row}` : 'manual entry'}
                          </div>
                        </td>
                        <td className="max-w-[200px] truncate px-4 py-2.5">
                          {t.supplier ?? t.description ?? '—'}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-right">
                          <Money amount={t.amount_aed} signed tone="ledger" code={false} />
                        </td>
                        <td className="px-4 py-2.5">
                          <StatusPill status={t.status} />
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <Button variant="ghost" onClick={() => setSelected(t)}>
                            Open
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </>
      )}

      <TransactionDrawer
        transaction={selected}
        card={cards.find((c) => c.id === selected?.cardId)}
        onClose={() => setSelected(null)}
      />
    </Page>
  );
}
