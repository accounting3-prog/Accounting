/**
 * Resolving a review item.
 *
 * Every action here moves money in or out of a card's official balance, so the
 * dialog states the arithmetic before it is applied — the balance now, the
 * change, and the balance afterwards — and will not submit without a reason.
 * The reason is not paperwork: months later it is the only thing that explains
 * why a figure moved.
 *
 * The write goes through resolve_review_item in the database, which re-checks
 * admin rights and records the decision. Nothing is ever deleted.
 */

import { useEffect, useState } from 'react';
import { resolveReviewItem, type ResolveAction } from '../lib/api';
import { formatDate } from '../lib/format';
import type { Card, Transaction } from '../lib/types';
import { Button, Money, Notice } from './ui';

export interface ResolveRequest {
  transaction: Transaction;
  card: Card;
  action: ResolveAction;
  label: string;
}

/** What the card's official live balance becomes if this is applied. */
function projectedBalance(t: Transaction, card: Card, action: ResolveAction): number | null {
  // Voiding drops the row out of the live balance; confirming a row that is
  // already counted changes nothing. Only the transition matters.
  const countedNow = t.status !== 'voided';
  const countedAfter = action !== 'void';
  if (countedNow === countedAfter) return card.ledgerBalance;
  return countedAfter
    ? card.ledgerBalance + t.amount_aed
    : card.ledgerBalance - t.amount_aed;
}

export function ResolveDialog({
  request,
  onClose,
  onDone,
}: {
  request: ResolveRequest | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [rationale, setRationale] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRationale('');
    setError(null);
  }, [request]);

  useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [request, busy, onClose]);

  if (!request) return null;
  const { transaction: t, card, action, label } = request;

  const projected = projectedBalance(t, card, action);
  const changes = projected !== null && Math.abs(projected - card.ledgerBalance) > 0.005;

  const submit = async () => {
    if (!rationale.trim() || busy) return;
    setBusy(true);
    setError(null);
    const result = await resolveReviewItem(t.id, action, rationale.trim());
    setBusy(false);
    if (result.ok) {
      onDone();
      onClose();
    } else {
      setError(result.error);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-ink/25" onClick={() => !busy && onClose()} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="relative w-full max-w-lg rounded-md border border-line bg-surface"
      >
        <header className="border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">{label}</h2>
          <p className="mt-0.5 text-xs text-ink-muted">
            {t.supplier ?? t.description} · {card.name} · {formatDate(t.txn_date)}
          </p>
        </header>

        <div className="px-4 py-4">
          <dl className="space-y-1.5 rounded-sm border border-line bg-sunken px-3 py-2.5 text-[13px]">
            <div className="flex justify-between gap-4">
              <dt className="text-ink-muted">Official live balance now</dt>
              <dd><Money amount={card.ledgerBalance} code={false} /></dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-ink-muted">This transaction</dt>
              <dd><Money amount={t.amount_aed} signed tone="ledger" code={false} /></dd>
            </div>
            <div className="flex justify-between gap-4 border-t border-line pt-1.5 font-medium">
              <dt>{changes ? 'Balance after this change' : 'Balance is unchanged'}</dt>
              <dd className="text-base font-semibold">
                <Money amount={projected} code={false} />
                <span className="ml-1 text-xs text-ink-faint">AED</span>
              </dd>
            </div>
          </dl>

          {action === 'void' && (
            <div className="mt-3">
              <Notice tone="negative" title="This removes the amount from the live balance">
                The row is kept with its full history and stays searchable — it is
                marked voided, never deleted.
              </Notice>
            </div>
          )}
          {action === 'confirm' && !changes && (
            <div className="mt-3">
              <Notice tone="accent" title="The balance does not move">
                This amount already counts in the official live balance. Confirming
                records the decision and clears the row from the queue; it does not
                change any figure.
              </Notice>
            </div>
          )}
          {action === 'leave_pending' && (
            <div className="mt-3">
              <Notice tone="review" title="The row stays in the queue">
                Nothing changes except the record that someone looked at this and
                chose to wait — which is worth distinguishing from nobody having
                looked at all.
              </Notice>
            </div>
          )}

          <label className="mt-4 block">
            <span className="block text-[11px] font-medium uppercase tracking-wide text-ink-faint">
              Reason <span className="text-negative">*</span>
            </span>
            <textarea
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
              rows={3}
              autoFocus
              placeholder="e.g. Confirmed against the June statement; the charge settled on 18 June."
              className="mt-1 w-full rounded-sm border border-line-strong bg-surface px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
            />
            <span className="mt-1 block text-xs text-ink-muted">
              Recorded permanently against this transaction, with your name and the
              time. Required.
            </span>
          </label>

          {error && (
            <div className="mt-3">
              <Notice tone="negative" title="The database refused this change">
                <p>{error}</p>
                <p className="mt-1.5 text-ink-muted">Nothing was changed.</p>
              </Notice>
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={action === 'void' ? 'danger' : 'primary'}
            onClick={submit}
            disabled={busy || !rationale.trim()}
          >
            {busy ? 'Applying…' : label}
          </Button>
        </footer>
      </div>
    </div>
  );
}
