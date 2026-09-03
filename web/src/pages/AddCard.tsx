/**
 * Adding a card or account.
 *
 * Admin-only, and written through create_card in the database rather than a
 * client insert, so the uniqueness check, the required opening date and the
 * immutable audit row cannot be skipped by bypassing this form.
 *
 * The opening date is required here and optional on imported cards, which is
 * deliberate: an imported card's date is the date of its own first transaction,
 * so nothing can predate it. A card created by hand has history that already
 * exists, and without a date the balance would silently absorb transactions
 * settled before the account was opened.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Page } from '../components/Layout';
import { useLedgerState } from '../components/LedgerProvider';
import {
  Button,
  Field,
  Money,
  Notice,
  Panel,
  fieldClass,
} from '../components/ui';
import { createCard } from '../lib/api';
import { CURRENCY_CODES } from '../lib/currencies';
import { formatDate, todayISO } from '../lib/format';
import { getCards } from '../lib/ledger';

const CARD_TYPES = [
  'Credit card',
  'Debit card',
  'Virtual card',
  'Bank account',
  'Prepaid account',
  'Other',
];

interface FormState {
  name: string;
  settlementCurrency: string;
  openingBalance: string;
  openingDate: string;
  cardType: string;
  status: 'active' | 'inactive';
  bankIssuer: string;
  accountReference: string;
  creditLimit: string;
  notes: string;
}

const BLANK: FormState = {
  name: '',
  settlementCurrency: 'AED',
  openingBalance: '',
  openingDate: todayISO(),
  cardType: '',
  status: 'active',
  bankIssuer: '',
  accountReference: '',
  creditLimit: '',
  notes: '',
};

type Errors = Partial<Record<keyof FormState, string>>;

function validate(f: FormState, existingNames: string[]): Errors {
  const e: Errors = {};
  const name = f.name.trim();
  if (!name) e.name = 'A card or account name is required.';
  else if (existingNames.some((n) => n.toLowerCase() === name.toLowerCase()))
    e.name = 'A card with this name already exists. Names must be unique.';

  if (!f.openingBalance.trim()) e.openingBalance = 'An opening balance is required.';
  else if (!Number.isFinite(Number(f.openingBalance)))
    e.openingBalance = 'Enter a number. A negative opening balance is allowed.';

  if (!f.openingDate) e.openingDate = 'An opening balance date is required.';
  if (!f.cardType) e.cardType = 'Choose the account type.';

  if (f.accountReference.trim() && f.accountReference.trim().length > 8)
    e.accountReference =
      'Use the last four digits or a short reference, never a full card number.';

  if (f.creditLimit.trim() && !(Number(f.creditLimit) > 0))
    e.creditLimit = 'Enter a positive limit, or leave blank.';

  return e;
}

export function AddCard() {
  const navigate = useNavigate();
  const cards = getCards();
  const { reload, source } = useLedgerState();

  const [f, setF] = useState<FormState>(BLANK);
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [savedName, setSavedName] = useState<string | null>(null);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setF((p) => ({ ...p, [key]: value }));
    setSavedName(null);
    setSubmitError(null);
  };

  const errors = validate(f, cards.map((c) => c.name));
  const hasErrors = Object.keys(errors).length > 0;
  const err = (k: keyof FormState) => (touched ? errors[k] : undefined);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (hasErrors || submitting) return;

    setSubmitting(true);
    setSubmitError(null);
    const result = await createCard({
      p_name: f.name.trim(),
      p_opening_balance: Number(f.openingBalance),
      p_opening_date: f.openingDate,
      p_card_type: f.cardType,
      p_status: f.status,
      p_settlement_currency: f.settlementCurrency,
      p_bank_issuer: f.bankIssuer.trim() || null,
      p_account_reference: f.accountReference.trim() || null,
      p_credit_limit: f.creditLimit ? Number(f.creditLimit) : null,
      p_notes: f.notes.trim() || null,
    });
    setSubmitting(false);

    if (result.ok) {
      setSavedName(f.name.trim());
      setF(BLANK);
      setTouched(false);
      reload();
    } else {
      setSubmitError(result.error);
    }
  };

  return (
    <Page
      title="Add a card or account"
      description="Each account keeps its own balance in its own settlement currency. Balances are never combined across cards or across currencies."
      actions={
        <Button type="button" onClick={() => navigate('/cards')}>
          Back to cards
        </Button>
      }
    >
      <form onSubmit={onSubmit} className="grid gap-5 xl:grid-cols-[1.5fr_1fr] xl:items-start">
        <div className="space-y-5">
          <Panel title="Required">
            <div className="grid gap-4 px-4 py-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Field
                  label="Card / account name"
                  required
                  error={err('name')}
                  hint="Kept exactly as entered. Imported cards use their workbook sheet name verbatim."
                >
                  <input
                    value={f.name}
                    onChange={(e) => set('name', e.target.value)}
                    placeholder="MASTERCARD 1234 (5678)"
                    className={fieldClass}
                  />
                </Field>
              </div>

              <Field label="Account type" required error={err('cardType')}>
                <select
                  value={f.cardType}
                  onChange={(e) => set('cardType', e.target.value)}
                  className={fieldClass}
                >
                  <option value="">Select a type…</option>
                  {CARD_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </Field>

              <Field
                label="Settlement currency"
                required
                hint="The currency this account's balance is denominated in."
              >
                <select
                  value={f.settlementCurrency}
                  onChange={(e) => set('settlementCurrency', e.target.value)}
                  className={fieldClass}
                >
                  {CURRENCY_CODES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </Field>

              <Field
                label="Opening balance"
                required
                error={err('openingBalance')}
                hint="May be negative."
              >
                <input
                  type="number"
                  step="0.01"
                  inputMode="decimal"
                  value={f.openingBalance}
                  onChange={(e) => set('openingBalance', e.target.value)}
                  placeholder="0.00"
                  className={`${fieldClass} tnum`}
                />
              </Field>

              <Field
                label="Opening balance date"
                required
                error={err('openingDate')}
                hint="Transactions dated before this do not affect the balance."
              >
                <input
                  type="date"
                  value={f.openingDate}
                  onChange={(e) => set('openingDate', e.target.value)}
                  className={fieldClass}
                />
              </Field>

              <Field label="Status" required>
                <select
                  value={f.status}
                  onChange={(e) => set('status', e.target.value as 'active' | 'inactive')}
                  className={fieldClass}
                >
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </Field>
            </div>
          </Panel>

          <Panel title="Optional">
            <div className="grid gap-4 px-4 py-4 sm:grid-cols-2">
              <Field label="Bank or issuer">
                <input
                  value={f.bankIssuer}
                  onChange={(e) => set('bankIssuer', e.target.value)}
                  className={fieldClass}
                />
              </Field>
              <Field
                label="Last four digits or reference"
                error={err('accountReference')}
                hint="Never store a full card number."
              >
                <input
                  value={f.accountReference}
                  onChange={(e) => set('accountReference', e.target.value)}
                  placeholder="4173"
                  maxLength={8}
                  className={`${fieldClass} tnum`}
                />
              </Field>
              <Field label="Credit limit or internal reference" error={err('creditLimit')}>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  inputMode="decimal"
                  value={f.creditLimit}
                  onChange={(e) => set('creditLimit', e.target.value)}
                  className={`${fieldClass} tnum`}
                />
              </Field>
              <div className="sm:col-span-2">
                <Field label="Notes">
                  <textarea
                    value={f.notes}
                    onChange={(e) => set('notes', e.target.value)}
                    rows={2}
                    className={fieldClass}
                  />
                </Field>
              </div>
            </div>
          </Panel>
        </div>

        <div className="space-y-4 xl:sticky xl:top-5">
          <Panel title="Before saving">
            <div className="px-4 py-4">
              {f.name.trim() ? (
                <>
                  <div className="text-[13px] font-medium text-ink">{f.name.trim()}</div>
                  <div className="text-xs text-ink-muted">
                    {f.cardType || 'type not chosen'} · {f.status}
                  </div>
                  <dl className="mt-3 space-y-2 text-[13px]">
                    <div className="flex items-baseline justify-between gap-4">
                      <dt className="text-ink-muted">Opening balance</dt>
                      <dd className="font-medium">
                        <Money
                          amount={Number(f.openingBalance) || 0}
                          currency={f.settlementCurrency}
                        />
                      </dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-4">
                      <dt className="text-ink-muted">Opening date</dt>
                      <dd>{formatDate(f.openingDate)}</dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-4 border-t border-line pt-2">
                      <dt className="font-medium text-ink">Live balance at creation</dt>
                      <dd className="text-base font-semibold">
                        <Money
                          amount={Number(f.openingBalance) || 0}
                          currency={f.settlementCurrency}
                        />
                      </dd>
                    </div>
                  </dl>
                  <p className="mt-3 text-xs text-ink-muted">
                    The balance is computed from the opening figure plus every
                    transaction on or after {formatDate(f.openingDate)}. It is never
                    stored as an editable number.
                  </p>
                </>
              ) : (
                <p className="text-[13px] text-ink-muted">
                  Enter a name to see how this account will be created.
                </p>
              )}
            </div>
          </Panel>

          <Notice tone="accent" title="Creating a card is recorded permanently">
            An immutable audit row is written naming who created the account and
            when, along with the opening figures. That record can be read but
            never edited or deleted.
          </Notice>

          {source === 'sample' && (
            <Notice tone="review" title="Not connected to the live ledger">
              The form validates in full, but creating a card needs a Supabase
              connection and an admin account.
            </Notice>
          )}

          {submitError && (
            <Notice tone="negative" title="The database refused this card">
              <p>{submitError}</p>
              <p className="mt-1.5 text-ink-muted">
                Nothing was created. The rules are enforced in the database, so
                this is the same answer any client would get.
              </p>
            </Notice>
          )}

          {savedName && (
            <Notice tone="accent" title={`${savedName} created`}>
              The card is live and its audit record is written.{' '}
              <button
                type="button"
                onClick={() => navigate('/cards')}
                className="font-medium text-accent underline underline-offset-2"
              >
                View all cards
              </button>
            </Notice>
          )}

          {touched && hasErrors && (
            <Notice tone="negative" title="Some fields still need attention">
              <ul className="ml-4 list-disc space-y-0.5">
                {Object.values(errors).map((v) => (
                  <li key={v}>{v}</li>
                ))}
              </ul>
            </Notice>
          )}

          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" disabled={submitting}>
              {submitting ? 'Creating…' : 'Create card'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setF(BLANK);
                setTouched(false);
                setSavedName(null);
                setSubmitError(null);
              }}
            >
              Reset
            </Button>
          </div>
        </div>
      </form>
    </Page>
  );
}
