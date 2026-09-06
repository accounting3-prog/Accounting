/**
 * Exporting the transactions currently on screen.
 *
 * Two rules shape this:
 *
 *   1. The export is exactly what the user is looking at — the filtered, sorted
 *      result set, not a fresh query. If the screen says 29 rows, the file has
 *      29 rows.
 *   2. Amounts are written as numbers, not as formatted text. A spreadsheet
 *      that has to be re-parsed before it can be summed is not much use to an
 *      accountant, and "1,234.56" imported as a string is a well-known way to
 *      lose a figure.
 *
 * The .xlsx writer is hand-rolled over a zip: an xlsx is a handful of XML parts
 * in an OPC container, and writing them directly avoids pulling a
 * multi-hundred-kilobyte spreadsheet library into a bundle that needs one
 * sheet with no formulas.
 */

import { zipSync, strToU8 } from 'fflate';
import type { Card, Transaction } from './types';
import type { Filters } from './search';

/* ------------------------------------------------------------------ naming */

/**
 * A filename built from what the user actually typed.
 *
 * Searching "REQ 11973" gives REQ-11973-transactions.csv. The wording is kept
 * readable rather than slugged into something unrecognisable — the point of the
 * name is that the person who ran the search knows which file this is a month
 * later.
 */
export function exportFilename(
  query: string,
  filters: Filters,
  cards: Card[],
  extension: 'csv' | 'xlsx',
): string {
  const clean = (s: string) =>
    s
      // Characters Windows, macOS and Linux disallow, plus control characters.
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\s/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

  let base = clean(query);

  if (!base) {
    // No search phrase: name the file after whatever filter is actually
    // narrowing the view, so the download is still self-describing.
    const parts: string[] = [];
    if (filters.cardIds.length === 1) {
      const card = cards.find((c) => c.id === filters.cardIds[0]);
      if (card) parts.push(card.name);
    } else if (filters.cardIds.length > 1) {
      parts.push(`${filters.cardIds.length}-cards`);
    }
    if (filters.currencies.length === 1) parts.push(filters.currencies[0]);
    if (filters.statuses.length === 1) parts.push(filters.statuses[0].replace(/_/g, '-'));
    if (filters.dateFrom || filters.dateTo)
      parts.push(`${filters.dateFrom || 'start'}_to_${filters.dateTo || 'end'}`);
    base = clean(parts.join(' ')) || 'all';
  }

  // Long enough to stay meaningful, short enough for every filesystem.
  if (base.length > 80) base = base.slice(0, 80).replace(/-$/, '');
  return `${base}-transactions.${extension}`;
}

/* ----------------------------------------------------------------- columns */

interface Column {
  header: string;
  get: (t: Transaction, card: Card | undefined) => string | number | null;
  numeric?: boolean;
}

export const EXPORT_COLUMNS: Column[] = [
  { header: 'Card', get: (_t, c) => c?.name ?? '' },
  { header: 'Date', get: (t) => t.txn_date ?? '' },
  { header: 'Supplier', get: (t) => t.supplier ?? t.description ?? '' },
  { header: 'Supplier country', get: (t) => t.supplier_country ?? '' },
  { header: 'Request number', get: (t) => t.req_number ?? '' },
  { header: 'Original currency', get: (t) => t.currency ?? '' },
  { header: 'Original amount', get: (t) => t.original_amount ?? null, numeric: true },
  { header: 'Exchange rate (source)', get: (t) => t.exchange_rate ?? null, numeric: true },
  {
    header: 'Exchange rate (normalized)',
    get: (t) => t.normalized_exchange_rate ?? null,
    numeric: true,
  },
  { header: 'AED settlement', get: (t) => t.amount_aed, numeric: true },
  {
    header: 'Type',
    get: (t) =>
      t.entry_type === 'reconciliation_adjustment'
        ? 'Reconciliation adjustment'
        : t.direction === 'spend'
          ? 'Spend'
          : t.direction === 'funding'
            ? 'Funding'
            : '',
  },
  { header: 'Payment reference', get: (t) => t.payment_ref ?? '' },
  { header: 'LPO number', get: (t) => t.lpo_number ?? '' },
  { header: 'Invoice', get: (t) => t.invoice ?? '' },
  { header: 'CRM', get: (t) => t.crm ?? '' },
  { header: 'Account', get: (t) => t.account ?? '' },
  { header: 'Client', get: (t) => t.client ?? '' },
  { header: 'Sales operation', get: (t) => t.sales_operation ?? '' },
  { header: 'Status', get: (t) => t.status.replace(/_/g, ' ') },
  { header: 'In source balance', get: (t) => (t.included_in_source_balance === false ? 'No' : 'Yes') },
  { header: 'Source sheet', get: (t) => t.source_sheet ?? 'manual entry' },
  { header: 'Source row', get: (t) => t.source_row ?? null, numeric: true },
  { header: 'Source date (raw)', get: (t) => t.source_date_raw ?? '' },
  { header: 'Source currency text', get: (t) => t.currency_raw ?? '' },
  { header: 'Rate formula (source)', get: (t) => t.exchange_rate_formula ?? '' },
  { header: 'Date repaired', get: (t) => (t.date_repaired ? 'Yes' : '') },
  { header: 'Review note', get: (t) => t.rate_review_note ?? '' },
  { header: 'Review reason', get: (t) => t.review_reason ?? '' },
  { header: 'Notes', get: (t) => t.notes ?? '' },
  { header: 'Occurrence', get: (t) => t.occurrence ?? 1, numeric: true },
];

/** A human sentence describing what the file contains. */
export function filterSummary(
  query: string,
  filters: Filters,
  cards: Card[],
  count: number,
): string {
  const bits: string[] = [];
  if (query.trim()) bits.push(`search "${query.trim()}"`);
  if (filters.cardIds.length)
    bits.push(
      `cards: ${filters.cardIds
        .map((id) => cards.find((c) => c.id === id)?.name ?? id)
        .join(', ')}`,
    );
  if (filters.currencies.length) bits.push(`currencies: ${filters.currencies.join(', ')}`);
  if (filters.statuses.length)
    bits.push(`status: ${filters.statuses.map((s) => s.replace(/_/g, ' ')).join(', ')}`);
  if (filters.kinds.length) bits.push(`type: ${filters.kinds.join(', ')}`);
  if (filters.dateFrom) bits.push(`from ${filters.dateFrom}`);
  if (filters.dateTo) bits.push(`to ${filters.dateTo}`);
  if (filters.source !== 'all') bits.push(`source: ${filters.source}`);
  return `${count} transaction${count === 1 ? '' : 's'}${
    bits.length ? ` — ${bits.join('; ')}` : ' — no filters applied'
  }`;
}

/* --------------------------------------------------------------------- CSV */

function csvCell(value: string | number | null): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildCsv(
  transactions: Transaction[],
  cards: Card[],
  summary: string,
): string {
  const cardById = new Map(cards.map((c) => [c.id, c]));
  const lines: string[] = [];
  lines.push(csvCell(`Card Ledger export — ${new Date().toISOString().slice(0, 10)}`));
  lines.push(csvCell(summary));
  lines.push('');
  lines.push(EXPORT_COLUMNS.map((c) => csvCell(c.header)).join(','));
  for (const t of transactions)
    lines.push(
      EXPORT_COLUMNS.map((c) => csvCell(c.get(t, cardById.get(t.cardId)))).join(','),
    );
  // A BOM so Excel opens UTF-8 correctly on a double-click.
  return '﻿' + lines.join('\r\n');
}

/* -------------------------------------------------------------------- XLSX */

const xmlEscape = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Control characters are illegal in XML 1.0 and would corrupt the file.
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');

const colName = (i: number): string => {
  let s = '';
  let n = i;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
};

/**
 * A live formula, e.g. `{ formula: 'F5-D6+E6' }` (no leading `=`).
 *
 * Written without a cached `<v>`, so Excel and LibreOffice both calculate it on
 * open. That is the point of putting one in a file at all: a template whose
 * balance column held frozen numbers would stop being a running balance the
 * moment someone typed a figure into it.
 */
export interface FormulaCell {
  formula: string;
  /**
   * The result, cached.
   *
   * Excel is entitled to show a formula cell as blank until it recalculates,
   * and a file written with no cached results and no instruction to recalculate
   * opens looking like the formulas are missing. Both halves are needed: the
   * value below, so the number is there the instant the file opens and in
   * viewers that never calculate at all (a Drive preview, a phone), and
   * fullCalcOnLoad in the workbook, so Excel replaces it with a real
   * calculation as soon as it has one.
   */
  value?: number;
}
export type Cell = string | number | null | FormulaCell;

const isFormula = (v: Cell): v is FormulaCell =>
  typeof v === 'object' && v !== null && typeof (v as FormulaCell).formula === 'string';

function sheetXml(
  rows: Cell[][],
  headerRowIndex: number,
  widths?: number[],
): string {
  const body = rows
    .map((row, r) => {
      const cells = row
        .map((value, c) => {
          const ref = `${colName(c)}${r + 1}`;
          if (isFormula(value))
            return (
              `<c r="${ref}" s="1"><f>${xmlEscape(value.formula)}</f>` +
              (typeof value.value === 'number' && Number.isFinite(value.value)
                ? `<v>${value.value}</v>`
                : '') +
              `</c>`
            );
          if (value === null || value === undefined || value === '') return '';
          if (typeof value === 'number' && Number.isFinite(value))
            return `<c r="${ref}" s="${r === headerRowIndex ? 2 : 1}"><v>${value}</v></c>`;
          return `<c r="${ref}" s="${r === headerRowIndex ? 2 : 0}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(
            String(value),
          )}</t></is></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');

  const cols =
    widths ??
    EXPORT_COLUMNS.map((c) => Math.min(Math.max(c.header.length + 4, 12), 34));

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRowIndex + 1}" topLeftCell="A${headerRowIndex + 2}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${cols
    .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
    .join('')}</cols>
<sheetData>${body}</sheetData>
</worksheet>`;
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FFBFBFBF"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="3">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/** One tab in the workbook. */
export interface SheetSpec {
  name: string;
  rows: Cell[][];
  headerRowIndex: number;
  /** Column widths in Excel's units. Falls back to the transaction columns. */
  widths?: number[];
}

/**
 * Excel's own rules for a tab name: at most 31 characters, and none of
 * : \ / ? * [ ]. A name that breaks either makes the file unopenable rather
 * than merely ugly, so card names are trimmed here and uniqueness is forced —
 * two cards trimming to the same 31 characters would otherwise collide.
 */
export function safeSheetName(name: string, taken: Set<string>): string {
  let base = name.replace(/[:\\/?*[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31);
  if (!base) base = 'Sheet';
  let candidate = base;
  let n = 2;
  while (taken.has(candidate.toLowerCase())) {
    const suffix = ` (${n++})`;
    candidate = base.slice(0, 31 - suffix.length) + suffix;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

const xmlAttr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** An .xlsx with any number of tabs. */
export function buildXlsxWorkbook(sheets: SheetSpec[]): Uint8Array {
  const files: Record<string, Uint8Array> = {
    'xl/styles.xml': strToU8(STYLES_XML),
  };

  const overrides: string[] = [];
  const sheetTags: string[] = [];
  const rels: string[] = [];

  sheets.forEach((s, i) => {
    const n = i + 1;
    files[`xl/worksheets/sheet${n}.xml`] = strToU8(sheetXml(s.rows, s.headerRowIndex, s.widths));
    overrides.push(
      `<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    );
    sheetTags.push(`<sheet name="${xmlAttr(s.name)}" sheetId="${n}" r:id="rId${n}"/>`);
    rels.push(
      `<Relationship Id="rId${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${n}.xml"/>`,
    );
  });
  // The styles part takes the id after the last sheet.
  rels.push(
    `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
  );

  files['[Content_Types].xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${overrides.join('\n')}
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`);

  files['_rels/.rels'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`);

  files['xl/workbook.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheetTags.join('')}</sheets>
<calcPr calcId="191029" fullCalcOnLoad="1"/>
</workbook>`);

  files['xl/_rels/workbook.xml.rels'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${rels.join('\n')}
</Relationships>`);

  return zipSync(files, { level: 6 });
}

/** The rows for one tab: three lines of context, a blank, then the table. */
function sheetRows(
  transactions: Transaction[],
  cards: Card[],
  title: string,
  summary: string,
): Cell[][] {
  const cardById = new Map(cards.map((c) => [c.id, c]));
  return [
    [title],
    [`Exported ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`],
    [summary],
    [],
    EXPORT_COLUMNS.map((c) => c.header),
    ...transactions.map((t) => EXPORT_COLUMNS.map((c) => c.get(t, cardById.get(t.cardId)))),
  ];
}

export function buildXlsx(
  transactions: Transaction[],
  cards: Card[],
  summary: string,
): Uint8Array {
  return buildXlsxWorkbook([
    {
      name: 'Transactions',
      rows: sheetRows(transactions, cards, 'Card Ledger export', summary),
      headerRowIndex: 4,
    },
  ]);
}

/**
 * Every transaction, one tab per card, plus a summary tab.
 *
 * A card with no transactions still gets its tab: an empty sheet says "this
 * account had no activity", where a missing one leaves the reader wondering
 * whether it was forgotten.
 */
export function buildXlsxByCard(
  transactions: Transaction[],
  cards: Card[],
): Uint8Array {
  const taken = new Set<string>();
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);

  const summaryRows: Cell[][] = [
    ['Card Ledger — all transactions by card'],
    [`Exported ${stamp} UTC`],
    [`${transactions.length} transactions across ${cards.length} cards`],
    [],
    ['Card', 'Transactions', 'Opening balance', 'Statement balance',
     'Ledger balance', 'Difference', 'Spend', 'Funding', 'Opening date',
     'Last activity'],
    ...cards.map((c) => [
      c.name,
      transactions.filter((t) => t.cardId === c.id).length,
      c.openingBalance,
      c.sourceBalance,
      c.ledgerBalance,
      c.reconciliationDifference,
      c.totalSpend,
      c.totalFunding,
      c.openingDate ?? '',
      c.lastTransaction ?? '',
    ]),
    [],
    // Deliberately no cross-currency total anywhere in this file.
    ['Balances are in AED. Amounts in other currencies appear per transaction',
     'in the Original amount column and are never summed across currencies.'],
  ];

  const sheets: SheetSpec[] = [
    { name: safeSheetName('Summary', taken), rows: summaryRows, headerRowIndex: 4 },
  ];

  for (const card of cards) {
    const mine = transactions
      .filter((t) => t.cardId === card.id)
      .sort((a, b) => (b.txn_date ?? '').localeCompare(a.txn_date ?? ''));
    sheets.push({
      name: safeSheetName(card.name, taken),
      rows: sheetRows(
        mine,
        cards,
        card.name,
        `${mine.length} transactions · ledger balance ${card.ledgerBalance.toLocaleString('en-US', { minimumFractionDigits: 2 })} AED`,
      ),
      headerRowIndex: 4,
    });
  }

  return buildXlsxWorkbook(sheets);
}

/* ---------------------------------------------------------------- download */

export function downloadBlob(
  data: string | Uint8Array,
  filename: string,
  mime: string,
): void {
  // A Uint8Array over a plain ArrayBuffer is what BlobPart accepts; fflate
  // returns one typed over ArrayBufferLike, so the buffer is taken explicitly.
  const part: BlobPart =
    typeof data === 'string'
      ? data
      : new Uint8Array(data).buffer.slice(0) as ArrayBuffer;
  const blob = new Blob([part], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next tick so the click has taken effect first.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function exportCsv(
  transactions: Transaction[],
  cards: Card[],
  query: string,
  filters: Filters,
): string {
  const name = exportFilename(query, filters, cards, 'csv');
  const summary = filterSummary(query, filters, cards, transactions.length);
  downloadBlob(buildCsv(transactions, cards, summary), name, 'text/csv;charset=utf-8');
  return name;
}

export function exportXlsx(
  transactions: Transaction[],
  cards: Card[],
  query: string,
  filters: Filters,
): string {
  const name = exportFilename(query, filters, cards, 'xlsx');
  const summary = filterSummary(query, filters, cards, transactions.length);
  downloadBlob(
    buildXlsx(transactions, cards, summary),
    name,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  return name;
}

/**
 * One workbook, one tab per card, plus a Summary tab.
 *
 * This one deliberately ignores the search box: it is the "give me everything,
 * filed by card" download, and a file named all-cards that quietly held a
 * filtered subset would be a trap.
 */
export function exportXlsxByCard(
  transactions: Transaction[],
  cards: Card[],
): string {
  const name = `card-ledger-by-card-${new Date().toISOString().slice(0, 10)}.xlsx`;
  downloadBlob(
    buildXlsxByCard(transactions, cards),
    name,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  return name;
}

/* ---------------------------------------------------------------- templates */

/**
 * A blank sheet shaped like the card's own statement, for filling in and
 * uploading back.
 *
 * Three things make it worth generating rather than copying an old file:
 *
 *   1. It opens on the card's CURRENT closing balance, so the running total in
 *      the balance column continues the ledger instead of restarting it.
 *   2. The balance column is a live formula that follows this card's own
 *      convention. On six cards a purchase lowers the balance; on RAK 9825 it
 *      raises it, and the formula written here is the one that card's sheet
 *      actually uses. Type an amount and the balance moves the right way.
 *   3. Its headers are the ones the importer recognises, and the two amount
 *      columns carry this card's own labels — so what comes back in is read
 *      exactly as the card means it, with no column mapping to redo by hand.
 *
 * The balance column is for the person filling it in to check their work. The
 * importer ignores it: balances are computed from transactions, never read.
 */
export const TEMPLATE_BLANK_ROWS = 200;

interface TemplateColumn {
  header: string;
  width: number;
}

export function cardTemplateColumns(card: Card): TemplateColumn[] {
  const spend = card.decreasingHeader.trim() || 'DEBIT';
  const received = card.increasingHeader.trim() || 'CREDIT';
  // In the sheet's own order, so the file looks like the statement it mirrors.
  const spendFirst = (card.decreasingColumn || 'D') <= (card.increasingColumn || 'E');
  const amounts: TemplateColumn[] = spendFirst
    ? [{ header: spend, width: 14 }, { header: received, width: 14 }]
    : [{ header: received, width: 14 }, { header: spend, width: 14 }];

  return [
    { header: 'TRANSACTION DATE', width: 18 },
    { header: 'DETAILS', width: 34 },
    { header: 'ORIGINAL CURRENCY', width: 18 },
    { header: 'AMOUNT', width: 14 },
    ...amounts,
    { header: 'BALANCE', width: 16 },
    { header: 'CONVERSION', width: 14 },
    { header: 'REQ NUMBER', width: 18 },
    { header: 'LPO NUMBER', width: 18 },
    { header: 'INVOICE', width: 18 },
    { header: 'PAYMENT REFERENCE NUMBER', width: 26 },
    { header: 'CRM', width: 10 },
    { header: 'CLIENT', width: 18 },
    { header: 'SALES OPERATION', width: 18 },
    { header: 'NOTES', width: 30 },
  ];
}

export function buildCardTemplate(card: Card, blankRows = TEMPLATE_BLANK_ROWS): Uint8Array {
  const columns = cardTemplateColumns(card);
  const letter = (i: number) => colName(i);

  const spendHeader = card.decreasingHeader.trim() || 'DEBIT';
  const iSpend = columns.findIndex((c) => c.header === spendHeader);
  const iReceived = columns.findIndex(
    (c, i) => i !== iSpend && (c.header === (card.increasingHeader.trim() || 'CREDIT')),
  );
  const iBalance = columns.findIndex((c) => c.header === 'BALANCE');

  const S = letter(iSpend);
  const R = letter(iReceived);
  const B = letter(iBalance);

  // Two rows of preamble, then the header, then the opening balance, then the
  // blank rows. The preamble is deliberately above the header rather than
  // beside it: the importer finds the header by scoring rows, and prose in a
  // column would be read as a column name.
  const headerRowIndex = 3;
  const openingRow = headerRowIndex + 2; // 1-based sheet row of the opening line
  const blank = () => columns.map(() => null as Cell);

  const rows: Cell[][] = [
    [`${card.name} — blank sheet for new transactions`],
    [
      card.balanceSign === -1
        ? `Row ${openingRow} carries the balance as it stands today. On this card the balance counts what has been drawn, so an amount in ${spendHeader} raises it and an amount in ${card.increasingHeader.trim()} lowers it.`
        : `Row ${openingRow} carries the balance as it stands today. An amount in ${spendHeader} lowers the balance; an amount in ${card.increasingHeader.trim()} raises it.`,
    ],
    [
      'Fill in one transaction per row and upload the file on the Import page. ' +
        'The BALANCE column is here so you can check your own work — it is not imported. ' +
        'Write dates as DD/MM/YYYY.',
    ],
    columns.map((c) => c.header as Cell),
  ];

  // The opening line: only the balance, exactly as every sheet in the workbook
  // does it.
  const opening = blank();
  opening[1] = 'Balance brought forward';
  opening[iBalance] = card.ledgerBalance;
  rows.push(opening);

  // The running balance. Written as the card's own sheet writes it: on an
  // available-balance card the spend column subtracts, on a drawn-balance card
  // it adds.
  for (let n = 0; n < blankRows; n++) {
    const r = openingRow + 1 + n; // 1-based row number in the sheet
    const prev = `${B}${r - 1}`;
    const row = blank();
    // Written the way the workbook writes it — `=G5-D6+E6` — rather than
    // wrapped in N() or IF(). Excel treats an empty cell as zero here, and a
    // formula that matches the source sheets is one an accountant can read.
    // The cached result of an untouched row is the opening balance, since every
    // amount above it is still empty. It is replaced the moment Excel opens the
    // file and recalculates, and the moment anyone types an amount.
    row[iBalance] = {
      formula:
        card.balanceSign === -1
          ? `${prev}+${S}${r}-${R}${r}`
          : `${prev}-${S}${r}+${R}${r}`,
      value: card.ledgerBalance,
    };
    rows.push(row);
  }

  return buildXlsxWorkbook([
    {
      name: safeSheetName(card.name, new Set<string>()),
      rows,
      headerRowIndex,
      widths: columns.map((c) => c.width),
    },
  ]);
}

export function exportCardTemplate(card: Card): string {
  const safe = card.name.replace(/[\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
  const name = `${safe} — blank sheet.xlsx`;
  downloadBlob(
    buildCardTemplate(card),
    name,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  return name;
}
