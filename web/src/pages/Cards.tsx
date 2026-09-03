import { Link } from 'react-router-dom';
import { Page } from '../components/Layout';
import { Button, Money, Panel, Tag } from '../components/ui';
import { formatCount, formatDate } from '../lib/format';
import { getCards, getSpendByCurrency } from '../lib/ledger';

export function Cards() {
  const cards = getCards();

  return (
    <Page
      title="Cards"
      description="One account per sheet in the source workbook. Names are kept exactly as the workbook writes them."
      actions={
        <Link to="/cards/new">
          <Button variant="primary">Add a card</Button>
        </Link>
      }
    >
      <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        {cards.map((c) => {
          const diff = Math.abs(c.reconciliationDifference) > 0.005;
          const currencies = getSpendByCurrency(c.id).slice(0, 5);
          return (
            <Panel key={c.id}>
              <div className="px-4 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      to={`/cards/${c.id}`}
                      className="text-[13px] font-semibold text-ink hover:text-accent hover:underline underline-offset-2"
                    >
                      {c.name}
                    </Link>
                    <div className="mt-0.5 text-xs text-ink-muted">
                      Opened {formatDate(c.openingDate)} ·{' '}
                      {formatCount(c.transactionCount)} transactions
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    {c.needsReview > 0 && <Tag tone="review">{c.needsReview} to review</Tag>}
                    {c.excluded > 0 && <Tag tone="negative">{c.excluded} excluded</Tag>}
                  </div>
                </div>

                <dl className="mt-3.5 space-y-1.5 text-[13px]">
                  <div className="flex items-baseline justify-between gap-4">
                    <dt className="text-ink-muted">Source workbook</dt>
                    <dd><Money amount={c.sourceBalance} code={false} /></dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-4">
                    <dt className="text-ink-muted">Live ledger</dt>
                    <dd className="font-semibold">
                      <Money amount={c.ledgerBalance} code={false} />
                      <span className="ml-1 text-xs text-ink-faint">AED</span>
                    </dd>
                  </div>
                  {diff && (
                    <div className="flex items-baseline justify-between gap-4 border-t border-line pt-1.5">
                      <dt className="font-medium text-negative">Reconciliation difference</dt>
                      <dd className="font-medium text-negative">
                        <Money amount={c.reconciliationDifference} code={false} />
                      </dd>
                    </div>
                  )}
                </dl>

                {currencies.length > 0 && (
                  <div className="mt-3.5 border-t border-line pt-3">
                    <div className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">
                      Spend by currency
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                      {currencies.map((s) => (
                        <span key={s.currency} className="tnum text-ink-muted">
                          <span className="font-medium text-ink">{s.currency}</span>{' '}
                          {formatCount(s.count)}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </Panel>
          );
        })}
      </div>
    </Page>
  );
}
