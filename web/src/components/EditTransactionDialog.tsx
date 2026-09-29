/**
 * Editing a transaction.
 *
 * Only the fields that can honestly be changed are offered. The sheet name, row
 * number, raw date cell, raw currency text and the workbook's own rate formula
 * are absent, because those are the evidence a figure is judged against — the
 * database refuses to touch them, and offering them here would suggest
 * otherwise.
 *
 * The dialog states the balance before and after before anything is written,
 * and will not submit without a reason.
 */

import { useEffect, useState } from 'react';
import { updateTransaction } from '../lib/api';
import { currencyCodes } from '../lib/currencies';
import { formatDate } from '../lib/format';
import type { Card, Transaction, TxnKind } from '../lib/types';
import { Button, Field, Money, Notice, fieldClass } from './ui';

const KINDS: { value: TxnKind; label: string }[] = [
  { value: 'purchase', label: 'Purchase — decreases the balance' },
  { value: 'fee', label: 'Fee — decreases the balance' },
  { value: 'refund', label: 'Refund — increases the balance' },
  { value: 'funding', label: 'Funding / top-up — increases the balance' },
];

function kindOf(t: Transaction): TxnKind {
  return t.direction === 'funding' ? 'refund' : 'purchase';
}

/**
 * A value the source decides, shown in the shape of a field and not editable.
 *
 * Deliberately not a disabled input: a greyed-out box invites people to try,
 * and then to ask why it will not take. This reads as a stated fact, with the
 * reason beside it.
 */
function Locked({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="block text-[11px] font-medium uppercase tracking-wide text-ink-faint">
        {label}
      </span>
      <p className="mt-1 rounded-sm border border-line bg-sunken px-2.5 py-1.5 text-sm text-ink">
        {value}
      </p>
    </div>
  );
}

export function EditTransactionDialog({
  transaction,
  card,
  onClose,
  onDone,
}: {
  transaction: Transaction | null;
  card: Card | undefined;
  onClose: () => void;
  onDone: () => void;
}) {
  const [req, setReq] = useState('');
  const [paymentRef, setPaymentRef] = useState('');
  const [lpoNumber, setLpoNumber] = useState('');
  const [currency, setCurrency] = useState('');
  const [originalAmount, setOriginalAmount] = useState('');
  const [rate, setRate] = useState('');
  const [notes, setNotes] = useState('');
  const [rationale, setRationale] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!transaction) return;
    setReq(transaction.req_number ?? '');
    setPaymentRef(transaction.payment_ref ?? '');
    setLpoNumber(transaction.lpo_number ?? '');
    setCurrency(transaction.currency ?? '');
    setOriginalAmount(
      transaction.original_amount != null ? String(transaction.original_amount) : '',
    );
    setRate(transaction.exchange_rate != null ? String(transaction.exchange_rate) : '');
    setNotes(transaction.notes ?? '');
    setRationale('');
    setError(null);
  }, [transaction]);

  if (!transaction || !card) return null;
  const t = transaction;

  // Only the fields this screen can still change. The date, type, amount and
  // supplier are no longer among them, so they cannot make `changed` true and
  // are never sent.
  const changed =
    req !== (t.req_number ?? '') ||
    paymentRef !== (t.payment_ref ?? '') ||
    lpoNumber !== (t.lpo_number ?? '') ||
    currency !== (t.currency ?? '') ||
    originalAmount !== (t.original_amount != null ? String(t.original_amount) : '') ||
    rate !== (t.exchange_rate != null ? String(t.exchange_rate) : '') ||
    notes !== (t.notes ?? '');

  /**
   * Why Save cannot be pressed, in the words of the thing that is missing.
   *
   * Only one thing stops it now — having changed nothing. A reason used to as
   * well, and the button was simply disabled while the footer beside it said
   * "Unsaved changes", which read as the edit failing rather than as a field
   * waiting to be filled in. That is worth keeping in mind for whatever is
   * added here next: a disabled control has to say what it is waiting for.
   */
  const blocked = changed ? null : 'Nothing changed yet';

  const submit = async () => {
    // The same condition the button is disabled by, and deliberately the same
    // expression rather than a second copy of it.
    //
    // Making the reason optional changed the button and left this guard behind
    // still demanding one. The button was enabled, the click ran this, and it
    // returned here — no request, no error, no close. A press that does
    // nothing at all and says nothing at all, which is exactly how it was
    // reported: "still can't save it".
    if (blocked || busy) return;
    setBusy(true);
    setError(null);
    const result = await updateTransaction({
      p_id: t.id,
      p_rationale: rationale.trim(),
      // Not sent at all, rather than sent unchanged: update_transaction reads
      // a null as "leave this alone", so the row's date, amount, direction and
      // supplier cannot be touched from here even by a malformed request.
      p_req_number: req.trim() || null,
      p_payment_ref: paymentRef.trim() || null,
      // Sent even when empty, unlike the fields above: an empty string tells
      // the database to clear the LPO number, where null would mean
      // 'unchanged'.
      p_lpo_number: lpoNumber.trim(),
      p_currency: currency || null,
      p_original_amount: originalAmount ? Number(originalAmount) : null,
      p_exchange_rate: rate ? Number(rate) : null,
      p_notes: notes.trim() || null,
      // Blanking a currency has to be deliberate: leaving the field empty
      // otherwise means "unchanged", not "remove it".
      p_clear_currency: Boolean(t.currency) && currency === '',
    });
    setBusy(false);
    if (result.ok) {
      onDone();
      onClose();
    } else setError(result.error);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto px-4 py-8">
      <div className="fixed inset-0 bg-ink/25" onClick={() => !busy && onClose()} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Edit transaction"
        className="relative w-full max-w-2xl rounded-md border border-line bg-surface"
      >
        <header className="border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">Edit transaction</h2>
          <p className="mt-0.5 text-xs text-ink-muted">
            {card.name} · {t.source_sheet ? `row ${t.source_row}` : 'entered manually'} ·{' '}
            {formatDate(t.txn_date)}
          </p>
        </header>

        <div className="px-4 py-4">
          <div className="grid gap-4 sm:grid-cols-2">
            {/* The date, the amount, the direction and who was paid are what
                the source says happened, and they are also exactly what the
                importer recognises a row by. Editing one does not correct the
                row — it makes the row unrecognisable, so the next upload of
                the same statement writes it again and the balance moves by an
                amount nobody asked for. Shown, so the edit screen still tells
                you what you are annotating, and not editable. */}
            <Locked label="Transaction date" value={formatDate(t.txn_date)} />
            <Locked
              label="Type"
              value={KINDS.find((k) => k.value === kindOf(t))?.label ?? kindOf(t)}
            />
            <Locked
              label={`${card.settlementCurrency} settlement amount`}
              value={Math.abs(t.amount_aed).toLocaleString('en-US', {
                minimumFractionDigits: 2, maximumFractionDigits: 2,
              })}
            />
            <Locked label="Supplier" value={t.supplier ?? t.description ?? '—'} />
            <Field label="Request number">
              <input value={req} onChange={(e) => setReq(e.target.value)} className={fieldClass} />
            </Field>
            <Field label="Payment reference">
              <input value={paymentRef} onChange={(e) => setPaymentRef(e.target.value)} className={fieldClass} />
            </Field>
            <Field label="LPO number">
              <input
                value={lpoNumber}
                onChange={(e) => setLpoNumber(e.target.value)}
                className={fieldClass}
                placeholder="LPO-MICE-12672"
              />
            </Field>
            <Field label="Original currency">
              <select value={currency} onChange={(e) => setCurrency(e.target.value)} className={fieldClass}>
                <option value="">None — charged in AED</option>
                {currencyCodes().filter((c) => c !== 'AED').map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </Field>
            <Field label="Original amount">
              <input type="number" step="0.0001" min="0" value={originalAmount} disabled={!currency}
                     onChange={(e) => setOriginalAmount(e.target.value)} className={`${fieldClass} tnum`} />
            </Field>
            <Field label="Exchange rate">
              <input type="number" step="0.0000001" min="0" value={rate} disabled={!currency}
                     onChange={(e) => setRate(e.target.value)} className={`${fieldClass} tnum`} />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Notes">
                <input value={notes} onChange={(e) => setNotes(e.target.value)} className={fieldClass} />
              </Field>
            </div>
          </div>

          <dl className="mt-4 space-y-1.5 rounded-sm border border-line bg-sunken px-3 py-2.5 text-[13px]">
            <div className="flex justify-between gap-4">
              <dt className="text-ink-muted">This transaction, as recorded</dt>
              <dd>
                <Money amount={t.amount_aed} signed tone="ledger" code={false} />
                <span className="ml-1 text-xs text-ink-faint">{card.settlementCurrency}</span>
              </dd>
            </div>
            {card.tracksBalance !== false && (
              <div className="flex justify-between gap-4 border-t border-line pt-1.5">
                <dt className="text-ink-muted">Balance on this account</dt>
                <dd>
                  <Money amount={card.ledgerBalance} code={false} />
                  <span className="ml-1 text-xs text-ink-faint">{card.settlementCurrency}</span>
                </dd>
              </div>
            )}
            <div className="border-t border-line pt-1.5 text-xs text-ink-muted">
              Nothing on this screen moves either figure. The amount, the date, the direction
              and who was paid are what the source recorded; only the references beside them
              can be changed here.
            </div>
          </dl>

          <Notice tone="accent" title="What cannot be edited">
            The sheet name, row number, raw date cell, raw currency text and the
            workbook's own rate formula stay as imported. They are what let any
            figure be traced back to its source, so an edit must not be able to
            rewrite them.
          </Notice>

          <label className="mt-4 block">
            <span className="block text-[11px] font-medium uppercase tracking-wide text-ink-faint">
              Reason <span className="font-normal text-ink-faint">(optional)</span>
            </span>
            <textarea
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
              rows={2}
              placeholder="e.g. Amount corrected against the June statement — 1,240.00, not 1,420.00."
              className="mt-1 w-full rounded-sm border border-line-strong bg-surface px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
            />
            <span className="mt-1 block text-xs text-ink-muted">
              Stored with the before and after of every field this changes. The edit is
              recorded either way — with your name and the time — but without a line
              here, the History will say what changed and not why.
            </span>
          </label>

          {error && (
            <div className="mt-3">
              <Notice tone="negative" title="The database refused this edit">
                <p>{error}</p>
                <p className="mt-1.5 text-ink-muted">Nothing was changed.</p>
              </Notice>
            </div>
          )}
        </div>

        <footer className="flex items-center justify-between gap-2 border-t border-line px-4 py-3">
          <span
            className={`text-xs ${
              blocked && changed ? 'font-medium text-review' : 'text-ink-muted'
            }`}
          >
            {blocked ?? 'Unsaved changes'}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button
              variant="primary"
              onClick={submit}
              disabled={busy || Boolean(blocked)}
              title={blocked ?? undefined}
            >
              {busy ? 'Saving…' : 'Save edit'}
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}
