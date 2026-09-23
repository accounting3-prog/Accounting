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
 * Starts empty: LedgerProvider fills it — from Supabase, or from the audited
 * sample loaded on demand — before any page renders. The sample is no longer
 * imported here, so its 1.2 MB stays out of the initial bundle for the signed-in
 * user who will never see it.
 */
let data: LedgerData = {
  generatedFrom: 'none',
  cards: [],
  transactions: [],
  spendByCurrency: [],
};

export function setLedgerData(next: LedgerData): void {
  data = next;
}

export function getLedger(): LedgerData {
  return data;
}

/**
 * A bank account rather than a payment card.
 *
 * Asked in one place so the answer cannot drift between screens. It is the
 * account's recorded type, not its name: 'BANK KSA' happens to say so, but the
 * next account added might not.
 */
export function isBankAccount(card: Card): boolean {
  return card.cardType === 'bank_account';
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

/** What one settlement currency's accounts come to, on their own. */
export interface CurrencyTotal {
  code: string;
  liveBalance: number;
  sourceBalance: number;
  reconciliationDifference: number;
  cardCount: number;
}

export interface LedgerTotals {
  /**
   * Money, one set of figures per settlement currency and never one figure
   * across them.
   *
   * This used to be a single `liveBalance`, correct only because every account
   * happened to settle in AED — the comment on it said so. A SAR bank account
   * makes that assumption false, and a single total would have added riyals to
   * dirhams and labelled the result AED. Counts are still summed, because a
   * transaction is a transaction whatever it settled in.
   */
  byCurrency: CurrencyTotal[];
  cardCount: number;
  transactionCount: number;
  needsReview: number;
  excluded: number;
  /** Accounts whose source and ledger balances disagree, in any currency. */
  cardsWithDifference: Card[];
}

export function getTotals(): LedgerTotals {
  const cards = data.cards;
  const sum = (f: (c: Card) => number) => cards.reduce((a, c) => a + f(c), 0);

  const groups = new Map<string, Card[]>();
  for (const c of cards) {
    // An account that tracks no balance contributes none. NBD settles in AED
    // and holds 222 payments, so its "balance" is -13,674,062.24 — the total
    // ever paid through it, which is not money the business holds and must not
    // be added to the money it does. Its transactions still count everywhere
    // a transaction is counted; it is the balance that does not exist.
    if (c.tracksBalance === false) continue;
    const code = c.settlementCurrency || 'AED';
    if (!groups.has(code)) groups.set(code, []);
    groups.get(code)!.push(c);
  }

  const byCurrency = [...groups.entries()]
    .map(([code, group]) => ({
      code,
      liveBalance: round2(group.reduce((a, c) => a + c.ledgerBalance, 0)),
      sourceBalance: round2(group.reduce((a, c) => a + c.sourceBalance, 0)),
      reconciliationDifference: round2(
        group.reduce((a, c) => a + c.reconciliationDifference, 0),
      ),
      cardCount: group.length,
    }))
    // Most accounts first, so the currency the business mostly runs in leads
    // rather than whichever code happens to sort first.
    .sort((a, b) => b.cardCount - a.cardCount || a.code.localeCompare(b.code));

  return {
    byCurrency,
    cardCount: cards.length,
    transactionCount: sum((c) => c.transactionCount),
    needsReview: sum((c) => c.needsReview),
    excluded: sum((c) => c.excluded),
    cardsWithDifference: cards.filter(
      (c) => c.tracksBalance !== false && Math.abs(c.reconciliationDifference) > 0.005,
    ),
  };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/* --------------------------------------------------------------- reporting */

export interface MonthActivity {
  month: string;   // YYYY-MM
  spend: number;   // negative
  funding: number; // positive
}

/**
 * Spend and funding by calendar month, most recent first.
 *
 * Kept as two separate figures rather than a net: a month that spent 6.7m and
 * received 6.8m is not a quiet month, and netting them to +110k would say it
 * was.
 */
export function activityByMonth(limit = 6): MonthActivity[] {
  const months = new Map<string, MonthActivity>();
  for (const t of data.transactions) {
    if (!t.txn_date || t.entry_type !== 'source_transaction') continue;
    const key = t.txn_date.slice(0, 7);
    let m = months.get(key);
    if (!m) {
      m = { month: key, spend: 0, funding: 0 };
      months.set(key, m);
    }
    if (t.direction === 'spend') m.spend += t.amount_aed;
    else if (t.direction === 'funding') m.funding += t.amount_aed;
  }
  return [...months.values()].sort((a, b) => b.month.localeCompare(a.month)).slice(0, limit);
}

export interface SupplierSpend {
  supplier: string;
  count: number;
  aed: number; // negative
}

/** Where the money actually went, in AED — the one currency they compare in. */
export function topSuppliers(limit = 8): SupplierSpend[] {
  const by = new Map<string, SupplierSpend>();
  for (const t of data.transactions) {
    if (t.direction !== 'spend' || !t.supplier) continue;
    let s = by.get(t.supplier);
    if (!s) {
      s = { supplier: t.supplier, count: 0, aed: 0 };
      by.set(t.supplier, s);
    }
    s.count += 1;
    s.aed += t.amount_aed;
  }
  return [...by.values()].sort((a, b) => a.aed - b.aed).slice(0, limit);
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
        // An adjustment belongs in the queue only while it is unresolved.
        // Once confirmed or voided somebody has decided about it, and leaving
        // it here said "1 awaiting review" on a card that was fully settled.
        (t.entry_type === 'reconciliation_adjustment' &&
          t.status !== 'confirmed' &&
          t.status !== 'voided'),
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

/**
 * Where a card's balance lands once `signedTotal` is added to it.
 *
 * The card decides which way its own balance moves. Six of the seven sheets
 * write an available balance, so spending lowers it; RAK 9825's statement
 * counts what has been drawn, so spending raises it. Every projection in the
 * app goes through here rather than writing `balance + amount` inline, because
 * that expression is right on six cards and wrong on the seventh.
 *
 * `signedTotal` is always the economic sign: spend negative, money in positive.
 */
export function projectBalance(card: Card, signedTotal: number): number {
  return round2(card.ledgerBalance + card.balanceSign * signedTotal);
}

export const TXN_KIND_LABEL: Record<TxnKind, string> = {
  purchase: 'Purchase',
  refund: 'Refund',
  funding: 'Funding / top-up',
  fee: 'Fee',
  reconciliation_adjustment: 'Reconciliation adjustment',
  other: 'Other',
};

/* ------------------------------------------------------ totalling a result set */

export interface ResultTotals {
  /** Money out, as a positive figure. */
  spent: number;
  /** Money in — refunds and funding — as a positive figure. */
  received: number;
  /** spent − received. Positive means more went out than came back. */
  net: number;
  rows: number;
  spendRows: number;
  receivedRows: number;
  /**
   * Reconciliation adjustments, kept apart.
   *
   * An adjustment is not a transaction that happened; it is the named
   * difference between what a sheet asserts and what its own rows add up to.
   * Folding one into a spend total would present a discrepancy as a purchase.
   */
  adjustments: number;
  adjustmentRows: number;
  /**
   * The original amounts, one figure per currency, never added together.
   *
   * 100 EUR and 100 JPY are not 200 of anything. The AED figures above are
   * comparable because every card settles in AED; these are not, so they stay
   * in separate buckets for as long as they are on screen.
   */
  byCurrency: { code: string; amount: number; rows: number }[];
}

/**
 * What a set of rows adds up to.
 *
 * Written for the question people actually ask of a search — "how much did
 * REQ 11973 cost us in the end" — which is a net figure: what went out, less
 * what came back. A page that shows only the spending answers a different
 * question and answers it confidently.
 */
export function totalsFor(transactions: Transaction[]): ResultTotals {
  let spent = 0;
  let received = 0;
  let spendRows = 0;
  let receivedRows = 0;
  let adjustments = 0;
  let adjustmentRows = 0;
  const currencies = new Map<string, { amount: number; rows: number }>();

  for (const t of transactions) {
    if (t.status === 'voided') continue;

    if (t.entry_type === 'reconciliation_adjustment') {
      adjustments += t.amount_aed;
      adjustmentRows += 1;
      continue;
    }

    // amount_aed is signed at the source: spend negative, money in positive.
    if (t.amount_aed < 0) {
      spent += -t.amount_aed;
      spendRows += 1;
    } else if (t.amount_aed > 0) {
      received += t.amount_aed;
      receivedRows += 1;
    }

    if (t.currency && t.original_amount) {
      const bucket = currencies.get(t.currency) ?? { amount: 0, rows: 0 };
      bucket.amount += Math.abs(t.original_amount) * (t.amount_aed < 0 ? 1 : -1);
      bucket.rows += 1;
      currencies.set(t.currency, bucket);
    }
  }

  return {
    spent: round2(spent),
    received: round2(received),
    net: round2(spent - received),
    rows: transactions.filter((t) => t.status !== 'voided').length,
    spendRows,
    receivedRows,
    adjustments: round2(adjustments),
    adjustmentRows,
    byCurrency: [...currencies.entries()]
      .map(([code, b]) => ({ code, amount: round2(b.amount), rows: b.rows }))
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)),
  };
}
