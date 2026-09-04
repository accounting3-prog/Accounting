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

import { useEffect, useMemo, useState } from 'react';
import { updateTransaction } from '../lib/api';
import { CURRENCY_CODES } from '../lib/currencies';
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
  const [date, setDate] = useState('');
  const [kind, setKind] = useState<TxnKind>('purchase');
  const [amount, setAmount] = useState('');
  const [supplier, setSupplier] = useState('');
  const [req, setReq] = useState('');
  const [paymentRef, setPaymentRef] = useState('');
  const [currency, setCurrency] = useState('');
  const [originalAmount, setOriginalAmount] = useState('');
  const [rate, setRate] = useState('');
  const [notes, setNotes] = useState('');
  const [rationale, setRationale] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!transaction) return;
    setDate(transaction.txn_date ?? '');
    setKind(kindOf(transaction));
    setAmount(String(Math.abs(transaction.amount_aed)));
    setSupplier(transaction.supplier ?? '');
    setReq(transaction.req_number ?? '');
    setPaymentRef(transaction.payment_ref ?? '');
    setCurrency(transaction.currency ?? '');
    setOriginalAmount(
      transaction.original_amount != null ? String(transaction.original_amount) : '',
    );
    setRate(transaction.exchange_rate != null ? String(transaction.exchange_rate) : '');
    setNotes(transaction.notes ?? '');
    setRationale('');
    setError(null);
  }, [transaction]);

  const projected = useMemo(() => {
    if (!transaction || !card) return null;
    const positive = Number(amount);
    if (!Number.isFinite(positive) || positive <= 0) return null;
    const signed = kind === 'purchase' || kind === 'fee' ? -positive : positive;
    // Take the old effect out and put the new one in.
    return card.ledgerBalance - transaction.amount_aed + signed;
  }, [transaction, card, amount, kind]);

  if (!transaction || !card) return null;
  const t = transaction;

  const changed =
    date !== (t.txn_date ?? '') ||
    kind !== kindOf(t) ||
    Number(amount) !== Math.abs(t.amount_aed) ||
    supplier !== (t.supplier ?? '') ||
    req !== (t.req_number ?? '') ||
    paymentRef !== (t.payment_ref ?? '') ||
    currency !== (t.currency ?? '') ||
    originalAmount !== (t.original_amount != null ? String(t.original_amount) : '') ||
    rate !== (t.exchange_rate != null ? String(t.exchange_rate) : '') ||
    notes !== (t.notes ?? '');

  const submit = async () => {
    if (!rationale.trim() || !changed || busy) return;
    setBusy(true);
    setError(null);
    const result = await updateTransaction({
      p_id: t.id,
      p_rationale: rationale.trim(),
      p_txn_date: date || null,
      p_amount_aed: Number(amount) || null,
      p_kind: kind,
      p_supplier: supplier.trim() || null,
      p_supplier_country: t.supplier_country ?? null,
      p_req_number: req.trim() || null,
      p_payment_ref: paymentRef.trim() || null,
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
            <Field label="Transaction date">
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={fieldClass} />
            </Field>
            <Field label="Type" hint="Decides the sign; the amount stays positive.">
              <select value={kind} onChange={(e) => setKind(e.target.value as TxnKind)} className={fieldClass}>
                {KINDS.map((k) => (
                  <option key={k.value} value={k.value}>{k.label}</option>
                ))}
              </select>
            </Field>
            <Field label="AED settlement amount">
              <input type="number" step="0.01" min="0" value={amount}
                     onChange={(e) => setAmount(e.target.value)} className={`${fieldClass} tnum`} />
            </Field>
            <Field label="Supplier">
              <input value={supplier} onChange={(e) => setSupplier(e.target.value)} className={fieldClass} />
            </Field>
            <Field label="Request number">
              <input value={req} onChange={(e) => setReq(e.target.value)} className={fieldClass} />
            </Field>
            <Field label="Payment reference">
              <input value={paymentRef} onChange={(e) => setPaymentRef(e.target.value)} className={fieldClass} />
            </Field>
            <Field label="Original currency">
              <select value={currency} onChange={(e) => setCurrency(e.target.value)} className={fieldClass}>
                <option value="">None — charged in AED</option>
                {CURRENCY_CODES.filter((c) => c !== 'AED').map((c) => (
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
              <dt className="text-ink-muted">Official live balance now</dt>
              <dd><Money amount={card.ledgerBalance} code={false} /></dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-ink-muted">This transaction, as recorded</dt>
              <dd><Money amount={t.amount_aed} signed tone="ledger" code={false} /></dd>
            </div>
            <div className="flex justify-between gap-4 border-t border-line pt-1.5 font-medium">
              <dt>Balance after this edit</dt>
              <dd className="text-base font-semibold">
                <Money amount={projected} code={false} />
                <span className="ml-1 text-xs text-ink-faint">AED</span>
              </dd>
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
              Reason <span className="text-negative">*</span>
            </span>
            <textarea
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
              rows={2}
              placeholder="e.g. Amount corrected against the June statement — 1,240.00, not 1,420.00."
              className="mt-1 w-full rounded-sm border border-line-strong bg-surface px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
            />
            <span className="mt-1 block text-xs text-ink-muted">
              Stored with the before and after of every field this changes. Required.
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
          <span className="text-xs text-ink-muted">
            {changed ? 'Unsaved changes' : 'Nothing changed yet'}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button variant="primary" onClick={submit} disabled={busy || !changed || !rationale.trim()}>
              {busy ? 'Saving…' : 'Save edit'}
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}
