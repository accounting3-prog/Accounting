/**
 * Importing a sheet of new transactions.
 *
 * The shape of the page follows the shape of the risk. Reading a file is easy;
 * the hard part is being sure that what gets written is what the file meant. So
 * every decision the parser made is shown before anything is saved — which
 * column decreases the balance, how the dates were read, which rows look like
 * they are already in the ledger — and every one of them can be overridden.
 *
 * Writing goes one row at a time through create_transaction, the same function
 * the single-entry form uses. There is no bulk-insert path: the database
 * re-derives the sign, recomputes the dedup key and records the audit entry for
 * each row, and an import that skipped that would be a second, weaker way in.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { Page } from '../components/Layout';
import { useLedgerState } from '../components/LedgerProvider';
import {
  Button,
  EmptyState,
  Field,
  Money,
  Notice,
  Panel,
  Tag,
  fieldClass,
  labelClass,
} from '../components/ui';
import { submitTransaction } from '../lib/api';
import { getCards, getTransactions } from '../lib/ledger';
import { formatDate } from '../lib/format';
import {
  analyseSheet,
  buildRows,
  readFile,
  FIELD_LABELS,
  type ColumnMapping,
  type FieldKey,
  type ImportRow,
  type ParsedSheet,
  type SheetAnalysis,
} from '../lib/importFile';
import type { Card } from '../lib/types';

/* The fields a reviewer may want to re-point by hand. */
const MAPPABLE: FieldKey[] = [
  'date',
  'supplier',
  'decrease',
  'increase',
  'currency',
  'original_amount',
  'rate',
  'req_number',
  'payment_ref',
  'lpo_number',
  'invoice',
  'crm',
  'client',
  'sales_operation',
  'notes',
];

const KIND_LABEL: Record<ImportRow['kind'], string> = {
  purchase: 'Purchase',
  refund: 'Refund',
  funding: 'Funding',
  fee: 'Fee',
};

const columnLabel = (headers: string[], i: number): string => {
  let s = '';
  let n = i;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  const header = String(headers[i] ?? '').trim();
  return header ? `${s} — ${header}` : `${s} — (no header)`;
};

interface Outcome {
  row: ImportRow;
  ok: boolean;
  message: string;
}

export function Import() {
  const { reload } = useLedgerState();
  const cards = getCards();
  const existing = getTransactions();

  const [fileName, setFileName] = useState<string | null>(null);
  const [sheets, setSheets] = useState<ParsedSheet[]>([]);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [cardId, setCardId] = useState('');
  const [readError, setReadError] = useState<string | null>(null);

  /* Overrides layered on top of what the parser worked out. */
  const [mappingOverride, setMappingOverride] = useState<ColumnMapping>({});
  const [dayFirstOverride, setDayFirstOverride] = useState<boolean | null>(null);
  const [headerRowOverride, setHeaderRowOverride] = useState<number | null>(null);

  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  /** null = follow the default, which opens only when something is missing. */
  const [columnsOpen, setColumnsOpen] = useState<boolean | null>(null);

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [outcomes, setOutcomes] = useState<Outcome[] | null>(null);
  /** Set when the import stopped because of who is signed in, not what is in the file. */
  const [blockedBy, setBlockedBy] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const card = cards.find((c) => c.id === cardId);
  const sheet: ParsedSheet | undefined = sheets[sheetIndex];

  const reset = () => {
    setMappingOverride({});
    setDayFirstOverride(null);
    setHeaderRowOverride(null);
    setExcluded(new Set());
    setColumnsOpen(null);
    setOutcomes(null);
    setBlockedBy(null);
  };

  const onFile = useCallback(async (file: File) => {
    setReadError(null);
    setOutcomes(null);
    try {
      const parsed = await readFile(file);
      const withRows = parsed.filter((s) => s.rows.some((r) => r?.length));
      if (!withRows.length) throw new Error('That file has no rows in it.');
      setSheets(withRows);
      setSheetIndex(0);
      setFileName(file.name);
      reset();
    } catch (e) {
      setSheets([]);
      setFileName(null);
      setReadError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  /* What the parser makes of the chosen sheet, before overrides. */
  const analysis: SheetAnalysis | null = useMemo(
    () => (sheet ? analyseSheet(sheet, card) : null),
    [sheet, card],
  );

  const headerRow = headerRowOverride ?? analysis?.headerRow ?? -1;
  const headers = headerRow >= 0 ? (sheet?.rows[headerRow] ?? []) : [];
  const dayFirst = dayFirstOverride ?? analysis?.dayFirst ?? true;

  const mapping: ColumnMapping = useMemo(() => {
    const base = { ...(analysis?.mapping ?? {}) };
    for (const [k, v] of Object.entries(mappingOverride)) {
      if (v === -1) delete base[k as FieldKey];
      else base[k as FieldKey] = v as number;
    }
    return base;
  }, [analysis, mappingOverride]);

  const rows: ImportRow[] = useMemo(() => {
    if (!sheet || headerRow < 0) return [];
    return buildRows(sheet, headerRow, mapping, { dayFirst, existing, cardId });
  }, [sheet, headerRow, mapping, dayFirst, existing, cardId]);

  const matched = MAPPABLE.filter((f) => mapping[f] !== undefined).map(
    (f) => [f, mapping[f] as number] as const,
  );
  /** Without these there is nothing to import, so the mapping opens itself. */
  const essentialMissing =
    mapping.date === undefined ||
    mapping.supplier === undefined ||
    (mapping.decrease === undefined &&
      mapping.increase === undefined &&
      mapping.signed_amount === undefined);
  const showColumns = columnsOpen ?? essentialMissing;

  /* A row is imported when it has no errors and has not been unticked. */
  const included = rows.filter((r) => r.errors.length === 0 && !excluded.has(r.sourceRow) && r.include !== false);
  const blocked = rows.filter((r) => r.errors.length > 0);
  const duplicates = rows.filter((r) => r.duplicateOf);

  const spendTotal = included
    .filter((r) => r.kind === 'purchase' || r.kind === 'fee')
    .reduce((s, r) => s + (r.amountAed ?? 0), 0);
  const fundingTotal = included
    .filter((r) => r.kind === 'refund' || r.kind === 'funding')
    .reduce((s, r) => s + (r.amountAed ?? 0), 0);

  const toggle = (row: ImportRow) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      const currentlyIn = !next.has(row.sourceRow) && row.include !== false;
      if (currentlyIn) next.add(row.sourceRow);
      else {
        next.delete(row.sourceRow);
        // A row the parser left out (a suspected duplicate) is opted back in by
        // flipping its own flag, so the tick reflects what will happen.
        row.include = true;
      }
      return next;
    });
  };

  const runImport = async () => {
    if (!card || running || !included.length) return;
    setRunning(true);
    setProgress(0);
    setBlockedBy(null);
    const results: Outcome[] = [];
    for (let i = 0; i < included.length; i++) {
      const row = included[i];
      const result = await submitTransaction({
        p_card_id: card.id,
        p_txn_date: row.date as string,
        p_kind: row.kind,
        p_amount_aed: Math.abs(row.amountAed as number),
        p_supplier: row.supplier,
        p_req_number: row.reqNumber,
        p_payment_ref: row.paymentRef,
        p_currency: row.currency,
        p_original_amount: row.originalAmount,
        p_exchange_rate: row.rate,
        p_crm: row.crm || null,
        p_lpo_number: row.lpoNumber || null,
        p_invoice: row.invoice || null,
        p_client: row.client || null,
        p_sales_operation: row.salesOperation || null,
        p_notes:
          [row.notes, `imported from ${fileName ?? 'a file'}, row ${row.sourceRow}`]
            .filter(Boolean)
            .join(' — ') || null,
        // A row with a warning is imported for review rather than silently
        // accepted, so the review queue picks it up.
        p_needs_review: row.warnings.length > 0,
        // The duplicate check already ran here, and the reviewer said yes.
        p_allow_duplicate: Boolean(row.duplicateOf),
      });
      results.push(
        result.ok
          ? { row, ok: true, message: result.id }
          : { row, ok: false, message: result.error },
      );
      setProgress(i + 1);

      // A refusal about permission is not about this row, and every row after
      // it would be refused the same way. Stop rather than print the same
      // message a hundred times.
      if (!result.ok && /only a named admin|42501|permission denied|not connected/i.test(result.error)) {
        setBlockedBy(result.error);
        break;
      }
    }
    setOutcomes(results);
    setRunning(false);
    if (results.some((r) => r.ok)) reload();
  };

  const imported = outcomes?.filter((o) => o.ok) ?? [];
  const failed = outcomes?.filter((o) => !o.ok) ?? [];

  return (
    <Page
      title="Import transactions"
      description="Upload a sheet in the same shape as the workbook. Every row is shown before anything is saved, and each one is written through the same checked path as a manual entry."
    >
      <div className="space-y-5">
        {/* ------------------------------------------------------ the file */}
        <Panel
          title="1. The file"
          description="An .xlsx or .csv with a header row and one transaction per row."
        >
          <div className="px-4 py-4">
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const f = e.dataTransfer.files?.[0];
                if (f) void onFile(f);
              }}
              className="flex flex-wrap items-center gap-3 rounded-md border border-dashed border-line-strong bg-sunken px-4 py-5"
            >
              <input
                ref={inputRef}
                type="file"
                accept=".xlsx,.xlsm,.csv,.txt"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onFile(f);
                  e.target.value = '';
                }}
              />
              <Button variant="primary" onClick={() => inputRef.current?.click()}>
                Choose a file
              </Button>
              <span className="text-[13px] text-ink-muted">
                {fileName ? (
                  <>
                    <span className="font-medium text-ink">{fileName}</span>
                    {sheets.length > 1 && ` — ${sheets.length} sheets`}
                  </>
                ) : (
                  'or drop it here'
                )}
              </span>
            </div>

            {readError && (
              <div className="mt-3">
                <Notice tone="negative" title="That file could not be read">
                  {readError}
                </Notice>
              </div>
            )}

            {sheets.length > 1 && (
              <div className="mt-4 max-w-sm">
                <Field label="Sheet">
                  <select
                    value={sheetIndex}
                    onChange={(e) => {
                      setSheetIndex(Number(e.target.value));
                      reset();
                    }}
                    className={fieldClass}
                  >
                    {sheets.map((s, i) => (
                      <option key={i} value={i}>
                        {s.name} ({Math.max(0, s.rows.length - 1)} rows)
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            )}
          </div>
        </Panel>

        {/* ------------------------------------------------------ the card */}
        {sheets.length > 0 && (
          <Panel
            title="2. The card"
            description="Which account these transactions belong to. The card also settles which column decreases the balance."
          >
            <div className="px-4 py-4">
              <div className="max-w-sm">
                <Field label="Card / account" required>
                  <select
                    value={cardId}
                    onChange={(e) => {
                      setCardId(e.target.value);
                      setMappingOverride({});
                      setOutcomes(null);
                    }}
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
              </div>

              {card && <CardConvention card={card} note={analysis?.directionNote ?? ''} />}
            </div>
          </Panel>
        )}

        {/* --------------------------------------------------- how it read */}
        {sheet && card && (
          <Panel
            title="3. How the file was read"
            description="Change anything here that is wrong before importing."
          >
            <div className="space-y-4 px-4 py-4">
              {headerRow < 0 ? (
                <Notice tone="negative" title="No header row found">
                  Nothing in the first 30 rows looks like a header. Pick the row that holds the
                  column names.
                </Notice>
              ) : (
                <p className="text-[13px] text-ink-muted">
                  Header on row {headerRow + 1}:{' '}
                  <span className="text-ink">
                    {headers.filter(Boolean).slice(0, 8).join(' · ')}
                    {headers.filter(Boolean).length > 8 && ' …'}
                  </span>
                </p>
              )}

              <div className="max-w-[10rem]">
                <Field label="Header row" hint="1-based, as Excel numbers them">
                  <input
                    type="number"
                    min={1}
                    value={headerRow + 1}
                    onChange={(e) => {
                      setHeaderRowOverride(Math.max(0, Number(e.target.value) - 1));
                      setMappingOverride({});
                    }}
                    className={fieldClass}
                  />
                </Field>
              </div>

              {analysis?.dateFoundByContent && (
                <Notice tone="accent" title="The date column has no header">
                  It was found by reading the values in it — column{' '}
                  {columnLabel(headers, mapping.date as number)}. Check the dates below.
                </Notice>
              )}

              <DateReading
                dayFirst={dayFirst}
                proof={analysis?.dayFirstProof ?? null}
                conflict={analysis?.dayFirstConflict ?? false}
                onChange={(v) => setDayFirstOverride(v)}
              />

              {/* The mapping is usually right, and fifteen dropdowns would bury
                  the rows the reviewer actually needs to read. It opens by
                  itself when something essential is missing. */}
              <div>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className={labelClass}>Columns</span>
                  <button
                    type="button"
                    onClick={() => setColumnsOpen(!showColumns)}
                    className="text-xs font-medium text-accent hover:underline"
                  >
                    {showColumns ? 'Done' : 'Change the columns'}
                  </button>
                </div>

                {!showColumns && (
                  <p className="mt-1.5 text-[13px] text-ink-muted">
                    {matched.length ? (
                      <>
                        Matched{' '}
                        {matched.map(([field, i], n) => (
                          <span key={field}>
                            {n > 0 && ', '}
                            <span className="text-ink">{FIELD_LABELS[field]}</span> →{' '}
                            {columnLabel(headers, i).split(' — ')[0]}
                          </span>
                        ))}
                        .
                      </>
                    ) : (
                      'Nothing was matched. Set the columns by hand.'
                    )}
                  </p>
                )}

                {showColumns && (
                  <div className="mt-2 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {MAPPABLE.map((field) => (
                      <label key={field} className="block">
                        <span className="text-xs text-ink-muted">{FIELD_LABELS[field]}</span>
                        <select
                          value={mapping[field] ?? -1}
                          onChange={(e) =>
                            setMappingOverride((m) => ({ ...m, [field]: Number(e.target.value) }))
                          }
                          className={`${fieldClass} mt-1`}
                        >
                          <option value={-1}>— not in this file —</option>
                          {headers.map((_, i) => (
                            <option key={i} value={i}>
                              {columnLabel(headers, i)}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </Panel>
        )}

        {/* -------------------------------------------------- the review */}
        {sheet && card && headerRow >= 0 && (
          <Panel
            title="4. Review"
            description="Untick anything that should not be imported."
            action={
              <div className="flex items-center gap-2">
                <Button
                  variant="primary"
                  disabled={!included.length || running}
                  onClick={() => void runImport()}
                >
                  {running
                    ? `Importing ${progress} of ${included.length}…`
                    : `Import ${included.length} transaction${included.length === 1 ? '' : 's'}`}
                </Button>
              </div>
            }
          >
            <div className="border-b border-line px-4 py-3">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px]">
                <span>
                  <span className="tnum font-semibold text-ink">{included.length}</span>{' '}
                  <span className="text-ink-muted">ready</span>
                </span>
                {blocked.length > 0 && (
                  <span>
                    <span className="tnum font-semibold text-negative">{blocked.length}</span>{' '}
                    <span className="text-ink-muted">cannot be imported</span>
                  </span>
                )}
                {duplicates.length > 0 && (
                  <span>
                    <span className="tnum font-semibold text-review">{duplicates.length}</span>{' '}
                    <span className="text-ink-muted">already look to be in the ledger</span>
                  </span>
                )}
                <span className="text-ink-muted">
                  Spend <Money amount={-spendTotal} tone="ledger" code={false} /> · Funding <Money amount={fundingTotal} tone="ledger" code={false} />
                </span>
                {card && (
                  <span className="text-ink-muted">
                    Balance would go from <Money amount={card.ledgerBalance} code={false} /> to{' '}
                    <Money amount={card.ledgerBalance - spendTotal + fundingTotal} tone="ledger" code={false} />
                  </span>
                )}
              </div>
            </div>

            {rows.length === 0 ? (
              <div className="px-4 py-6">
                <EmptyState
                  title="No transactions found below the header"
                  description="Check the header row and the column mapping above."
                />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[52rem] border-collapse text-[13px]">
                  <thead>
                    <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-faint">
                      <th className="px-3 py-2 font-medium">Import</th>
                      <th className="px-3 py-2 font-medium">Row</th>
                      <th className="px-3 py-2 font-medium">Date</th>
                      <th className="px-3 py-2 font-medium">Supplier</th>
                      <th className="px-3 py-2 text-right font-medium">AED</th>
                      <th className="px-3 py-2 font-medium">Type</th>
                      <th className="px-3 py-2 font-medium">Original</th>
                      <th className="px-3 py-2 font-medium">Notes on this row</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const isIn =
                        row.errors.length === 0 && !excluded.has(row.sourceRow) && row.include !== false;
                      const done = outcomes?.find((o) => o.row.sourceRow === row.sourceRow);
                      return (
                        <tr
                          key={row.sourceRow}
                          className={`border-b border-line align-top ${
                            row.errors.length ? 'bg-negative-soft' : isIn ? '' : 'text-ink-faint'
                          }`}
                        >
                          <td className="px-3 py-2">
                            <input
                              type="checkbox"
                              checked={isIn}
                              disabled={row.errors.length > 0 || running || Boolean(done?.ok)}
                              onChange={() => toggle(row)}
                              className="accent-[#1f4a73]"
                            />
                          </td>
                          <td className="tnum px-3 py-2 text-ink-muted">{row.sourceRow}</td>
                          <td className="tnum whitespace-nowrap px-3 py-2">
                            {row.date ? formatDate(row.date) : '—'}
                            {row.dateRaw && row.dateRaw !== row.date && (
                              <span className="block text-[11px] text-ink-faint">
                                file says “{row.dateRaw}”
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2">{row.supplier || '—'}</td>
                          <td className="tnum px-3 py-2 text-right">
                            {row.amountAed === null ? (
                              '—'
                            ) : (
                              <Money
                                amount={
                                  row.kind === 'purchase' || row.kind === 'fee'
                                    ? -row.amountAed
                                    : row.amountAed
                                }
                                tone="ledger"
                                signed
                                code={false}
                              />
                            )}
                          </td>
                          <td className="px-3 py-2">{KIND_LABEL[row.kind]}</td>
                          <td className="tnum whitespace-nowrap px-3 py-2 text-ink-muted">
                            {row.currency
                              ? `${row.currency} ${row.originalAmount ?? '?'}`
                              : ''}
                          </td>
                          <td className="px-3 py-2">
                            {done && (
                              <span
                                className={`mr-2 ${done.ok ? 'text-ink-muted' : 'text-negative'}`}
                              >
                                {done.ok ? 'Imported.' : `Refused: ${done.message}`}
                              </span>
                            )}
                            {row.errors.map((e, i) => (
                              <span key={`e${i}`} className="mr-2 text-negative">
                                {e}
                              </span>
                            ))}
                            {row.warnings.map((w, i) => (
                              <span key={`w${i}`} className="mr-2 text-review">
                                {w}
                              </span>
                            ))}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        )}

        {/* ------------------------------------------------------- result */}
        {outcomes && (
          <Panel title="Result">
            <div className="space-y-3 px-4 py-4">
              <p className="text-[13px]">
                <span className="font-semibold text-ink">{imported.length}</span> imported
                {failed.length > 0 && (
                  <>
                    , <span className="font-semibold text-negative">{failed.length}</span> refused
                  </>
                )}
                .
              </p>
              {blockedBy && (
                <Notice tone="negative" title="The import stopped">
                  {blockedBy}
                  <p className="mt-1">
                    This is about the signed-in account, not the file. Everyone can read the
                    ledger; only a named admin can add to it. Nothing after this point was
                    attempted — the rows above are unaffected and the file can be imported again
                    once access is granted.
                  </p>
                </Notice>
              )}
              {failed.length > 0 && (
                <Notice tone="negative" title="Some rows were not saved">
                  <ul className="mt-1 space-y-1">
                    {failed.slice(0, 10).map((f) => (
                      <li key={f.row.sourceRow}>
                        Row {f.row.sourceRow} — {f.message}
                      </li>
                    ))}
                  </ul>
                  {failed.length > 10 && <p className="mt-1">…and {failed.length - 10} more.</p>}
                </Notice>
              )}
              {imported.length > 0 && (
                <p className="text-[13px] text-ink-muted">
                  Rows carrying a warning were saved with a review flag, so they show up in the
                  review queue rather than being taken as final.
                </p>
              )}
            </div>
          </Panel>
        )}

        {sheets.length === 0 && !readError && (
          <Panel title="What the file should look like">
            <div className="px-4 py-4 text-[13px] text-ink-muted">
              <p>
                The same layout as the workbook sheets: a header row, then one transaction per
                row, with the amount in the DEBIT or the CREDIT column. Headers are matched by
                name, so <span className="text-ink">TRANSACTION DATE</span>,{' '}
                <span className="text-ink">DETAILS</span>,{' '}
                <span className="text-ink">SUPPLIER NAME</span>,{' '}
                <span className="text-ink">ORIGINAL CURRENCY</span>,{' '}
                <span className="text-ink">REQ NUMBER</span> and{' '}
                <span className="text-ink">PAYMENT REFERENCE NUMBER</span> are all recognised —
                and anything that is not can be pointed at the right column by hand.
              </p>
              <p className="mt-2">
                Exporting a card from the Transactions page gives a file in exactly this shape.
              </p>
            </div>
          </Panel>
        )}
      </div>
    </Page>
  );
}

/** Says, in words, which way round this card's columns run. */
function CardConvention({ card, note }: { card: Card; note: string }) {
  return (
    <div className="mt-4 rounded-md border border-line bg-sunken px-3.5 py-3 text-[13px]">
      <p className="text-ink">{note}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Tag tone="negative">{card.decreasingHeader.trim()} decreases the balance</Tag>
        <Tag tone="accent">{card.increasingHeader.trim()} increases it</Tag>
        {card.headerIsMisleading && (
          <Tag tone="review">This card's headers run the opposite way to the others</Tag>
        )}
      </div>
    </div>
  );
}

/** The day/month reading, with whatever settled it. */
function DateReading({
  dayFirst,
  proof,
  conflict,
  onChange,
}: {
  dayFirst: boolean;
  proof: string | null;
  conflict: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div>
      <span className={labelClass}>Dates</span>
      <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[13px]">
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            checked={dayFirst}
            onChange={() => onChange(true)}
            className="accent-[#1f4a73]"
          />
          Day first (31/01/2026)
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            checked={!dayFirst}
            onChange={() => onChange(false)}
            className="accent-[#1f4a73]"
          />
          Month first (01/31/2026)
        </label>
      </div>
      <p className="mt-1.5 text-xs text-ink-muted">
        {conflict
          ? 'This file contains dates that read both ways. Check every row below against the raw text.'
          : proof
            ? `Settled by “${proof}” in this file — only one reading of it is a real date. Dates Excel stored as dates are unaffected either way.`
            : 'Nothing in the file settles the order, so day-first is assumed, matching the workbook. Every affected row is flagged below with what the file actually says.'}
      </p>
    </div>
  );
}
