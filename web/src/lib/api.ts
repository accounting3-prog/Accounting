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
import { setCurrencies } from './currencies';
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
  /** +1 for a balance that counts money available, -1 for one that counts money drawn. */
  balance_sign: string | number;
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
        balanceSign: Number(b?.balance_sign) === -1 ? -1 : 1,
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
  /** Optional: 577 of the workbook's own rows carry none. Null, never ''. */
  p_payment_ref: string | null;
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
  /** Why, in the caller's words. Defaults to the manual-entry sentence. */
  p_review_reason?: string | null;
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
  /** An owner also manages access and reads the history. */
  is_owner: boolean;
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
  asOwner = false,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!supabase) return { ok: false, error: 'Not connected to Supabase.' };
  const { error } = await supabase.rpc('grant_admin', {
    p_email: email,
    p_rationale: rationale || null,
    p_as_owner: asOwner,
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

/* -------------------------------------------------- history and the checks */

export interface ActivityRow {
  created_at: string;
  area: 'transaction' | 'card' | 'access';
  action: string;
  actor: string;
  card_name: string | null;
  transaction_id: string | null;
  subject: string;
  amount_aed: string | number | null;
  txn_date: string | null;
  rationale: string;
  note: string | null;
  changes: Record<string, { from?: unknown; to?: unknown } | unknown> | null;
  from_status: string | null;
  to_status: string | null;
}

/**
 * Everything that has been done, newest first.
 *
 * Reading this needs an admin session — the view is subject to the reader's own
 * policies, and the history was narrowed to admins deliberately. A viewer who
 * can read the ledger gets a refusal here, which is the intended answer and is
 * reported as such rather than as a failure.
 */
export async function listActivity(
  limit = 400,
): Promise<{ ok: true; rows: ActivityRow[] } | { ok: false; error: string }> {
  if (!supabase) return { ok: false, error: 'Not connected to Supabase.' };
  const { data, error } = await supabase
    .from('activity_log')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return { ok: false, error: error.message };
  return { ok: true, rows: (data ?? []) as ActivityRow[] };
}

/** The history of one transaction, oldest first — how it came to say what it says. */
export async function listTransactionHistory(
  transactionId: string,
): Promise<{ ok: true; rows: ActivityRow[] } | { ok: false; error: string }> {
  if (!supabase) return { ok: false, error: 'Not connected to Supabase.' };
  const { data, error } = await supabase
    .from('activity_log')
    .select('*')
    .eq('transaction_id', transactionId)
    .order('created_at', { ascending: true });
  if (error) return { ok: false, error: error.message };
  return { ok: true, rows: (data ?? []) as ActivityRow[] };
}

export interface DuplicateGroup {
  card_id: string;
  card_name: string;
  txn_date_text: string;
  amount_aed: string | number;
  supplier: string;
  payment_ref: string;
  copies: number;
  transaction_ids: string[];
  source_rows: number[];
  distinct_sources: number;
  amount_at_risk: string | number;
  entered_separately: boolean;
}

export interface SuspectAmount {
  transaction_id: string;
  card_name: string;
  txn_date: string;
  supplier: string;
  amount_aed: string | number;
  compare_with_id: string;
  compare_with_date: string;
  compare_with_amount: string | number;
  factor: number;
  same_day: boolean;
  days_apart: number;
  currency: string | null;
  source_sheet: string | null;
  source_row: number | null;
}

export interface SuspectRate {
  transaction_id: string;
  card_name: string;
  txn_date: string;
  supplier: string;
  currency: string;
  original_amount: string | number;
  amount_aed: string | number;
  settled_rate: string | number;
  usual_rate: string | number;
  times_usual: string | number;
  comparable_rows: number;
}

export interface ChecksResult {
  duplicates: DuplicateGroup[];
  amounts: SuspectAmount[];
  rates: SuspectRate[];
}

/** The three standing checks, run on read. Nothing here changes anything. */
export async function listChecks(): Promise<
  { ok: true; checks: ChecksResult } | { ok: false; error: string }
> {
  if (!supabase) return { ok: false, error: 'Not connected to Supabase.' };
  const [dup, amt, rate] = await Promise.all([
    supabase.from('possible_duplicates').select('*').order('amount_at_risk', { ascending: false }),
    supabase.from('suspect_amounts').select('*'),
    supabase.from('suspect_rates').select('*'),
  ]);
  const failed = [dup.error, amt.error, rate.error].find(Boolean);
  if (failed) return { ok: false, error: failed.message };
  return {
    ok: true,
    checks: {
      duplicates: (dup.data ?? []) as DuplicateGroup[],
      amounts: (amt.data ?? []) as SuspectAmount[],
      rates: (rate.data ?? []) as SuspectRate[],
    },
  };
}

/* --------------------------------------------------------- what I am allowed */

export interface MyAccess {
  /** Adds, edits, imports, resolves, adds cards. */
  canWrite: boolean;
  /** Manages access and reads the history. A strict subset of canWrite. */
  canManage: boolean;
  email: string | null;
}

/**
 * What this account may do, asked once when the ledger loads.
 *
 * Used only to decide what is worth drawing. Every restriction it describes is
 * enforced in the database by row-level security and by the functions
 * themselves, so hiding a screen is a courtesy, never the protection — an
 * editor who navigates straight to /access gets a refusal from Postgres, not
 * from this flag.
 */
export async function getMyAccess(): Promise<MyAccess> {
  if (!supabase) return { canWrite: false, canManage: false, email: null };
  const { data, error } = await supabase.rpc('my_access');
  if (error) return { canWrite: false, canManage: false, email: null };
  const row = Array.isArray(data) ? data[0] : data;
  return {
    canWrite: Boolean(row?.can_write),
    canManage: Boolean(row?.can_manage),
    email: (row?.email as string | null) ?? null,
  };
}

/**
 * This card's balance, read now.
 *
 * The blank sheet writes a balance into a file that then leaves the app and is
 * treated as the truth by whoever fills it in. A figure taken from a page that
 * has been open since breakfast is not good enough for that, so the number is
 * fetched at the moment the file is built, and the download is refused rather
 * than written with a figure that could not be confirmed.
 */
export async function getCardBalanceNow(
  cardId: string,
): Promise<{ ok: true; ledgerBalance: number } | { ok: false; error: string }> {
  if (!supabase) return { ok: false, error: 'Not connected to Supabase.' };
  const { data, error } = await supabase
    .from('card_balances')
    .select('ledger_balance')
    .eq('card_id', cardId)
    .single();
  if (error) return { ok: false, error: error.message };
  const value = Number(data?.ledger_balance);
  if (!Number.isFinite(value))
    return { ok: false, error: 'The database returned no balance for this card.' };
  return { ok: true, ledgerBalance: value };
}


/* ------------------------------------------------- recording what an import did */

export interface LeftOutRow {
  source_row: number;
  supplier: string;
  amount: number | null;
  /** refused by the database, stopped by the parser, or unticked by hand. */
  kind: 'refused' | 'stopped' | 'unticked';
  detail: string;
}

/**
 * Opens a record of this import before anything is written.
 *
 * A file of 36 rows once produced 31 transactions and no way to find out what
 * happened to the other five. The screen said so while it was on screen; the
 * database said nothing at all. This is the database saying it.
 */
export async function beginImportBatch(
  source: string,
  rowCount: number,
): Promise<string | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc('begin_import_batch', {
    p_source: source,
    p_row_count: rowCount,
  });
  if (error) return null;
  return typeof data === 'string' ? data : null;
}

/** Closes it, listing every row of the file the ledger did not take. */
export async function finishImportBatch(
  batchId: string,
  inserted: number,
  leftOut: LeftOutRow[],
  cardName: string,
): Promise<void> {
  if (!supabase) return;
  await supabase.rpc('finish_import_batch', {
    p_batch_id: batchId,
    p_inserted: inserted,
    p_left_out: leftOut,
    p_card_name: cardName,
  });
}

export interface ImportHistoryRow {
  batch_id: string;
  source: string;
  created_at: string;
  imported_by: string;
  rows_in_file: number;
  imported: number;
  left_out: number;
  left_out_rows: { source_row: number | null; kind: string; detail: string }[];
}

export async function listImportHistory(): Promise<
  { ok: true; rows: ImportHistoryRow[] } | { ok: false; error: string }
> {
  if (!supabase) return { ok: false, error: 'Not connected to Supabase.' };
  const { data, error } = await supabase
    .from('import_history')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return { ok: false, error: error.message };
  return { ok: true, rows: (data ?? []) as ImportHistoryRow[] };
}


/**
 * The currency list, from the database.
 *
 * Loaded with the ledger rather than written into the app, so adding a currency
 * never needs a deploy and the two lists cannot disagree. A failure here leaves
 * the built-in fallback in place; setCurrencies refuses an empty list.
 */
export async function loadCurrencies(): Promise<number> {
  if (!supabase) return 0;
  const { data, error } = await supabase
    .from('currencies')
    .select('code, name, minor_units')
    .order('code');
  if (error || !data) return 0;
  setCurrencies(data as { code: string; name: string; minor_units: number }[]);
  return data.length;
}
