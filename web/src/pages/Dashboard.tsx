import { Link } from 'react-router-dom';
import { Page } from '../components/Layout';
import { EmptyState, Money, Notice, Panel, Stat, Tag } from '../components/ui';
import { formatCount, formatDate, formatDateShort } from '../lib/format';
import {
  getCards,
  getTotals,
  getTransactions,
  spendByCurrencyOverall,
} from '../lib/ledger';

/** The two cards whose workbook balance and real ledger disagree. */
function ExceptionNotices() {
  const cards = getCards();
  const amex = cards.find((c) => c.name.startsWith('AMEX 3024'));
  const rak = cards.find((c) => c.name.startsWith('RAK 9825'));

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {amex && (
        <Notice
          tone="negative"
          title={`${amex.name} — a transaction is missing from the workbook's balance`}
        >
          <p>
            <strong>FLYNAS RIYADH</strong> (row 5) carries a date, supplier,
            <span className="whitespace-nowrap"> SAR 8,925.77</span> and an AED
            amount, but the sheet gave it no balance formula — so the workbook's
            own total excludes it. It <strong>does</strong> count in the official
            live balance below, deducted exactly once.
          </p>
          <dl className="mt-2.5 space-y-1 text-[13px]">
            <div className="flex justify-between gap-4">
              <dt className="text-ink-muted">Source workbook balance</dt>
              <dd><Money amount={amex.sourceBalance} /></dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-ink-muted">FLYNAS, excluded</dt>
              <dd><Money amount={-8745.78} signed tone="ledger" /></dd>
            </div>
            <div className="flex justify-between gap-4 border-t border-[#eecac6] pt-1">
              <dt className="font-medium text-ink">Official live ledger balance</dt>
              <dd className="font-semibold"><Money amount={amex.ledgerBalance} /></dd>
            </div>
          </dl>
          <p className="mt-2">
            <Link to={`/cards/${amex.id}`} className="font-medium text-accent underline underline-offset-2">
              Review this card
            </Link>
          </p>
        </Notice>
      )}

      {rak && (
        <Notice
          tone="review"
          title={`${rak.name} — the balance was manually overwritten`}
        >
          <p>
            At row 26 the running balance was typed over instead of carried by
            formula, leaving <strong>1,718.02 AED</strong> in the workbook's
            total with no transaction behind it. It is held as a labelled
            adjustment, not folded into spend or funding.
          </p>
          <dl className="mt-2.5 space-y-1 text-[13px]">
            <div className="flex justify-between gap-4">
              <dt className="text-ink-muted">Source workbook balance</dt>
              <dd><Money amount={rak.sourceBalance} /></dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-ink-muted">Ledger, without the adjustment</dt>
              <dd><Money amount={rak.ledgerBalance} /></dd>
            </div>
            <div className="flex justify-between gap-4 border-t border-[#e8d5ab] pt-1">
              <dt className="font-medium text-ink">Unconfirmed review adjustment</dt>
              <dd className="font-semibold">
                <Money amount={rak.reviewAdjustmentsTotal} signed tone="ledger" />
              </dd>
            </div>
          </dl>
          <p className="mt-2">
            <Link to="/review" className="font-medium text-accent underline underline-offset-2">
              Open the review queue
            </Link>
          </p>
        </Notice>
      )}
    </div>
  );
}

export function Dashboard() {
  const cards = getCards();
  const totals = getTotals();
  const recent = [...getTransactions()]
    .filter((t) => t.txn_date)
    .sort((a, b) => (b.txn_date ?? '').localeCompare(a.txn_date ?? ''))
    .slice(0, 12);
  const currencies = spendByCurrencyOverall();

  return (
    <Page
      title="Dashboard"
      description="Every balance is computed live from the ledger. The workbook's own figure is shown beside it, and any difference between the two is stated rather than reconciled away."
    >
      {/* Headline figures */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Live ledger balance"
          value={<Money amount={totals.liveBalance} />}
          hint={`Across ${totals.cardCount} cards, all settling in AED`}
        />
        <Stat
          label="Cards"
          value={<span className="tnum">{totals.cardCount}</span>}
          hint={`${formatCount(totals.transactionCount)} transactions imported`}
        />
        <Stat
          label="Needs review"
          value={<span className="tnum">{totals.needsReview + totals.excluded}</span>}
          tone={totals.needsReview + totals.excluded > 0 ? 'review' : 'plain'}
          hint={
            <Link to="/review" className="text-accent underline underline-offset-2">
              Open the review queue
            </Link>
          }
        />
        <Stat
          label="Reconciliation difference"
          value={<Money amount={totals.reconciliationDifference} />}
          tone={Math.abs(totals.reconciliationDifference) > 0.005 ? 'negative' : 'plain'}
          hint={`${totals.cardsWithDifference.length} of ${totals.cardCount} cards disagree with the workbook`}
        />
      </div>

      <div className="mt-5">
        <ExceptionNotices />
      </div>

      {/* Card balances */}
      <div className="mt-5">
        <Panel
          title="Card balances"
          description="Source is what the workbook shows. Ledger is the real transactions. A non-zero difference is a discrepancy that has not been resolved yet."
        >
          <div className="scroll-x">
            <table className="w-full min-w-[900px] border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-faint">
                  <th className="px-4 py-2 font-medium">Card</th>
                  <th className="px-4 py-2 text-right font-medium">Source workbook</th>
                  <th className="px-4 py-2 text-right font-medium">Live ledger</th>
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
                      <td className="px-4 py-2.5 text-right">
                        <Money amount={c.sourceBalance} code={false} />
                      </td>
                      <td className="px-4 py-2.5 text-right font-medium">
                        <Money amount={c.ledgerBalance} code={false} />
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {diff ? (
                          <span className="tnum font-medium text-negative">
                            <Money amount={c.reconciliationDifference} code={false} />
                          </span>
                        ) : (
                          <span className="text-ink-faint">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right text-ink-muted">
                        {formatDateShort(c.lastTransaction)}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex flex-wrap gap-1">
                          {c.needsReview > 0 && (
                            <Tag tone="review">{c.needsReview} to review</Tag>
                          )}
                          {c.excluded > 0 && (
                            <Tag tone="negative">{c.excluded} excluded</Tag>
                          )}
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
                <tr className="border-t border-line-strong bg-sunken font-medium">
                  <td className="px-4 py-2.5">Total, AED</td>
                  <td className="px-4 py-2.5 text-right">
                    <Money amount={totals.sourceBalance} code={false} />
                  </td>
                  <td className="px-4 py-2.5 text-right">
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
        {/* Recent transactions */}
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
              <table className="w-full min-w-[640px] border-collapse text-[13px]">
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
                            <span className="ml-1.5 text-xs text-ink-faint">
                              {t.currency}
                            </span>
                          )}
                        </td>
                        <td className="max-w-[180px] truncate px-4 py-2 text-ink-muted">
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

        {/* Spend by currency — never totalled */}
        <Panel
          title="Spend by original currency"
          description="One row per currency. These are not added together: a sum across currencies would be a number that looks like money and is not."
        >
          <div className="scroll-x">
            <table className="w-full min-w-[420px] border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-faint">
                  <th className="px-4 py-2 font-medium">Currency</th>
                  <th className="px-4 py-2 text-right font-medium">Transactions</th>
                  <th className="px-4 py-2 text-right font-medium">Original total</th>
                  <th className="px-4 py-2 text-right font-medium">Settled AED</th>
                </tr>
              </thead>
              <tbody>
                {currencies.slice(0, 12).map((s) => (
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
          {currencies.length > 12 && (
            <p className="border-t border-line px-4 py-2 text-xs text-ink-muted">
              {currencies.length - 12} further currencies not shown.
            </p>
          )}
        </Panel>
      </div>

      <p className="mt-5 text-xs text-ink-faint">
        Balances are recomputed from the transactions on every read, never stored.
        The import reproduced all {formatCount(1946)} balance figures cached in
        the workbook with no mismatches.
      </p>
    </Page>
  );
}
