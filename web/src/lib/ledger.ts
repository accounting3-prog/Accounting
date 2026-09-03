/**
 * Ledger reads and derived figures for the UI.
 *
 * The arithmetic here mirrors the audited pipeline and must not diverge from
 * it. In particular:
 *   - a card's live balance is opening + transactions, computed, never stored;
 *   - source and ledger balances are separate figures and the difference
 *     between them is shown, never quietly reconciled away;
 *   - reconciliation adjustments carry no direction, so they can never fall
 *     into a spend or funding total;
 *   - amounts in different currencies are never added together.
 */

import sample from '../data/ledger-sample.json';
import type {
  Card,
  CurrencySpend,
  LedgerData,
  ReviewItem,
  ReviewKind,
  Transaction,
  TxnKind,
} from './types';

/**
 * The ledger currently on screen.
 *
 * Held in one place so the selectors below stay plain synchronous functions and
 * the pages that call them did not have to change when the data source moved
 * from a bundled extract to Supabase. LedgerProvider fills this before any page
 * renders, so a component never reads a half-loaded ledger.
 *
 * Seeded with the audited sample so the app is usable with no backend.
 */
let data: LedgerData = sample as unknown as LedgerData;

export function setLedgerData(next: LedgerData): void {
  data = next;
}

export function getLedger(): LedgerData {
  return data;
}

export function getCards(): Card[] {
  return data.cards;
}

export function getCard(id: string): Card | undefined {
  return data.cards.find((c) => c.id === id);
}

export function getCardByName(name: string): Card | undefined {
  return data.cards.find((c) => c.name === name);
}

export function getTransactions(): Transaction[] {
  return data.transactions;
}

export function getCardTransactions(cardId: string): Transaction[] {
  return data.transactions.filter((t) => t.cardId === cardId);
}

export function getSpendByCurrency(cardId?: string): CurrencySpend[] {
  return cardId
    ? data.spendByCurrency.filter((s) => s.cardId === cardId)
    : data.spendByCurrency;
}

/**
 * Spend per currency across all cards.
 *
 * Returns one row per currency and deliberately no total: adding 1,835,294 EUR
 * to 56,365,582 JPY produces a number that looks like money and is not. A
 * caller wanting a single comparable figure must use the AED settlement column.
 */
export function spendByCurrencyOverall(): CurrencySpend[] {
  const merged = new Map<string, CurrencySpend>();
  for (const row of data.spendByCurrency) {
    const existing = merged.get(row.currency);
    if (existing) {
      existing.count += row.count;
      existing.originalTotal += row.originalTotal;
      existing.aedTotal += row.aedTotal;
    } else {
      merged.set(row.currency, { ...row, cardId: 'all' });
    }
  }
  return [...merged.values()].sort((a, b) => b.count - a.count);
}

/* ------------------------------------------------------------------ totals */

export interface LedgerTotals {
  /** Live AED across every card. AED only — all cards settle in AED. */
  liveBalance: number;
  sourceBalance: number;
  reconciliationDifference: number;
  cardCount: number;
  transactionCount: number;
  needsReview: number;
  excluded: number;
  /** Cards whose source and ledger balances disagree. */
  cardsWithDifference: Card[];
  reviewAdjustmentsTotal: number;
}

export function getTotals(): LedgerTotals {
  const cards = data.cards;
  const sum = (f: (c: Card) => number) => cards.reduce((a, c) => a + f(c), 0);
  return {
    liveBalance: round2(sum((c) => c.ledgerBalance)),
    sourceBalance: round2(sum((c) => c.sourceBalance)),
    reconciliationDifference: round2(sum((c) => c.reconciliationDifference)),
    cardCount: cards.length,
    transactionCount: sum((c) => c.transactionCount),
    needsReview: sum((c) => c.needsReview),
    excluded: sum((c) => c.excluded),
    cardsWithDifference: cards.filter(
      (c) => Math.abs(c.reconciliationDifference) > 0.005,
    ),
    reviewAdjustmentsTotal: round2(sum((c) => c.reviewAdjustmentsTotal)),
  };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/* ------------------------------------------------------------------ review */

/** Why a transaction is in the review queue. Derived from the audit's own
 *  reason text rather than re-inferred. */
export function reviewKind(t: Transaction): ReviewKind {
  if (t.entry_type === 'reconciliation_adjustment') return 'manual_balance_adjustment';
  if (t.status === 'excluded_from_source_balance') return 'excluded_from_source_balance';
  const r = t.review_reason ?? '';
  if (r.includes('rate_without_currency')) return 'rate_without_currency';
  if (r.includes('rate_denominator_mismatch')) return 'rate_mismatch';
  if (r.includes('rate_formula_unexpected')) return 'rate_hardcoded';
  if (r.includes('currency_unparseable') || r.includes('currency_unrecognised'))
    return 'currency_unreadable';
  return 'other';
}

export const REVIEW_KIND_LABEL: Record<ReviewKind, string> = {
  currency_unreadable: 'Currency unreadable',
  rate_mismatch: 'Exchange-rate mismatch',
  rate_without_currency: 'Rate with no stated currency',
  rate_hardcoded: 'Rate hardcodes both sides',
  manual_balance_adjustment: 'Manual balance adjustment',
  excluded_from_source_balance: 'Excluded from source balance',
  duplicate_candidate: 'Possible duplicate',
  other: 'Needs review',
};

export function getReviewItems(): ReviewItem[] {
  const cardsById = new Map(data.cards.map((c) => [c.id, c]));
  return data.transactions
    .filter(
      (t) =>
        t.status === 'needs_review' ||
        t.status === 'excluded_from_source_balance' ||
        t.entry_type === 'reconciliation_adjustment',
    )
    .map((t) => ({
      transaction: t,
      card: cardsById.get(t.cardId)!,
      kind: reviewKind(t),
      reason: t.review_reason ?? 'Flagged during import',
    }))
    .sort((a, b) => (b.transaction.txn_date ?? '').localeCompare(a.transaction.txn_date ?? ''));
}

/* -------------------------------------------------------------- duplicates */

/**
 * What makes two rows the same transaction, apart from how many times it
 * happened. Direction is included, so a payment and its refund sharing a
 * reference number never collapse into one.
 */
export function contentSignature(t: {
  cardId: string;
  txn_date?: string;
  amount_aed: number;
  supplier_raw?: string;
  payment_ref?: string;
  req_number?: string;
  direction?: string;
  entry_type?: string;
}): string {
  return [
    t.cardId,
    t.txn_date ?? '',
    t.amount_aed.toFixed(2),
    (t.supplier_raw ?? '').toUpperCase(),
    (t.payment_ref ?? '').toUpperCase(),
    (t.req_number ?? '').toUpperCase(),
    t.direction ?? t.entry_type ?? '',
  ].join('|');
}

/**
 * Rows already recorded that match a candidate exactly.
 *
 * 217 rows in the historical workbook share every identifying field with
 * another and are all genuine, so this warns and never blocks. Merging them
 * would lose real money from the ledger.
 */
export function findDuplicateCandidates(candidate: {
  cardId: string;
  txn_date?: string;
  amount_aed: number;
  supplier_raw?: string;
  payment_ref?: string;
  req_number?: string;
  direction?: string;
}): Transaction[] {
  const sig = contentSignature(candidate);
  return data.transactions.filter((t) => contentSignature(t) === sig);
}

/* ------------------------------------------------------- manual entry maths */

/** A purchase and a fee reduce the balance; a refund and a top-up raise it. */
export function directionForKind(kind: TxnKind): 'spend' | 'funding' | null {
  switch (kind) {
    case 'purchase':
    case 'fee':
      return 'spend';
    case 'refund':
    case 'funding':
      return 'funding';
    case 'reconciliation_adjustment':
      return null; // deliberately neither, so it stays out of both totals
    default:
      return null;
  }
}

/**
 * The signed effect on the balance.
 *
 * The form collects a positive amount for every kind; the sign is applied here
 * from the kind alone, so a user can never accidentally enter a purchase that
 * increases the balance.
 */
export function signedEffect(kind: TxnKind, positiveAmount: number): number {
  const dir = directionForKind(kind);
  if (dir === 'spend') return -Math.abs(positiveAmount);
  if (dir === 'funding') return Math.abs(positiveAmount);
  return positiveAmount; // adjustment: signed as entered, and never in a total
}

export const TXN_KIND_LABEL: Record<TxnKind, string> = {
  purchase: 'Purchase',
  refund: 'Refund',
  funding: 'Funding / top-up',
  fee: 'Fee',
  reconciliation_adjustment: 'Reconciliation adjustment',
  other: 'Other',
};
