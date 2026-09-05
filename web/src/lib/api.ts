/**
 * Reads the ledger from Supabase, falling back to the audited sample extract.
 *
 * Only the publishable key is used, so every read here is subject to Row Level
 * Security exactly as it is for any other signed-in user. Writes do not happen
 * through this module at all: manual entry calls the `create_transaction`
 * function, which re-applies the ledger's rules in the database.
 *
 * The fallback exists so the app is reviewable with no backend configured. It
 * is never silently substituted for a failed live read — a connection error or
 * a permission denial is surfaced as itself.
 */

import { supabase, isSupabaseConfigured } from './supabase';
import type { Card, CurrencySpend, LedgerData, Transaction } from './types';

export type LedgerSource = 'supabase' | 'sample';

export type LoadFailure =
  | { kind: 'permission_denied'; message: string }
  | { kind: 'connection_error'; message: string }
  | { kind: 'unknown'; message: string };

export interface LoadResult {
  data: LedgerData;
  source: LedgerSource;
  /** Set when a live read was attempted and failed. */
  failure?: LoadFailure;
}

/**
 * The audited extract, ~1.2 MB, loaded only when it is actually going to be
 * shown — a signed-out visitor, or a live read that failed. A signed-in user
 * reading live data never downloads it at all, which is the common case.
 */
let sampleCache: LedgerData | null = null;

async function loadSample(): Promise<LedgerData> {
  if (!sampleCache) {
    const mod = await import('../data/ledger-sample.json');
    sampleCache = (mod.default ?? mod) as unknown as LedgerData;
  }
  return sampleCache;
}

/** Supabase rows arrive with the database's own column names. */
interface CardRow {
  id: string; name: string; settlement_currency: string;
  opening_balance: string | number; opening_date: string | null;
  source_header_row: number | null; decreasing_column: string | null;
  decreasing_header: string | null; increasing_column: string | null;
  increasing_header: string | null; balance_formula: string | null;
}

interface BalanceRow {
  card_id: string; source_balance: string | number; ledger_balance: string | number;
  reconciliation_difference: string | number; total_spend: string | number;
  total_funding: string | number; review_adjustments_total: string | number;
  needs_review_count: string | number; excluded_count: string | number;
  transaction_count: string | number; last_transaction: string | null;
  first_transaction: string | null;
}

const num = (v: string | number | null | undefined): number =>
  v === null || v === undefined ? 0 : typeof v === 'number' ? v : Number(v);

function classify(error: { code?: string; message: string }): LoadFailure {
  // PostgREST returns 42501 for an RLS refusal and PGRST301 for a missing or
  // expired token. Both mean "you are not allowed", not "the server is down".
  if (
    error.code === '42501' ||
    error.code === 'PGRST301' ||
    /permission denied|jwt|not authorized/i.test(error.message)
  )
    return { kind: 'permission_denied', message: error.message };
  if (/fetch|network|failed to fetch|timeout|ENOTFOUND/i.test(error.message))
    return { kind: 'connection_error', message: error.message };
  return { kind: 'unknown', message: error.message };
}

/**
 * @param signedIn whether a session exists. Row Level Security grants reads to
 *   `authenticated` only, so a signed-out request succeeds and returns an empty
 *   array rather than failing. Reading that as "the ledger is empty" would be
 *   wrong and alarming, so the live read is not attempted at all without a
 *   session and the audited sample is returned instead, clearly labelled.
 */
export async function loadLedger(
  { signedIn = false }: { signedIn?: boolean } = {},
): Promise<LoadResult> {
  if (!isSupabaseConfigured || !supabase || !signedIn) {
    return { data: await loadSample(), source: 'sample' };
  }

  try {
    const [cardsRes, balancesRes, spendRes] = await Promise.all([
      supabase.from('cards').select('*').order('name'),
      supabase.from('card_balances').select('*'),
      // Per-currency spend is aggregated in the database over every row. It was
      // previously summed in the browser from whatever transactions had been
      // fetched, which silently under-reported once there were more rows than
      // one page.
      supabase.from('card_spend_by_currency').select('*'),
    ]);

    // PostgREST answers at most 1,000 rows per request whatever limit is asked
    // for, so a single call cannot return the ledger and never could. Pages are
    // fetched until the server says there are no more; `range` is explicit
    // rather than relying on a limit the server is free to ignore.
    const PAGE = 1000;
    const HARD_CAP = 100_000; // a runaway guard, not an expected ceiling
    const txnRows: Record<string, unknown>[] = [];
    let truncated = false;
    for (let from = 0; from < HARD_CAP; from += PAGE) {
      const page = await supabase
        .from('transactions')
        .select('*')
        .order('txn_date', { ascending: false })
        .order('id', { ascending: true }) // stable across pages
        .range(from, from + PAGE - 1);
      if (page.error) {
        return { data: await loadSample(), source: 'sample', failure: classify(page.error) };
      }
      txnRows.push(...(page.data as Record<string, unknown>[]));
      if (!page.data || page.data.length < PAGE) break;
      if (from + PAGE >= HARD_CAP) truncated = true;
    }

    const txnRes = { data: txnRows, error: null };
    const firstError = cardsRes.error ?? balancesRes.error ?? spendRes.error;
    if (firstError) {
      return { data: await loadSample(), source: 'sample', failure: classify(firstError) };
    }
    if (truncated) {
      // Never silently. A partial ledger that looks complete is the failure
      // this whole system exists to prevent.
      return {
        data: await loadSample(),
        source: 'sample',
        failure: {
          kind: 'unknown',
          message:
            `The ledger holds more than ${HARD_CAP.toLocaleString()} transactions, ` +
            'which this page cannot load in full. Showing the sample rather than a ' +
            'partial ledger. Server-side paging is needed.',
        },
      };
    }

    const balances = new Map<string, BalanceRow>(
      (balancesRes.data as BalanceRow[]).map((b) => [b.card_id, b]),
    );

    const cards: Card[] = (cardsRes.data as CardRow[]).map((c) => {
      const b = balances.get(c.id);
      return {
        id: c.id,
        name: c.name,
        settlementCurrency: c.settlement_currency,
        openingBalance: num(c.opening_balance),
        openingDate: c.opening_date,
        lastTransaction: b?.last_transaction ?? null,
        sourceBalance: num(b?.source_balance),
        ledgerBalance: num(b?.ledger_balance),
        reconciliationDifference: num(b?.reconciliation_difference),
        totalSpend: num(b?.total_spend),
        totalFunding: num(b?.total_funding),
        reviewAdjustmentsTotal: num(b?.review_adjustments_total),
        needsReview: num(b?.needs_review_count),
        excluded: num(b?.excluded_count),
        transactionCount: num(b?.transaction_count),
        sourceHeaderRow: c.source_header_row ?? 1,
        decreasingColumn: c.decreasing_column ?? '',
        decreasingHeader: c.decreasing_header ?? '',
        increasingColumn: c.increasing_column ?? '',
        increasingHeader: c.increasing_header ?? '',
        balanceFormula: c.balance_formula ?? '',
        headerIsMisleading: /credit/i.test(c.decreasing_header ?? ''),
        verifiedRows: num(b?.transaction_count),
      };
    });

    const transactions: Transaction[] = (
      txnRes.data as Record<string, unknown>[]
    ).map((t) => ({
      id: String(t.id),
      cardId: String(t.card_id),
      entry_type: t.entry_type as Transaction['entry_type'],
      status: t.status as Transaction['status'],
      review_reason: (t.review_reason as string) ?? undefined,
      description: (t.description as string) ?? undefined,
      source_sheet: (t.source_sheet as string) ?? undefined,
      source_row: (t.source_row as number) ?? undefined,
      txn_date: (t.txn_date as string) ?? undefined,
      source_date_raw: (t.source_date_raw as string) ?? undefined,
      date_repaired: Boolean(t.date_repaired),
      date_repair_note: (t.date_repair_note as string) ?? undefined,
      supplier: ((t.supplier_raw as string) ?? '').replace(/\s\d{3}\s*$/, '') || undefined,
      supplier_raw: (t.supplier_raw as string) ?? undefined,
      supplier_country:
        ((t.supplier_raw as string) ?? '').match(/\s(\d{3})\s*$/)?.[1] ?? undefined,
      amount_aed: num(t.amount_aed as string),
      direction: (t.direction as Transaction['direction']) ?? undefined,
      included_in_source_balance: t.included_in_source_balance !== false,
      currency: (t.currency as string) ?? undefined,
      original_amount:
        t.original_amount === null ? undefined : num(t.original_amount as string),
      currency_raw: (t.currency_raw as string) ?? undefined,
      exchange_rate:
        t.exchange_rate === null ? undefined : num(t.exchange_rate as string),
      exchange_rate_formula: (t.exchange_rate_formula as string) ?? undefined,
      normalized_exchange_rate:
        t.normalized_exchange_rate === null
          ? undefined
          : num(t.normalized_exchange_rate as string),
      rate_review_note: (t.rate_review_note as string) ?? undefined,
      occurrence: (t.occurrence as number) ?? 1,
      req_number: (t.req_number as string) ?? undefined,
      lpo_number: (t.lpo_number as string) ?? undefined,
      invoice: (t.invoice as string) ?? undefined,
      payment_ref: (t.payment_ref as string) ?? undefined,
      account: (t.account as string) ?? undefined,
      crm: (t.crm as string) ?? undefined,
      client: (t.client as string) ?? undefined,
      sales_operation: (t.sales_operation as string) ?? undefined,
      event_end: (t.event_end as string) ?? undefined,
      notes: (t.notes as string) ?? undefined,
    }));

    // Straight from the database view, which aggregates over every row and
    // keeps one line per currency with no cross-currency total.
    const spendByCurrency: CurrencySpend[] = (
      spendRes.data as Record<string, unknown>[]
    )
      .map((s) => ({
        cardId: String(s.card_id),
        currency: String(s.currency),
        count: num(s.transaction_count as string),
        originalTotal: num(s.total_original_amount as string),
        aedTotal: num(s.total_settled_aed as string),
      }))
      .sort((a, b) => b.count - a.count);

    return {
      data: { generatedFrom: 'Supabase', cards, transactions, spendByCurrency },
      source: 'supabase',
    };
  } catch (e) {
    return {
      data: await loadSample(),
      source: 'sample',
      failure: classify({ message: e instanceof Error ? e.message : String(e) }),
    };
  }
}

/* ------------------------------------------------------------------ writes */

export interface NewTransaction {
  p_card_id: string;
  p_txn_date: string;
  p_kind: string;
  p_amount_aed: number;
  p_supplier: string;
  p_req_number: string;
  p_payment_ref: string;
  p_currency?: string | null;
  p_original_amount?: number | null;
  p_exchange_rate?: number | null;
  p_supplier_country?: string | null;
  p_crm?: string | null;
  p_lpo_number?: string | null;
  p_invoice?: string | null;
  p_client?: string | null;
  p_sales_operation?: string | null;
  p_description?: string | null;
  p_notes?: string | null;
  p_needs_review?: boolean;
  /**
   * Lets a row through the two-minute duplicate guard. Only set where the
   * duplicate was shown to a person and they said to import it anyway — the
   * workbook holds 217 genuine repeat charges, so identical rows are real.
   */
  p_allow_duplicate?: boolean;
}

/**
 * The only write path. Calls the database function, which re-derives the sign
 * from the transaction kind, recomputes the dedup key, and refuses any caller
 * who is not a named admin. The client never inserts into `transactions`.
 */
/* ------------------------------------------------------------------ access */

export interface AppUser {
  user_id: string;
  email: string;
  is_admin: boolean;
  created_at: string;
  last_sign_in: string | null;
}

export interface AccessAuditRow {
  id: string;
  action: 'granted' | 'revoked';
  target_email: string;
  performed_by_email: string | null;
  rationale: string | null;
  created_at: string;
}

/** Everyone who has signed in. Admin-only, enforced in the database. */
export async function listAppUsers(): Promise<
  { ok: true; users: AppUser[] } | { ok: false; error: string }
> {
  if (!supabase) return { ok: false, error: 'Not connected to Supabase.' };
  const { data, error } = await supabase.rpc('list_app_users');
  if (error) return { ok: false, error: error.message };
  return { ok: true, users: (data ?? []) as AppUser[] };
}

export async function listAccessAudit(): Promise<
  { ok: true; rows: AccessAuditRow[] } | { ok: false; error: string }
> {
  if (!supabase) return { ok: false, error: 'Not connected to Supabase.' };
  const { data, error } = await supabase
    .from('admin_audit')
    .select('id, action, target_email, performed_by_email, rationale, created_at')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return { ok: false, error: error.message };
  return { ok: true, rows: (data ?? []) as AccessAuditRow[] };
}

export async function grantAdmin(
  email: string,
  rationale: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!supabase) return { ok: false, error: 'Not connected to Supabase.' };
  const { error } = await supabase.rpc('grant_admin', {
    p_email: email,
    p_rationale: rationale || null,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function revokeAdmin(
  userId: string,
  rationale: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!supabase) return { ok: false, error: 'Not connected to Supabase.' };
  const { error } = await supabase.rpc('revoke_admin', {
    p_user_id: userId,
    p_rationale: rationale || null,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export interface TransactionEdit {
  p_id: string;
  p_rationale: string;
  p_txn_date?: string | null;
  p_amount_aed?: number | null;
  p_kind?: string | null;
  p_supplier?: string | null;
  p_supplier_country?: string | null;
  p_req_number?: string | null;
  p_payment_ref?: string | null;
  p_currency?: string | null;
  p_original_amount?: number | null;
  p_exchange_rate?: number | null;
  p_crm?: string | null;
  p_lpo_number?: string | null;
  p_invoice?: string | null;
  p_client?: string | null;
  p_sales_operation?: string | null;
  p_description?: string | null;
  p_notes?: string | null;
  p_clear_currency?: boolean;
}

/**
 * Edits a transaction through the database function, which requires a reason,
 * records every field's before and after, and cannot touch the columns that
 * trace a figure back to the source workbook.
 */
export async function updateTransaction(
  edit: TransactionEdit,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!supabase) return { ok: false, error: 'Not connected to Supabase.' };
  const { error } = await supabase.rpc('update_transaction', edit);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export type ResolveAction = 'confirm' | 'void' | 'leave_pending' | 'reopen';

/**
 * Resolves a review item through the database function, which requires a
 * stated reason, records the decision in transaction_corrections, refuses any
 * caller who is not a named admin, and never deletes the row.
 */
export async function resolveReviewItem(
  transactionId: string,
  action: ResolveAction,
  rationale: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!supabase) {
    return {
      ok: false,
      error: 'Not connected to Supabase. Resolving is unavailable in sample mode.',
    };
  }
  const { error } = await supabase.rpc('resolve_review_item', {
    p_transaction_id: transactionId,
    p_action: action,
    p_rationale: rationale,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export interface NewCard {
  p_name: string;
  p_opening_balance: number;
  p_opening_date: string;
  p_card_type: string;
  p_status: string;
  p_settlement_currency: string;
  p_bank_issuer?: string | null;
  p_account_reference?: string | null;
  p_credit_limit?: number | null;
  p_notes?: string | null;
}

/**
 * Creates a card through the database function, which enforces the unique name,
 * the required opening date and admin-only access, and writes the immutable
 * card_audit row. The client never inserts into `cards`.
 */
export async function createCard(
  input: NewCard,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (!supabase) {
    return {
      ok: false,
      error: 'Not connected to Supabase. Creating a card is unavailable in sample mode.',
    };
  }
  const { data, error } = await supabase.rpc('create_card', input);
  if (error) return { ok: false, error: error.message };
  return { ok: true, id: String(data) };
}

export async function submitTransaction(
  input: NewTransaction,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (!supabase) {
    return {
      ok: false,
      error: 'Not connected to Supabase. Saving is unavailable in sample mode.',
    };
  }
  const { data, error } = await supabase.rpc('create_transaction', input);
  if (error) return { ok: false, error: error.message };
  return { ok: true, id: String(data) };
}
