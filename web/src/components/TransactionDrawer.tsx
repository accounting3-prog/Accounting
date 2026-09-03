/**
 * The full audit trail for one transaction.
 *
 * Everything the importer preserved is shown here, including the values it
 * refused to interpret: the raw date cell, the raw currency text, the sheet's
 * own conversion formula, and the sheet and row the row came from. The point is
 * that any figure on screen can be traced back to the cell it came from.
 */

import { useEffect } from 'react';
import { formatDate, formatRate, humanise } from '../lib/format';
import { REVIEW_KIND_LABEL, findDuplicateCandidates, reviewKind } from '../lib/ledger';
import { currencyName } from '../lib/currencies';
import type { Card, Transaction } from '../lib/types';
import { Money, Notice, StatusPill, Tag } from './ui';

function Row({
  label,
  children,
  mono,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-[130px_1fr] gap-3 border-b border-line py-2 last:border-0">
      <dt className="text-xs text-ink-faint">{label}</dt>
      <dd className={`min-w-0 text-[13px] break-words text-ink ${mono ? 'font-mono text-xs' : ''}`}>
        {children}
      </dd>
    </div>
  );
}

export function TransactionDrawer({
  transaction,
  card,
  onClose,
}: {
  transaction: Transaction | null;
  card: Card | undefined;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!transaction) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [transaction, onClose]);

  if (!transaction) return null;
  const t = transaction;
  const isAdjustment = t.entry_type === 'reconciliation_adjustment';
  const duplicates = findDuplicateCandidates(t).filter((d) => d.id !== t.id);

  return (
    <div className="fixed inset-0 z-50 flex">
      <div
        className="flex-1 bg-ink/20"
        onClick={onClose}
        aria-hidden
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Transaction detail"
        className="flex h-full w-full max-w-lg flex-col border-l border-line bg-surface shadow-[-1px_0_0_0_rgba(0,0,0,0.04)]"
      >
        <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-ink">
              {t.supplier ?? t.description ?? 'Transaction'}
            </div>
            <div className="mt-0.5 truncate text-xs text-ink-muted">
              {card?.name} · {formatDate(t.txn_date)}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-sm border border-line-strong px-2 py-1 text-xs text-ink-muted hover:bg-sunken"
          >
            Close
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {/* Headline figure */}
          <div className="mb-4 rounded-md border border-line bg-sunken px-3.5 py-3">
            <div className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">
              Effect on balance
            </div>
            <div className="mt-1 text-2xl font-semibold">
              <Money amount={t.amount_aed} signed tone="ledger" />
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <StatusPill status={t.status} />
              {isAdjustment ? (
                <Tag tone="review">Reconciliation adjustment</Tag>
              ) : (
                <Tag>{humanise(t.direction ?? 'unknown')}</Tag>
              )}
              {t.included_in_source_balance === false && (
                <Tag tone="negative">Not in the workbook's balance</Tag>
              )}
              {(t.occurrence ?? 1) > 1 && (
                <Tag>Repeat charge #{t.occurrence}</Tag>
              )}
            </div>
          </div>

          {t.rate_review_note && (
            <div className="mb-4">
              <Notice tone="review" title="Exchange rate note">
                {t.rate_review_note}
              </Notice>
            </div>
          )}

          {t.review_reason && (
            <div className="mb-4">
              <Notice
                tone={
                  t.status === 'excluded_from_source_balance' ? 'negative' : 'review'
                }
                title={REVIEW_KIND_LABEL[reviewKind(t)]}
              >
                {t.review_reason}
              </Notice>
            </div>
          )}

          {duplicates.length > 0 && (
            <div className="mb-4">
              <Notice tone="accent" title={`${duplicates.length} identical row${duplicates.length > 1 ? 's' : ''} in the ledger`}>
                Same card, date, amount, supplier and references. In this
                workbook such rows are genuine repeat charges, so they are kept
                apart by an occurrence number rather than merged.
              </Notice>
            </div>
          )}

          <h3 className="mb-1 mt-5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
            Transaction
          </h3>
          <dl>
            <Row label="Date">
              {formatDate(t.txn_date)}
              {t.date_repaired && (
                <span className="ml-2">
                  <Tag tone="review">Repaired</Tag>
                </span>
              )}
            </Row>
            <Row label="Supplier">{t.supplier ?? '—'}</Row>
            {t.supplier_country && (
              <Row label="Merchant country">
                ISO-3166 {t.supplier_country}
                <span className="ml-1 text-ink-faint">
                  (split from the supplier name)
                </span>
              </Row>
            )}
            <Row label="Card">{card?.name ?? '—'}</Row>
            <Row label="AED settlement">
              <Money amount={t.amount_aed} signed tone="ledger" />
            </Row>
            {t.req_number && <Row label="Request number">{t.req_number}</Row>}
            {t.payment_ref && <Row label="Payment reference">{t.payment_ref}</Row>}
            {t.lpo_number && <Row label="LPO number">{t.lpo_number}</Row>}
            {t.invoice && <Row label="Invoice">{t.invoice}</Row>}
            {t.account && <Row label="Account">{t.account}</Row>}
            {t.crm && <Row label="CRM">{t.crm}</Row>}
            {t.client && <Row label="Client">{t.client}</Row>}
            {t.sales_operation && <Row label="Sales operation">{t.sales_operation}</Row>}
            {t.event_end && <Row label="Event end">{t.event_end}</Row>}
            {t.notes && <Row label="Notes">{t.notes}</Row>}
          </dl>

          {/* Currency — only where the transaction was actually converted */}
          <h3 className="mb-1 mt-5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
            Currency and conversion
          </h3>
          <dl>
            <Row label="Currency">
              {t.currency ? (
                <>
                  {t.currency}
                  <span className="ml-1.5 text-ink-muted">
                    {currencyName(t.currency)}
                  </span>
                </>
              ) : (
                <span className="text-review">
                  Unknown — left blank rather than guessed
                </span>
              )}
            </Row>
            {t.original_amount != null && (
              <Row label="Original amount">
                <Money
                  amount={t.original_amount}
                  currency={t.currency ?? ''}
                  code={Boolean(t.currency)}
                />
              </Row>
            )}
            {t.exchange_rate != null && (
              <Row label="Rate in the source">
                <span className="tnum">{formatRate(t.exchange_rate)}</span>
                <span className="ml-1.5 text-ink-muted">
                  AED per 1 {t.currency ?? 'unit'}
                </span>
              </Row>
            )}
            {t.normalized_exchange_rate != null && (
              <Row label="Rate settled at">
                <span className="tnum font-medium">
                  {formatRate(t.normalized_exchange_rate)}
                </span>
                <span className="ml-1.5 text-ink-muted">
                  AED settlement ÷ original amount
                </span>
                {t.exchange_rate != null &&
                  Math.abs(t.exchange_rate - t.normalized_exchange_rate) > 1e-9 && (
                    <span className="ml-1.5">
                      <Tag tone="review">differs from source</Tag>
                    </span>
                  )}
              </Row>
            )}
          </dl>

          {/* Provenance */}
          <h3 className="mb-1 mt-5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
            Source in the workbook
          </h3>
          <dl>
            <Row label="Sheet">{t.source_sheet ?? 'Entered manually'}</Row>
            {t.source_row != null && <Row label="Row">{t.source_row}</Row>}
            {t.source_date_raw && (
              <Row label="Date cell" mono>
                {t.source_date_raw}
              </Row>
            )}
            {t.date_repair_note && (
              <Row label="Date correction">{t.date_repair_note}</Row>
            )}
            {t.currency_raw && (
              <Row label="Currency cell" mono>
                {t.currency_raw}
              </Row>
            )}
            {t.supplier_raw && t.supplier_raw !== t.supplier && (
              <Row label="Supplier cell" mono>
                {t.supplier_raw}
              </Row>
            )}
            {t.exchange_rate_formula && (
              <Row label="Rate formula" mono>
                {t.exchange_rate_formula}
              </Row>
            )}
            <Row label="In source balance">
              {t.included_in_source_balance === false ? (
                <span className="text-negative">
                  No — the sheet's balance formula skipped this row
                </span>
              ) : (
                'Yes'
              )}
            </Row>
          </dl>

          <h3 className="mb-1 mt-5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
            Attachments
          </h3>
          <p className="text-[13px] text-ink-muted">
            {t.invoice
              ? `The workbook records "${t.invoice}". No file is attached to this record.`
              : 'No document attached to this record.'}
          </p>
        </div>
      </aside>
    </div>
  );
}
