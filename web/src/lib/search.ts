/**
 * Search, filter and sort over transactions.
 *
 * Search is substring-based across every reference field at once, which is what
 * makes compound values work: request numbers in the workbook are written as
 * 'SA 993 | REQ 11973', so typing 'REQ 11973' has to match a row whose field
 * holds more than that. Splitting the value apart would lose the pairing, so
 * the whole string is searched instead.
 */

import type { Card, Transaction, TxnStatus } from './types';

/** Every field a query is matched against, in one string per transaction. */
export function searchHaystack(t: Transaction, cardName: string): string {
  return [
    cardName,
    t.supplier,
    t.supplier_raw,
    t.req_number,
    t.payment_ref,
    t.invoice,
    t.lpo_number,
    t.crm,
    t.client,
    t.sales_operation,
    t.account,
    t.event_end,
    t.currency,
    t.currency_raw,
    t.source_date_raw,
    t.description,
    t.notes,
    t.review_reason,
    t.source_sheet,
    t.source_row != null ? `row ${t.source_row}` : '',
  ]
    .filter(Boolean)
    .join('  ')
    .toLowerCase();
}

/**
 * All whitespace-separated terms must appear somewhere in the haystack. Quoted
 * phrases are matched whole, so "SA 993" can be required as a unit.
 */
export function matchesQuery(haystack: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const terms = q.match(/"[^"]+"|\S+/g) ?? [];
  return terms.every((term) => haystack.includes(term.replace(/^"|"$/g, '')));
}

export type SourceFilter = 'all' | 'imported' | 'manual';

export interface Filters {
  query: string;
  cardIds: string[];
  currencies: string[];
  statuses: TxnStatus[];
  kinds: ('spend' | 'funding' | 'adjustment')[];
  suppliers: string[];
  dateFrom: string;
  dateTo: string;
  source: SourceFilter;
}

export const EMPTY_FILTERS: Filters = {
  query: '',
  cardIds: [],
  currencies: [],
  statuses: [],
  kinds: [],
  suppliers: [],
  dateFrom: '',
  dateTo: '',
  source: 'all',
};

export function isFiltered(f: Filters): boolean {
  return (
    f.query.trim() !== '' ||
    f.cardIds.length > 0 ||
    f.currencies.length > 0 ||
    f.statuses.length > 0 ||
    f.kinds.length > 0 ||
    f.suppliers.length > 0 ||
    f.dateFrom !== '' ||
    f.dateTo !== '' ||
    f.source !== 'all'
  );
}

export function applyFilters(
  transactions: Transaction[],
  cards: Card[],
  f: Filters,
): Transaction[] {
  const cardName = new Map(cards.map((c) => [c.id, c.name]));

  return transactions.filter((t) => {
    if (f.cardIds.length && !f.cardIds.includes(t.cardId)) return false;

    if (f.currencies.length) {
      // 'unknown' selects rows the importer refused to assign a currency to.
      const code = t.currency ?? 'unknown';
      if (!f.currencies.includes(code)) return false;
    }

    if (f.statuses.length && !f.statuses.includes(t.status)) return false;

    if (f.kinds.length) {
      const kind =
        t.entry_type === 'reconciliation_adjustment'
          ? 'adjustment'
          : t.direction ?? 'adjustment';
      if (!f.kinds.includes(kind as 'spend' | 'funding' | 'adjustment')) return false;
    }

    if (f.suppliers.length) {
      if (!t.supplier || !f.suppliers.includes(t.supplier)) return false;
    }

    if (f.dateFrom && (!t.txn_date || t.txn_date < f.dateFrom)) return false;
    if (f.dateTo && (!t.txn_date || t.txn_date > f.dateTo)) return false;

    if (f.source !== 'all') {
      // Everything currently in the ledger came from the workbook; a row with
      // no source sheet was entered by hand.
      const imported = Boolean(t.source_sheet);
      if (f.source === 'imported' && !imported) return false;
      if (f.source === 'manual' && imported) return false;
    }

    if (f.query.trim()) {
      const hay = searchHaystack(t, cardName.get(t.cardId) ?? '');
      if (!matchesQuery(hay, f.query)) return false;
    }

    return true;
  });
}

export type SortKey = 'date' | 'amount' | 'supplier' | 'card' | 'status';
export type SortDir = 'asc' | 'desc';

export function sortTransactions(
  transactions: Transaction[],
  cards: Card[],
  key: SortKey,
  dir: SortDir,
): Transaction[] {
  const cardName = new Map(cards.map((c) => [c.id, c.name]));
  const mul = dir === 'asc' ? 1 : -1;

  const value = (t: Transaction): string | number => {
    switch (key) {
      case 'date':
        return t.txn_date ?? '';
      case 'amount':
        // Sort by magnitude: the question is "how big", not "which direction".
        return Math.abs(t.amount_aed);
      case 'supplier':
        return (t.supplier ?? '').toLowerCase();
      case 'card':
        return (cardName.get(t.cardId) ?? '').toLowerCase();
      case 'status':
        return t.status;
    }
  };

  return [...transactions].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va === vb) {
      // Stable tiebreak so repeat charges keep a fixed order between renders.
      return (a.id > b.id ? 1 : -1) * mul;
    }
    return (va > vb ? 1 : -1) * mul;
  });
}
