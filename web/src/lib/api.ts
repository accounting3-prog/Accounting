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
import sample from '../data/ledger-sample.json';
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

const SAMPLE = sample as unknown as LedgerData;

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
    return { data: SAMPLE, source: 'sample' };
  }

  try {
    const [cardsRes, balancesRes, txnRes] = await Promise.all([
      supabase.from('cards').select('*').order('name'),
      supabase.from('card_balances').select('*'),
      supabase
        .from('transactions')
        .select('*')
        .order('txn_date', { ascending: false })
        .limit(5000),
    ]);

    const firstError = cardsRes.error ?? balancesRes.error ?? txnRes.error;
    if (firstError) {
      return { data: SAMPLE, source: 'sample', failure: classify(firstError) };
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

    // Per (card, currency), never summed across currencies.
    const buckets = new Map<string, CurrencySpend>();
    for (const t of transactions) {
      if (t.direction !== 'spend' || !t.currency) continue;
      const k = `${t.cardId}|${t.currency}`;
      const b = buckets.get(k);
      if (b) {
        b.count += 1;
        b.originalTotal += t.original_amount ?? 0;
        b.aedTotal += t.amount_aed;
      } else {
        buckets.set(k, {
          cardId: t.cardId,
          currency: t.currency,
          count: 1,
          originalTotal: t.original_amount ?? 0,
          aedTotal: t.amount_aed,
        });
      }
    }

    return {
      data: {
        generatedFrom: 'Supabase',
        cards,
        transactions,
        spendByCurrency: [...buckets.values()].sort((a, b) => b.count - a.count),
      },
      source: 'supabase',
    };
  } catch (e) {
    return {
      data: SAMPLE,
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
}

/**
 * The only write path. Calls the database function, which re-derives the sign
 * from the transaction kind, recomputes the dedup key, and refuses any caller
 * who is not a named admin. The client never inserts into `transactions`.
 */
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
