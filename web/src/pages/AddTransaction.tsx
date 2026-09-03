/**
 * Manual entry, shaped to the workbook so future rows stay compatible with the
 * historical import.
 *
 * Three rules drive the behaviour here:
 *   - The amount is always entered as a positive number; the sign comes from
 *     the transaction type, so a purchase can never be recorded as increasing
 *     the balance by mistake.
 *   - Nothing is inferred. Choosing a currency requires its original amount and
 *     rate, unless the row is deliberately marked for review.
 *   - A possible duplicate is a warning, never a block: 217 rows in this
 *     workbook are genuine repeat charges, and merging them would lose money.
 */

import { useMemo, useState } from 'react';
import { submitTransaction } from '../lib/api';
import { useLedgerState } from '../components/LedgerProvider';
import { Page } from '../components/Layout';
import {
  Button,
  Field,
  Money,
  Notice,
  Panel,
  Tag,
  fieldClass,
} from '../components/ui';
import { formatDate, formatRate, todayISO } from '../lib/format';
import { CURRENCY_CODES } from '../lib/currencies';
import {
  TXN_KIND_LABEL,
  directionForKind,
  findDuplicateCandidates,
  getCards,
  round2,
  signedEffect,
} from '../lib/ledger';
import type { TxnKind } from '../lib/types';

interface FormState {
  cardId: string;
  date: string;
  kind: TxnKind;
  amountAed: string;
  supplier: string;
  reqNumber: string;
  paymentRef: string;
  // optional
  currency: string;
  originalAmount: string;
  exchangeRate: string;
  crm: string;
  lpoNumber: string;
  invoice: string;
  commissionable: string;
  client: string;
  salesOperation: string;
  supplierCountry: string;
  description: string;
  notes: string;
  attachment: string;
  needsReview: boolean;
}

const BLANK: FormState = {
  cardId: '',
  date: todayISO(),
  kind: 'purchase',
  amountAed: '',
  supplier: '',
  reqNumber: '',
  paymentRef: '',
  currency: '',
  originalAmount: '',
  exchangeRate: '',
  crm: '',
  lpoNumber: '',
  invoice: '',
  commissionable: '',
  client: '',
  salesOperation: '',
  supplierCountry: '',
  description: '',
  notes: '',
  attachment: '',
  needsReview: false,
};

type Errors = Partial<Record<keyof FormState, string>>;

function validate(f: FormState): Errors {
  const e: Errors = {};
  if (!f.cardId) e.cardId = 'Choose the card this transaction belongs to.';
  if (!f.date) e.date = 'A transaction date is required.';

  const amount = Number(f.amountAed);
  if (!f.amountAed.trim()) e.amountAed = 'Enter the AED settlement amount.';
  else if (!Number.isFinite(amount)) e.amountAed = 'Enter a number.';
  else if (amount <= 0)
    e.amountAed =
      'Enter a positive amount. Whether it raises or lowers the balance comes from the type.';

  if (!f.supplier.trim()) e.supplier = 'Enter the supplier or merchant name.';
  if (!f.reqNumber.trim()) e.reqNumber = 'Enter the request number.';
  if (!f.paymentRef.trim()) e.paymentRef = 'Enter the payment reference number.';

  if (f.supplierCountry && !/^\d{3}$/.test(f.supplierCountry.trim()))
    e.supplierCountry = 'ISO-3166 numeric code is three digits, e.g. 784.';

  // A converted transaction needs all three parts, or the row must say so.
  if (f.currency && !f.needsReview) {
    if (!f.originalAmount.trim())
      e.originalAmount = `Enter the amount in ${f.currency}, or mark the row for review.`;
    else if (!(Number(f.originalAmount) > 0))
      e.originalAmount = 'Enter a positive amount.';
    if (!f.exchangeRate.trim())
      e.exchangeRate = 'Enter the rate used, or mark the row for review.';
    else if (!(Number(f.exchangeRate) > 0)) e.exchangeRate = 'Enter a positive rate.';
  }
  if (!f.currency && (f.originalAmount.trim() || f.exchangeRate.trim()))
    e.currency = 'Select the currency these figures are in.';

  return e;
}

export function AddTransaction() {
  const cards = getCards();
  const [f, setF] = useState<FormState>(BLANK);
  const [touched, setTouched] = useState(false);
  const [saved, setSaved] = useState(false);
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const { reload, source } = useLedgerState();

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setF((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  const errors = validate(f);
  const hasErrors = Object.keys(errors).length > 0;
  const card = cards.find((c) => c.id === f.cardId);
  const amount = Number(f.amountAed) || 0;
  const effect = signedEffect(f.kind, amount);
  const direction = directionForKind(f.kind);
  const projected = card ? round2(card.ledgerBalance + effect) : null;

  // Rate consistency is shown, never corrected.
  const impliedAed =
    Number(f.originalAmount) > 0 && Number(f.exchangeRate) > 0
      ? round2(Number(f.originalAmount) * Number(f.exchangeRate))
      : null;
  const rateMismatch =
    impliedAed !== null && amount > 0 && Math.abs(impliedAed - amount) > 0.01;

  const duplicates = useMemo(() => {
    if (!f.cardId || !f.supplier.trim() || !(amount > 0)) return [];
    return findDuplicateCandidates({
      cardId: f.cardId,
      txn_date: f.date,
      amount_aed: effect,
      supplier_raw: f.supplierCountry
        ? `${f.supplier.trim()} ${f.supplierCountry.trim()}`
        : f.supplier.trim(),
      payment_ref: f.paymentRef.trim(),
      req_number: f.reqNumber.trim(),
      direction: direction ?? undefined,
    });
  }, [f, amount, effect, direction]);

  // Saving goes through create_transaction in the database, never a direct
  // insert. That function re-derives the sign from the type, recomputes the
  // dedup key, and refuses any caller who is not a named admin — so the rules
  // hold even if this form were bypassed entirely.
  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (hasErrors || submitting) return;

    setSubmitting(true);
    setSubmitError(null);
    const result = await submitTransaction({
      p_card_id: f.cardId,
      p_txn_date: f.date,
      p_kind: f.kind,
      p_amount_aed: Math.abs(Number(f.amountAed)),
      p_supplier: f.supplier.trim(),
      p_req_number: f.reqNumber.trim(),
      p_payment_ref: f.paymentRef.trim(),
      p_currency: f.currency || null,
      p_original_amount: f.originalAmount ? Number(f.originalAmount) : null,
      p_exchange_rate: f.exchangeRate ? Number(f.exchangeRate) : null,
      p_supplier_country: f.supplierCountry.trim() || null,
      p_crm: f.crm.trim() || null,
      p_lpo_number: f.lpoNumber.trim() || null,
      p_invoice: f.invoice.trim() || null,
      p_client: f.client.trim() || null,
      p_sales_operation: f.salesOperation.trim() || null,
      p_description: f.description.trim() || null,
      p_notes: f.notes.trim() || null,
      p_needs_review: f.needsReview,
    });
    setSubmitting(false);

    if (result.ok) {
      setSaved(true);
      setF(BLANK);
      setTouched(false);
      reload();
    } else {
      setSubmitError(result.error);
    }
  };

  const err = (k: keyof FormState) => (touched ? errors[k] : undefined);

  return (
    <Page
      title="Add transaction"
      description="Fields follow the workbook, so rows entered here stay compatible with the historical import. Nothing is inferred — an incomplete value is flagged, never filled in."
    >
      <form onSubmit={onSubmit} className="grid gap-5 xl:grid-cols-[1.5fr_1fr] xl:items-start">
        <div className="space-y-5">
          <Panel title="Required" description="Every transaction needs all of these.">
            <div className="grid gap-4 px-4 py-4 sm:grid-cols-2">
              <Field label="Card / account" required error={err('cardId')}>
                <select
                  value={f.cardId}
                  onChange={(e) => set('cardId', e.target.value)}
                  className={fieldClass}
                >
                  <option value="">Select a card…</option>
                  {cards.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Transaction date" required error={err('date')}>
                <input
                  type="date"
                  value={f.date}
                  onChange={(e) => set('date', e.target.value)}
                  className={fieldClass}
                />
              </Field>

              <Field
                label="Transaction type"
                required
                hint={
                  direction === 'spend'
                    ? 'Reduces the balance.'
                    : direction === 'funding'
                      ? 'Increases the balance.'
                      : 'Kept out of both spend and funding totals.'
                }
              >
                <select
                  value={f.kind}
                  onChange={(e) => set('kind', e.target.value as TxnKind)}
                  className={fieldClass}
                >
                  {(Object.keys(TXN_KIND_LABEL) as TxnKind[]).map((k) => (
                    <option key={k} value={k}>
                      {TXN_KIND_LABEL[k]}
                    </option>
                  ))}
                </select>
              </Field>

              <Field
                label="AED settlement amount"
                required
                error={err('amountAed')}
                hint="Always positive. The direction comes from the type above."
              >
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  inputMode="decimal"
                  value={f.amountAed}
                  onChange={(e) => set('amountAed', e.target.value)}
                  placeholder="0.00"
                  className={`${fieldClass} tnum`}
                />
              </Field>

              <Field label="Supplier / merchant" required error={err('supplier')}>
                <input
                  value={f.supplier}
                  onChange={(e) => set('supplier', e.target.value)}
                  placeholder="JW MARRIOTT"
                  className={fieldClass}
                />
              </Field>

              <Field
                label="Request number"
                required
                error={err('reqNumber')}
                hint="Compound values are kept whole, e.g. “SA 993 | REQ 11973”."
              >
                <input
                  value={f.reqNumber}
                  onChange={(e) => set('reqNumber', e.target.value)}
                  placeholder="UAEVP420"
                  className={fieldClass}
                />
              </Field>

              <Field label="Payment reference number" required error={err('paymentRef')}>
                <input
                  value={f.paymentRef}
                  onChange={(e) => set('paymentRef', e.target.value)}
                  placeholder="Payment Made: #9114"
                  className={fieldClass}
                />
              </Field>
            </div>
          </Panel>

          <Panel
            title="Original currency"
            description="Only where the transaction was charged in something other than AED. Leave blank for a native AED charge."
          >
            <div className="grid gap-4 px-4 py-4 sm:grid-cols-3">
              <Field label="Currency" error={err('currency')}>
                <select
                  value={f.currency}
                  onChange={(e) => set('currency', e.target.value)}
                  className={fieldClass}
                >
                  <option value="">None — charged in AED</option>
                  {CURRENCY_CODES.filter((c) => c !== 'AED').map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </Field>

              <Field
                label={`Original amount${f.currency ? ` (${f.currency})` : ''}`}
                error={err('originalAmount')}
              >
                <input
                  type="number"
                  step="0.0001"
                  min="0"
                  inputMode="decimal"
                  value={f.originalAmount}
                  onChange={(e) => set('originalAmount', e.target.value)}
                  disabled={!f.currency}
                  className={`${fieldClass} tnum`}
                />
              </Field>

              <Field
                label="Exchange rate"
                error={err('exchangeRate')}
                hint={f.currency ? `AED per 1 ${f.currency}` : 'AED per 1 unit'}
              >
                <input
                  type="number"
                  step="0.0000001"
                  min="0"
                  inputMode="decimal"
                  value={f.exchangeRate}
                  onChange={(e) => set('exchangeRate', e.target.value)}
                  disabled={!f.currency}
                  className={`${fieldClass} tnum`}
                />
              </Field>
            </div>

            {rateMismatch && (
              <div className="px-4 pb-4">
                <Notice tone="review" title="The rate and the AED amount disagree">
                  {f.originalAmount} {f.currency} at {formatRate(Number(f.exchangeRate))}{' '}
                  comes to <Money amount={impliedAed} />, but the settlement amount
                  entered is <Money amount={amount} />. Both are kept exactly as
                  entered — nothing is adjusted. Confirm which is right, or mark
                  the row for review.
                </Notice>
              </div>
            )}

            <div className="border-t border-line px-4 py-3">
              <label className="flex items-start gap-2 text-[13px]">
                <input
                  type="checkbox"
                  checked={f.needsReview}
                  onChange={(e) => set('needsReview', e.target.checked)}
                  className="mt-0.5 accent-[#1f4a73]"
                />
                <span>
                  <span className="font-medium">Mark this row as needing review</span>
                  <span className="block text-ink-muted">
                    Use when the currency, amount or rate is not known yet. The row
                    is saved incomplete and flagged, rather than filled in with a
                    guess.
                  </span>
                </span>
              </label>
            </div>
          </Panel>

          <Panel title="Optional details" description="Shown where the workbook records them.">
            <div className="grid gap-4 px-4 py-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="CRM">
                <input value={f.crm} onChange={(e) => set('crm', e.target.value)} className={fieldClass} />
              </Field>
              <Field label="LPO number">
                <input value={f.lpoNumber} onChange={(e) => set('lpoNumber', e.target.value)} placeholder="LPO-MICE-12672" className={fieldClass} />
              </Field>
              <Field label="Invoice reference or status">
                <input value={f.invoice} onChange={(e) => set('invoice', e.target.value)} placeholder="with supplier Invoice" className={fieldClass} />
              </Field>
              <Field label="Commissionable">
                <select value={f.commissionable} onChange={(e) => set('commissionable', e.target.value)} className={fieldClass}>
                  <option value="">Not stated</option>
                  <option value="commissionable">Commissionable</option>
                  <option value="non_commissionable">Not commissionable</option>
                </select>
              </Field>
              <Field label="Client">
                <input value={f.client} onChange={(e) => set('client', e.target.value)} className={fieldClass} />
              </Field>
              <Field label="Sales operation">
                <input value={f.salesOperation} onChange={(e) => set('salesOperation', e.target.value)} className={fieldClass} />
              </Field>
              <Field
                label="Supplier country code"
                error={err('supplierCountry')}
                hint="ISO-3166 numeric, e.g. 784 for the UAE."
              >
                <input value={f.supplierCountry} onChange={(e) => set('supplierCountry', e.target.value)} placeholder="784" className={`${fieldClass} tnum`} />
              </Field>
              <div className="sm:col-span-2 lg:col-span-3">
                <Field label="Description / details">
                  <input value={f.description} onChange={(e) => set('description', e.target.value)} className={fieldClass} />
                </Field>
              </div>
              <div className="sm:col-span-2 lg:col-span-3">
                <Field label="Notes">
                  <textarea value={f.notes} onChange={(e) => set('notes', e.target.value)} rows={2} className={fieldClass} />
                </Field>
              </div>
              <div className="sm:col-span-2 lg:col-span-3">
                <Field
                  label="Receipt or invoice attachment"
                  hint="File upload is wired up with document storage; the reference is recorded here meanwhile."
                >
                  <input value={f.attachment} onChange={(e) => set('attachment', e.target.value)} placeholder="Reference or filename" className={fieldClass} />
                </Field>
              </div>
            </div>
          </Panel>
        </div>

        {/* Preview — sticky beside the form on wide screens */}
        <div className="space-y-4 xl:sticky xl:top-5">
          <Panel title="Before saving">
            <div className="px-4 py-4">
              {!card ? (
                <p className="text-[13px] text-ink-muted">
                  Select a card to see its current balance and the effect of this
                  transaction.
                </p>
              ) : (
                <>
                  <div className="mb-3 text-[13px]">
                    <div className="font-medium text-ink">{card.name}</div>
                    <div className="text-ink-muted">
                      Opened {formatDate(card.openingDate)} at{' '}
                      <Money amount={card.openingBalance} code={false} /> AED
                    </div>
                  </div>

                  <dl className="space-y-2 text-[13px]">
                    <div className="flex items-baseline justify-between gap-4">
                      <dt className="text-ink-muted">Current live balance</dt>
                      <dd className="font-medium">
                        <Money amount={card.ledgerBalance} code={false} />
                      </dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-4">
                      <dt className="text-ink-muted">
                        {TXN_KIND_LABEL[f.kind]}
                        {direction === 'spend' && ' — decreases'}
                        {direction === 'funding' && ' — increases'}
                      </dt>
                      <dd className="font-medium">
                        <Money amount={effect} signed tone="ledger" code={false} />
                      </dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-4 border-t border-line pt-2">
                      <dt className="font-medium text-ink">Projected balance</dt>
                      <dd className="text-base font-semibold">
                        <Money amount={projected} code={false} />
                        <span className="ml-1 text-xs text-ink-faint">AED</span>
                      </dd>
                    </div>
                  </dl>

                  {f.currency && Number(f.originalAmount) > 0 && (
                    <div className="mt-3 rounded-sm border border-line bg-sunken px-3 py-2.5 text-[13px]">
                      <div className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">
                        Conversion
                      </div>
                      <div className="mt-1 tnum">
                        <Money
                          amount={Number(f.originalAmount)}
                          currency={f.currency}
                          code={false}
                        />{' '}
                        {f.currency}
                        {Number(f.exchangeRate) > 0 && (
                          <>
                            {' '}× {formatRate(Number(f.exchangeRate))} ={' '}
                            <Money amount={impliedAed} code={false} /> AED
                          </>
                        )}
                      </div>
                      <p className="mt-1 text-xs text-ink-muted">
                        The rate is stored on this transaction, at its own date.
                      </p>
                    </div>
                  )}

                  {f.kind === 'reconciliation_adjustment' && (
                    <div className="mt-3">
                      <Notice tone="review" title="Adjustments stay separate">
                        This will be recorded with no direction, so it can never
                        fall inside a spend or funding total, and it stays visible
                        until a real transaction replaces it.
                      </Notice>
                    </div>
                  )}
                </>
              )}
            </div>
          </Panel>

          {duplicates.length > 0 && (
            <Notice
              tone="accent"
              title={`${duplicates.length} matching row${duplicates.length > 1 ? 's' : ''} already recorded`}
            >
              <p>
                Same card, date, amount, supplier and references. This is only a
                warning — repeat charges are common and legitimate here, so
                saving creates a separate row rather than merging.
              </p>
              <ul className="mt-2 space-y-1">
                {duplicates.slice(0, 3).map((d) => (
                  <li key={d.id} className="text-xs text-ink-muted">
                    {d.source_sheet} row {d.source_row} · {formatDate(d.txn_date)} ·{' '}
                    <Money amount={d.amount_aed} signed code={false} /> AED
                  </li>
                ))}
              </ul>
            </Notice>
          )}

          {touched && hasErrors && (
            <Notice tone="negative" title="Some fields still need attention">
              <ul className="ml-4 list-disc space-y-0.5">
                {Object.entries(errors).map(([k, v]) => (
                  <li key={k}>{v}</li>
                ))}
              </ul>
            </Notice>
          )}

          {submitError && (
            <Notice tone="negative" title="The database refused this entry">
              <p>{submitError}</p>
              <p className="mt-1.5 text-ink-muted">
                Nothing was written. The rules are enforced in the database, so
                this is the same answer any client would get.
              </p>
            </Notice>
          )}

          {saved && (
            <Notice tone="accent" title="Saved to the ledger">
              The transaction was written through the audited server-side path
              and the balances above have been refreshed.
            </Notice>
          )}

          {source === 'sample' && (
            <Notice tone="review" title="Not connected to the live ledger">
              The form validates in full, but saving needs a Supabase connection.
              Use “Save draft” to keep this entry meanwhile.
            </Notice>
          )}

          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" disabled={submitting}>
              {submitting ? 'Saving…' : 'Save transaction'}
            </Button>
            <Button
              type="button"
              onClick={() => {
                setDraftSavedAt(new Date().toLocaleTimeString());
                setSaved(false);
              }}
            >
              Save draft
            </Button>
            <Button type="button" variant="ghost" onClick={() => { setF(BLANK); setTouched(false); setSaved(false); }}>
              Reset
            </Button>
          </div>
          {draftSavedAt && (
            <p className="text-xs text-ink-muted">
              Draft held at {draftSavedAt}. <Tag>Not yet in the ledger</Tag>
            </p>
          )}
        </div>
      </form>
    </Page>
  );
}
