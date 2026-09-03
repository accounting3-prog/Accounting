import { useMemo, useState } from 'react';
import { Page } from '../components/Layout';
import { TransactionDrawer } from '../components/TransactionDrawer';
import {
  Button,
  EmptyState,
  Money,
  Panel,
  StatusPill,
  Tag,
  fieldClass,
  labelClass,
} from '../components/ui';
import { formatCount, formatDateShort, formatRate } from '../lib/format';
import { getCards, getTransactions } from '../lib/ledger';
import {
  EMPTY_FILTERS,
  applyFilters,
  isFiltered,
  sortTransactions,
  type Filters,
  type SortDir,
  type SortKey,
} from '../lib/search';
import type { Transaction, TxnStatus } from '../lib/types';

const PAGE_SIZE = 50;

const STATUS_OPTIONS: { value: TxnStatus; label: string }[] = [
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'needs_review', label: 'Needs review' },
  { value: 'excluded_from_source_balance', label: 'Excluded from source' },
  { value: 'voided', label: 'Voided' },
];

const KIND_OPTIONS = [
  { value: 'spend', label: 'Spend' },
  { value: 'funding', label: 'Funding' },
  { value: 'adjustment', label: 'Adjustment' },
] as const;

function SortHeader({
  label,
  sortKey,
  active,
  dir,
  onSort,
  align = 'left',
}: {
  label: string;
  sortKey: SortKey;
  active: boolean;
  dir: SortDir;
  onSort: (k: SortKey) => void;
  align?: 'left' | 'right';
}) {
  return (
    <th className={`px-3 py-2 font-medium ${align === 'right' ? 'text-right' : 'text-left'}`}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 hover:text-ink ${
          active ? 'text-ink' : ''
        }`}
      >
        {label}
        <span aria-hidden className={active ? 'opacity-100' : 'opacity-0'}>
          {dir === 'asc' ? '↑' : '↓'}
        </span>
      </button>
    </th>
  );
}

export function Transactions() {
  const cards = getCards();
  const all = getTransactions();

  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [selected, setSelected] = useState<Transaction | null>(null);
  const [showFilters, setShowFilters] = useState(false);

  const currencyOptions = useMemo(() => {
    const set = new Set<string>();
    for (const t of all) set.add(t.currency ?? 'unknown');
    return [...set].sort();
  }, [all]);

  const results = useMemo(() => {
    const filtered = applyFilters(all, cards, filters);
    return sortTransactions(filtered, cards, sortKey, sortDir);
  }, [all, cards, filters, sortKey, sortDir]);

  const shown = results.slice(0, visible);

  const update = (patch: Partial<Filters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setVisible(PAGE_SIZE);
  };

  const onSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir(key === 'date' || key === 'amount' ? 'desc' : 'asc');
    }
  };

  const toggle = <T extends string>(list: T[], value: T): T[] =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  return (
    <Page
      title="Transactions"
      description="Search matches anywhere in any reference field, so a request number finds its row even inside a compound value such as “SA 993 | REQ 11973”."
    >
      {/* Search + controls */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="min-w-[240px] flex-1">
          <input
            type="search"
            value={filters.query}
            onChange={(e) => update({ query: e.target.value })}
            placeholder="Search supplier, request number, payment reference, card, invoice, LPO, CRM, client…"
            className={fieldClass}
            aria-label="Search transactions"
          />
        </div>
        <Button
          variant={showFilters ? 'primary' : 'secondary'}
          onClick={() => setShowFilters((v) => !v)}
        >
          Filters
        </Button>
        {isFiltered(filters) && (
          <Button variant="ghost" onClick={() => setFilters(EMPTY_FILTERS)}>
            Clear
          </Button>
        )}
        <div className="tnum text-[13px] text-ink-muted">
          {formatCount(results.length)}
          {results.length !== all.length && (
            <span className="text-ink-faint"> of {formatCount(all.length)}</span>
          )}{' '}
          rows
        </div>
      </div>

      {showFilters && (
        <div className="mb-4 rounded-md border border-line bg-surface px-4 py-3.5">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <div>
              <span className={labelClass}>Card</span>
              <div className="mt-1.5 space-y-1">
                {cards.map((c) => (
                  <label key={c.id} className="flex items-center gap-2 text-[13px]">
                    <input
                      type="checkbox"
                      checked={filters.cardIds.includes(c.id)}
                      onChange={() => update({ cardIds: toggle(filters.cardIds, c.id) })}
                      className="accent-[#1f4a73]"
                    />
                    <span className="truncate">{c.name}</span>
                  </label>
                ))}
              </div>
            </div>

            <div>
              <span className={labelClass}>Date range</span>
              <div className="mt-1.5 space-y-1.5">
                <input
                  type="date"
                  value={filters.dateFrom}
                  onChange={(e) => update({ dateFrom: e.target.value })}
                  className={fieldClass}
                  aria-label="From date"
                />
                <input
                  type="date"
                  value={filters.dateTo}
                  onChange={(e) => update({ dateTo: e.target.value })}
                  className={fieldClass}
                  aria-label="To date"
                />
              </div>

              <span className={`${labelClass} mt-3 block`}>Source</span>
              <select
                value={filters.source}
                onChange={(e) => update({ source: e.target.value as Filters['source'] })}
                className={`${fieldClass} mt-1.5`}
              >
                <option value="all">All</option>
                <option value="imported">Imported from workbook</option>
                <option value="manual">Entered manually</option>
              </select>
            </div>

            <div>
              <span className={labelClass}>Status</span>
              <div className="mt-1.5 space-y-1">
                {STATUS_OPTIONS.map((s) => (
                  <label key={s.value} className="flex items-center gap-2 text-[13px]">
                    <input
                      type="checkbox"
                      checked={filters.statuses.includes(s.value)}
                      onChange={() => update({ statuses: toggle(filters.statuses, s.value) })}
                      className="accent-[#1f4a73]"
                    />
                    {s.label}
                  </label>
                ))}
              </div>

              <span className={`${labelClass} mt-3 block`}>Type</span>
              <div className="mt-1.5 space-y-1">
                {KIND_OPTIONS.map((k) => (
                  <label key={k.value} className="flex items-center gap-2 text-[13px]">
                    <input
                      type="checkbox"
                      checked={filters.kinds.includes(k.value)}
                      onChange={() => update({ kinds: toggle(filters.kinds, k.value) })}
                      className="accent-[#1f4a73]"
                    />
                    {k.label}
                  </label>
                ))}
              </div>
            </div>

            <div>
              <span className={labelClass}>Currency</span>
              <div className="mt-1.5 flex max-h-52 flex-wrap gap-1 overflow-y-auto">
                {currencyOptions.map((code) => {
                  const on = filters.currencies.includes(code);
                  return (
                    <button
                      key={code}
                      type="button"
                      onClick={() => update({ currencies: toggle(filters.currencies, code) })}
                      className={`rounded-sm border px-1.5 py-0.5 text-[11px] font-medium ${
                        on
                          ? 'border-accent bg-accent-soft text-accent'
                          : 'border-line bg-surface text-ink-muted hover:bg-sunken'
                      }`}
                    >
                      {code === 'unknown' ? 'Unknown' : code}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      <Panel>
        {results.length === 0 ? (
          <EmptyState
            title={isFiltered(filters) ? 'No transactions match these filters' : 'No transactions'}
            description={
              isFiltered(filters)
                ? 'Try a shorter search term, or clear one of the filters.'
                : 'Import the workbook or add a transaction to begin.'
            }
            action={
              isFiltered(filters) ? (
                <Button onClick={() => setFilters(EMPTY_FILTERS)}>Clear filters</Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <div className="scroll-x">
              <table className="w-full min-w-[1080px] border-collapse text-[13px]">
                <thead>
                  <tr className="border-b border-line text-[11px] uppercase tracking-wide text-ink-faint">
                    <SortHeader label="Date" sortKey="date" active={sortKey === 'date'} dir={sortDir} onSort={onSort} />
                    <SortHeader label="Supplier" sortKey="supplier" active={sortKey === 'supplier'} dir={sortDir} onSort={onSort} />
                    <SortHeader label="Card" sortKey="card" active={sortKey === 'card'} dir={sortDir} onSort={onSort} />
                    <th className="px-3 py-2 text-right font-medium">Original</th>
                    <SortHeader label="AED" sortKey="amount" active={sortKey === 'amount'} dir={sortDir} onSort={onSort} align="right" />
                    <th className="px-3 py-2 text-left font-medium">Type</th>
                    <th className="px-3 py-2 text-left font-medium">Request no.</th>
                    <th className="px-3 py-2 text-left font-medium">Payment ref.</th>
                    <SortHeader label="Status" sortKey="status" active={sortKey === 'status'} dir={sortDir} onSort={onSort} />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((t) => {
                    const card = cards.find((c) => c.id === t.cardId);
                    const foreign = t.currency && t.currency !== 'AED';
                    return (
                      <tr
                        key={t.id}
                        onClick={() => setSelected(t)}
                        className="cursor-pointer border-b border-line last:border-0 hover:bg-canvas"
                      >
                        <td className="whitespace-nowrap px-3 py-2 text-ink-muted">
                          {formatDateShort(t.txn_date)}
                          {t.date_repaired && (
                            <span title="Date repaired on import" className="ml-1 text-review">
                              ✳
                            </span>
                          )}
                        </td>
                        <td className="max-w-[220px] px-3 py-2">
                          <div className="truncate font-medium text-ink">
                            {t.supplier ?? t.description ?? '—'}
                          </div>
                        </td>
                        <td className="max-w-[170px] truncate px-3 py-2 text-ink-muted">
                          {card?.name}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-right">
                          {foreign && t.original_amount != null ? (
                            <>
                              <Money
                                amount={t.original_amount}
                                currency={t.currency!}
                                code={false}
                              />
                              <span className="ml-1 text-xs text-ink-faint">{t.currency}</span>
                              {t.exchange_rate != null && (
                                <div className="tnum text-[11px] text-ink-faint">
                                  @ {formatRate(t.exchange_rate)}
                                </div>
                              )}
                            </>
                          ) : !t.currency ? (
                            <span className="text-xs text-review">Unknown</span>
                          ) : (
                            <span className="text-ink-faint">—</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-right font-medium">
                          <Money amount={t.amount_aed} signed tone="ledger" code={false} />
                        </td>
                        <td className="px-3 py-2">
                          {t.entry_type === 'reconciliation_adjustment' ? (
                            <Tag tone="review">Adjustment</Tag>
                          ) : (
                            <span className="text-ink-muted">
                              {t.direction === 'spend' ? 'Spend' : 'Funding'}
                            </span>
                          )}
                        </td>
                        <td className="max-w-[160px] truncate px-3 py-2 text-ink-muted">
                          {t.req_number ?? '—'}
                        </td>
                        <td className="max-w-[160px] truncate px-3 py-2 text-ink-muted">
                          {t.payment_ref ?? '—'}
                        </td>
                        <td className="px-3 py-2">
                          <StatusPill status={t.status} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {visible < results.length && (
              <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3">
                <span className="text-xs text-ink-muted">
                  Showing {formatCount(shown.length)} of {formatCount(results.length)}
                </span>
                <Button onClick={() => setVisible((v) => v + PAGE_SIZE * 4)}>
                  Show more
                </Button>
              </div>
            )}
          </>
        )}
      </Panel>

      <TransactionDrawer
        transaction={selected}
        card={cards.find((c) => c.id === selected?.cardId)}
        onClose={() => setSelected(null)}
      />
    </Page>
  );
}
