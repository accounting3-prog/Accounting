/**
 * Shapes mirroring the database exactly. These are the audited fields from the
 * workbook extraction — nothing here is reinterpreted for display.
 */

export type TxnDirection = 'spend' | 'funding';

export type TxnEntryType = 'source_transaction' | 'reconciliation_adjustment';

export type TxnStatus =
  | 'confirmed'
  | 'needs_review'
  | 'excluded_from_source_balance'
  | 'voided';

/** What a manually entered transaction is. Maps to direction on save. */
export type TxnKind =
  | 'purchase'
  | 'refund'
  | 'funding'
  | 'fee'
  | 'reconciliation_adjustment'
  | 'other';

export interface Card {
  id: string;
  /** The Excel sheet name, verbatim. Never reformatted for display. */
  name: string;
  settlementCurrency: string;
  openingBalance: number;
  openingDate: string | null;
  lastTransaction: string | null;
  /** What the workbook itself shows. */
  sourceBalance: number;
  /** Real transactions only, no reconciliation plugs. */
  ledgerBalance: number;
  /** sourceBalance − ledgerBalance. Non-zero means the two disagree. */
  reconciliationDifference: number;
  totalSpend: number;
  totalFunding: number;
  reviewAdjustmentsTotal: number;
  needsReview: number;
  excluded: number;
  transactionCount: number;
  /* Provenance — how the source sheet ran its own arithmetic */
  sourceHeaderRow: number;
  decreasingColumn: string;
  decreasingHeader: string;
  increasingColumn: string;
  increasingHeader: string;
  balanceFormula: string;
  /** True where the sheet labels the balance-decreasing column 'CREDIT'. */
  headerIsMisleading: boolean;
  verifiedRows: number;
}

export interface Transaction {
  id: string;
  cardId: string;
  entry_type: TxnEntryType;
  status: TxnStatus;
  review_reason?: string;
  description?: string;

  source_sheet?: string;
  source_row?: number;

  txn_date?: string;
  /** The date cell exactly as the workbook holds it. */
  source_date_raw?: string;
  date_repaired?: boolean;
  date_repair_note?: string;

  supplier?: string;
  supplier_country?: string;
  supplier_raw?: string;

  /** Signed against the balance: spend negative, funding positive. */
  amount_aed: number;
  direction?: TxnDirection;
  included_in_source_balance?: boolean;

  currency?: string;
  original_amount?: number;
  /** 'TRY  934000.00' as written in the sheet. */
  currency_raw?: string;
  /** AED per one unit of `currency`, as the sheet computed it. Kept for audit. */
  exchange_rate?: number;
  exchange_rate_formula?: string;
  /**
   * AED settlement divided by the original amount: the rate the transaction
   * actually settled at. Derived, never entered. Use this for reporting; use
   * `exchange_rate` only when showing what the workbook said.
   */
  normalized_exchange_rate?: number;
  /** Visible explanation when the source rate could not be used as-is. */
  rate_review_note?: string;

  occurrence?: number;

  req_number?: string;
  lpo_number?: string;
  invoice?: string;
  payment_ref?: string;
  account?: string;
  crm?: string;
  client?: string;
  sales_operation?: string;
  event_end?: string;
  notes?: string;
}

export interface CurrencySpend {
  cardId: string;
  currency: string;
  count: number;
  /** Total in the original currency. Never added to another currency's total. */
  originalTotal: number;
  aedTotal: number;
}

export interface LedgerData {
  generatedFrom: string;
  cards: Card[];
  transactions: Transaction[];
  spendByCurrency: CurrencySpend[];
}

/** A row awaiting a human decision, with why. */
export interface ReviewItem {
  transaction: Transaction;
  card: Card;
  kind: ReviewKind;
  reason: string;
}

export type ReviewKind =
  | 'currency_unreadable'
  | 'rate_mismatch'
  | 'rate_without_currency'
  | 'rate_hardcoded'
  | 'manual_balance_adjustment'
  | 'excluded_from_source_balance'
  | 'duplicate_candidate'
  | 'other';
