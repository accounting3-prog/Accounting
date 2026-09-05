/**
 * Reading a spreadsheet of new transactions and turning it into rows that can
 * be reviewed before anything is written.
 *
 * The file this accepts is the same shape as the sheets in the source
 * workbook — a header row, then one transaction per row, with the amount in a
 * DEBIT or a CREDIT column. That is deliberate: it is the file the finance team
 * already produces, so nothing has to be reformatted before an import.
 *
 * Three things this module refuses to do, because each is a way to lose money
 * quietly:
 *
 *   1. It never decides on its own which column increases the balance. The
 *      workbook proves that the same word means opposite things on different
 *      cards — on AMEX 4000 VPAY the DEBIT column INCREASES the balance, on
 *      MASTERCARD 6404 it DECREASES it. So the direction comes from the target
 *      card's own recorded convention, and is shown to the reviewer in words
 *      before anything is imported.
 *   2. It never guesses an ambiguous date silently. 03/04/2026 is either 3 April
 *      or 4 March. The whole column is examined for a value that settles it
 *      (a day past the 12th); if nothing settles it, every affected row is
 *      flagged with its raw text and the reviewer chooses the reading.
 *   3. It never invents a currency. A code outside the known set is carried
 *      through as a warning on the row rather than mapped to a near match.
 *
 * Nothing here writes to the database. It produces rows; the page reviews them;
 * the import calls the same audited create_transaction that the single-entry
 * form uses.
 */

import { unzipSync, strFromU8 } from 'fflate';
import { CURRENCIES } from './currencies';
import type { Card, Transaction } from './types';

/* ------------------------------------------------------------ reading cells */

export interface ParsedSheet {
  name: string;
  /** Every cell as a string, plus dates already resolved to ISO. */
  rows: string[][];
}

/** Excel's serial day zero, with the 1900 leap-year bug it has always carried. */
function serialToIso(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2958465) return null;
  // Serial 60 is Excel's non-existent 29 Feb 1900. Anything at or below it is
  // in the buggy range and is not worth guessing at.
  const days = serial > 60 ? serial - 1 : serial;
  const ms = Math.round((days - 25568) * 86400000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** Number formats Excel builds in that mean "this is a date". */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

function looksLikeDateFormat(code: string): boolean {
  // Strip quoted literals and colour/condition blocks before looking for
  // date tokens, so that a currency format like "d"#,##0 is not misread.
  const bare = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '');
  return /[dmyh]/i.test(bare) && !/^[^a-zA-Z]*$/.test(bare);
}

const tagContents = (xml: string, tag: string): string[] => {
  const out: string[] = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${tag}>)`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1] ?? '');
  return out;
};

const unescapeXml = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');

/** All the text inside <t> elements of one string record, joined. */
const richText = (xml: string) =>
  tagContents(xml, 't')
    .map(unescapeXml)
    .join('');

function colIndex(ref: string): number {
  const letters = ref.replace(/[^A-Z]/gi, '').toUpperCase();
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Parses an .xlsx into plain string grids, one per sheet. */
export function parseXlsx(bytes: Uint8Array): ParsedSheet[] {
  const zip = unzipSync(bytes);
  const text = (path: string): string | null =>
    zip[path] ? strFromU8(zip[path]) : null;

  /* shared strings */
  const sharedXml = text('xl/sharedStrings.xml') ?? '';
  const shared = tagContents(sharedXml, 'si').map(richText);

  /* which style indexes are dates */
  const stylesXml = text('xl/styles.xml') ?? '';
  const customFormats = new Map<number, string>();
  for (const m of stylesXml.matchAll(/<numFmt[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g))
    customFormats.set(Number(m[1]), unescapeXml(m[2]));
  const cellXfsBlock = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? '';
  const dateStyles = new Set<number>();
  let xfIndex = 0;
  for (const m of cellXfsBlock.matchAll(/<xf\b[^>]*>/g)) {
    const id = Number(/numFmtId="(\d+)"/.exec(m[0])?.[1] ?? 0);
    const custom = customFormats.get(id);
    if (BUILTIN_DATE_FORMATS.has(id) || (custom && looksLikeDateFormat(custom)))
      dateStyles.add(xfIndex);
    xfIndex++;
  }

  /* sheet names in workbook order, and the part each one lives in */
  const relsXml = text('xl/_rels/workbook.xml.rels') ?? '';
  const relTargets = new Map<string, string>();
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /Id="([^"]+)"/.exec(m[0])?.[1];
    const target = /Target="([^"]+)"/.exec(m[0])?.[1];
    if (id && target) relTargets.set(id, target.replace(/^\/?xl\//, '').replace(/^\//, ''));
  }
  const workbookXml = text('xl/workbook.xml') ?? '';
  const sheets: { name: string; path: string }[] = [];
  for (const m of workbookXml.matchAll(/<sheet\b[^>]*>/g)) {
    const name = unescapeXml(/name="([^"]*)"/.exec(m[0])?.[1] ?? '');
    const rid = /r:id="([^"]+)"/.exec(m[0])?.[1] ?? '';
    const target = relTargets.get(rid);
    if (target) sheets.push({ name, path: `xl/${target}` });
  }
  // A workbook whose relationships we could not follow still has its sheets on
  // disk in order; fall back to those rather than returning nothing.
  if (!sheets.length) {
    const found = Object.keys(zip)
      .filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p))
      .sort();
    found.forEach((p, i) => sheets.push({ name: `Sheet${i + 1}`, path: p }));
  }

  return sheets.map(({ name, path }) => {
    const xml = text(path) ?? '';
    const rows: string[][] = [];
    // The attribute match is lazy so a self-closing <row/> is recognised. A
    // greedy one eats the closing slash, then keeps reading to the next
    // element's closing tag and silently merges two rows into one.
    for (const rowMatch of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const rowNumber = Number(/r="(\d+)"/.exec(rowMatch[1])?.[1] ?? rows.length + 1);
      const cells: string[] = [];
      // Same reason, and it matters far more here: <c r="D7" s="1"/> is how
      // Excel writes a styled but empty cell, and a sheet holds thousands of
      // them. Merging one into its neighbour shifts every later column, which
      // is how a balance ends up being read as a transaction amount.
      for (const cellMatch of (rowMatch[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cellMatch[1];
        const body = cellMatch[2] ?? '';
        const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1];
        const type = /t="([^"]+)"/.exec(attrs)?.[1] ?? 'n';
        const style = Number(/s="(\d+)"/.exec(attrs)?.[1] ?? -1);
        const raw = /<v[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '';

        let value = '';
        if (type === 's') value = shared[Number(raw)] ?? '';
        else if (type === 'inlineStr') value = richText(body);
        else if (type === 'str') value = unescapeXml(raw);
        else if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
        else if (type === 'e') value = unescapeXml(raw);
        else if (raw !== '') {
          const n = Number(raw);
          // A number carrying a date format is a date, and is resolved here so
          // that no part of the app ever sees a bare serial like 46023.
          value = dateStyles.has(style) && Number.isFinite(n)
            ? (serialToIso(n) ?? raw)
            : raw;
        }

        const i = ref ? colIndex(ref) : cells.length;
        while (cells.length < i) cells.push('');
        cells[i] = value;
      }
      while (rows.length < rowNumber - 1) rows.push([]);
      rows[rowNumber - 1] = cells;
    }
    return { name, rows };
  });
}

/** Splits CSV text, honouring quoted fields and embedded newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export async function readFile(file: File): Promise<ParsedSheet[]> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) {
    return [{ name: file.name.replace(/\.[^.]+$/, ''), rows: parseCsv(await file.text()) }];
  }
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) {
    return parseXlsx(new Uint8Array(await file.arrayBuffer()));
  }
  throw new Error(
    `Cannot read "${file.name}". Save it as .xlsx or .csv — an .xls from before 2007 has to be re-saved first.`,
  );
}

/* ------------------------------------------------------- finding the header */

export type FieldKey =
  | 'date'
  | 'supplier'
  | 'currency'
  | 'original_amount'
  | 'decrease'
  | 'increase'
  | 'signed_amount'
  | 'rate'
  | 'crm'
  | 'account'
  | 'req_number'
  | 'lpo_number'
  | 'invoice'
  | 'payment_ref'
  | 'client'
  | 'sales_operation'
  | 'notes';

export const FIELD_LABELS: Record<FieldKey, string> = {
  date: 'Date',
  supplier: 'Supplier / details',
  currency: 'Original currency',
  original_amount: 'Original amount',
  decrease: 'Amount — decreases the balance',
  increase: 'Amount — increases the balance',
  signed_amount: 'Signed AED amount',
  rate: 'Exchange rate',
  crm: 'CRM',
  account: 'Account',
  req_number: 'Request number',
  lpo_number: 'LPO number',
  invoice: 'Invoice',
  payment_ref: 'Payment reference',
  client: 'Client',
  sales_operation: 'Sales operation',
  notes: 'Notes',
};

/**
 * Header words seen in the real workbook, plus the obvious variants.
 *
 * DEBIT and CREDIT are deliberately absent: which of them decreases a balance
 * is a property of the card, not of the word, so they are resolved separately
 * against the card's own convention.
 */
const ALIASES: { field: FieldKey; patterns: RegExp[] }[] = [
  { field: 'date', patterns: [/^transaction\s*date$/i, /^date$/i, /^txn\s*date$/i, /^value\s*date$/i] },
  {
    field: 'supplier',
    patterns: [/^details?$/i, /^supplier\s*name$/i, /^supplier$/i, /^description$/i, /^narration$/i, /^merchant$/i],
  },
  { field: 'currency', patterns: [/^original\s*currency$/i, /^currency$/i, /^ccy$/i, /^fx\s*currency$/i] },
  { field: 'original_amount', patterns: [/^amount$/i, /^original\s*amount$/i, /^foreign\s*amount$/i] },
  {
    field: 'rate',
    // 'Exchange rate (source)' is what this app's own export calls it, and it
    // has to come back in through this door unchanged.
    patterns: [/^conversion(\s*rate)?$/i, /^exchange\s*rate(\s*\(source\))?$/i, /^rate$/i, /^fx\s*rate$/i],
  },
  { field: 'crm', patterns: [/^crm$/i] },
  { field: 'account', patterns: [/^account$/i] },
  {
    field: 'req_number',
    patterns: [/^req(uest)?\s*(number|no\.?|#)?$/i, /^reference\s*number$/i],
  },
  { field: 'lpo_number', patterns: [/^lpo.*number/i, /^lpo$/i, /^je\s*number$/i] },
  { field: 'invoice', patterns: [/^invoice$/i, /^supplier\s*invoice.*$/i] },
  {
    field: 'payment_ref',
    patterns: [/^payment\s*reference.*$/i, /^payment\s*ref\.?$/i, /^payment\s*made$/i],
  },
  { field: 'client', patterns: [/^client$/i] },
  { field: 'sales_operation', patterns: [/^sales\s*operation$/i] },
  { field: 'notes', patterns: [/^notes?$/i, /^debit\s*notes$/i, /^comments?$/i, /^remarks?$/i, /^commissionable.*$/i] },
  {
    field: 'signed_amount',
    // 'AED settlement' is this app's own export header: one signed column
    // instead of a debit/credit pair, where the sign carries the direction.
    patterns: [/^amount\s*\(aed\)$/i, /^aed$/i, /^aed\s*amount$/i, /^signed\s*amount$/i, /^aed\s*settlement$/i],
  },
];

const DEBIT_RE = /\bdebit\b/i;
const CREDIT_RE = /\bcredit\b/i;
const BALANCE_RE = /\bbalance\b/i;

/** Words that mark a row as the header rather than a transaction. */
const HEADER_HINTS = [
  /\bdate\b/i, /\bdetails?\b/i, /\bsupplier\b/i, /\bdebit\b/i, /\bcredit\b/i,
  /\bbalance\b/i, /\bcurrency\b/i, /\bdescription\b/i, /\bamount\b/i,
  /\breq/i, /\blpo\b/i, /\binvoice\b/i, /\bpayment\b/i, /\bconversion\b/i,
];

/**
 * Finds the header by scoring rows on how many header words they contain —
 * the same approach the audit script takes, and the reason it can read seven
 * sheets whose headers sit on four different rows.
 */
export function detectHeaderRow(rows: string[][]): number {
  let best = -1;
  let bestScore = 0;
  const limit = Math.min(rows.length, 30);
  for (let r = 0; r < limit; r++) {
    const cells = (rows[r] ?? []).map((c) => String(c ?? '').trim()).filter(Boolean);
    if (cells.length < 3) continue;
    let score = 0;
    for (const cell of cells) for (const re of HEADER_HINTS) if (re.test(cell)) score++;
    // A row full of numbers is data, however many words it happens to contain.
    const numeric = cells.filter((c) => c !== '' && Number.isFinite(Number(c))).length;
    score -= numeric;
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return bestScore >= 3 ? best : -1;
}

export type ColumnMapping = Partial<Record<FieldKey, number>>;

/**
 * Finds a date column by what is in it rather than what it is called.
 *
 * AMEX 3024's sheet has an empty cell where its date header should be — the
 * column is full of dates and has no name at all. Reading the values is the
 * only way to find it, and it is a cheap safety net for any file whose header
 * was renamed or translated.
 */
export function findDateColumnByContent(
  rows: string[][],
  headerRow: number,
  skip: Set<number>,
): number | undefined {
  const sample = rows.slice(headerRow + 1, headerRow + 61);
  const width = Math.max(0, ...sample.map((r) => (r ?? []).length));
  let best: number | undefined;
  let bestHits = 0;
  for (let c = 0; c < width; c++) {
    if (skip.has(c)) continue;
    let hits = 0;
    let filled = 0;
    for (const row of sample) {
      const v = String((row ?? [])[c] ?? '').trim();
      if (!v) continue;
      filled++;
      if (parseDate(v, true).iso) hits++;
    }
    // Most of what is there has to be a date, and there has to be enough of it
    // to be sure. A stray reference number that happens to parse is not enough.
    if (filled >= 3 && hits >= filled * 0.8 && hits > bestHits) {
      bestHits = hits;
      best = c;
    }
  }
  return best;
}

export interface MappingResult {
  mapping: ColumnMapping;
  /** Column indexes whose header said DEBIT / CREDIT, in sheet order. */
  debitColumns: number[];
  creditColumns: number[];
  balanceColumns: number[];
  unmapped: number[];
}

/**
 * Matches headers to fields. DEBIT and CREDIT are returned separately so the
 * caller can bind them to increase/decrease using the target card's convention.
 */
export function mapColumns(headers: string[]): MappingResult {
  const mapping: ColumnMapping = {};
  const debitColumns: number[] = [];
  const creditColumns: number[] = [];
  const balanceColumns: number[] = [];
  const unmapped: number[] = [];

  headers.forEach((raw, i) => {
    const h = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (!h) return;
    if (BALANCE_RE.test(h)) {
      balanceColumns.push(i);
      return;
    }
    if (DEBIT_RE.test(h) && !/notes?/i.test(h)) {
      debitColumns.push(i);
      return;
    }
    if (CREDIT_RE.test(h)) {
      creditColumns.push(i);
      return;
    }
    for (const { field, patterns } of ALIASES) {
      if (patterns.some((re) => re.test(h))) {
        // First column wins: the workbook repeats 'DEBIT (AED)' twice on one
        // sheet, and the first is the one its balance formula uses.
        if (mapping[field] === undefined) mapping[field] = i;
        return;
      }
    }
    unmapped.push(i);
  });

  return { mapping, debitColumns, creditColumns, balanceColumns, unmapped };
}

/**
 * Binds the DEBIT/CREDIT columns to increase/decrease using the card's own
 * recorded convention, which was derived from that sheet's balance formula.
 */
export function bindDirectionColumns(
  result: MappingResult,
  card: Card | undefined,
): { mapping: ColumnMapping; note: string } {
  const mapping = { ...result.mapping };
  const debit = result.debitColumns[0];
  const credit = result.creditColumns[0];
  if (debit === undefined && credit === undefined)
    return { mapping, note: 'This file has no DEBIT or CREDIT column.' };

  // The card knows which of its own columns decreases the balance.
  const decreasingIsDebit = card ? DEBIT_RE.test(card.decreasingHeader) : true;
  if (decreasingIsDebit) {
    if (debit !== undefined) mapping.decrease = debit;
    if (credit !== undefined) mapping.increase = credit;
  } else {
    if (credit !== undefined) mapping.decrease = credit;
    if (debit !== undefined) mapping.increase = debit;
  }

  const note = card
    ? `On ${card.name} the ${card.decreasingHeader.trim()} column decreases the balance and ${card.increasingHeader.trim()} increases it — its own formula ${card.balanceFormula} says so. The file is read that way.`
    : 'Choose a card to settle which column decreases the balance.';
  return { mapping, note };
}

export interface SheetAnalysis {
  headerRow: number;
  headers: string[];
  mapping: ColumnMapping;
  /** What the direction of each amount column was decided from. */
  directionNote: string;
  /** True where the date column was found by its contents, not its name. */
  dateFoundByContent: boolean;
  dayFirst: boolean;
  /** The value that settled the day/month order, if one did. */
  dayFirstProof: string | null;
  dayFirstConflict: boolean;
  columns: MappingResult;
}

/**
 * Everything that has to be worked out about a sheet before its rows can be
 * read: where the header is, what each column means, which column decreases
 * the balance, and how to read its dates. Every part of it is shown to the
 * reviewer and every part can be overridden.
 */
export function analyseSheet(sheet: ParsedSheet, card: Card | undefined): SheetAnalysis {
  const headerRow = detectHeaderRow(sheet.rows);
  const headers = headerRow >= 0 ? (sheet.rows[headerRow] ?? []) : [];
  const columns = mapColumns(headers);
  const bound = bindDirectionColumns(columns, card);
  const mapping = bound.mapping;

  let dateFoundByContent = false;
  if (headerRow >= 0 && mapping.date === undefined) {
    const used = new Set<number>([
      ...Object.values(mapping),
      ...columns.balanceColumns,
      ...columns.debitColumns,
      ...columns.creditColumns,
    ] as number[]);
    const found = findDateColumnByContent(sheet.rows, headerRow, used);
    if (found !== undefined) {
      mapping.date = found;
      dateFoundByContent = true;
    }
  }

  const dateValues =
    mapping.date === undefined
      ? []
      : sheet.rows.slice(headerRow + 1).map((r) => (r ?? [])[mapping.date as number] ?? '');
  const { dayFirst, proof, conflict } = inferDayFirst(dateValues);

  return {
    headerRow,
    headers,
    mapping,
    directionNote: bound.note,
    dateFoundByContent,
    dayFirst,
    dayFirstProof: proof,
    dayFirstConflict: conflict,
    columns,
  };
}

/* --------------------------------------------------------------- the values */

export interface ParsedDate {
  iso: string | null;
  raw: string;
  ambiguous: boolean;
  note?: string;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

const isoOf = (y: number, m: number, d: number): string | null => {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  // Rejects 31 February rather than letting it roll into March.
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

/**
 * Reads one date cell. `dayFirst` decides the reading only when the value
 * itself cannot: a first part above 12 proves day-first no matter what.
 */
export function parseDate(raw: string, dayFirst: boolean): ParsedDate {
  const text = String(raw ?? '').trim();
  if (!text) return { iso: null, raw: text, ambiguous: false };

  // Already ISO, including the 'YYYY-MM-DD 00:00:00' the reader produces.
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(text);
  if (iso) {
    return { iso: isoOf(+iso[1], +iso[2], +iso[3]), raw: text, ambiguous: false };
  }

  // A bare serial, for a column Excel never styled as a date.
  if (/^\d+(\.\d+)?$/.test(text)) {
    const n = Number(text);
    if (n > 20000 && n < 60000) {
      return {
        iso: serialToIso(n),
        raw: text,
        ambiguous: false,
        note: 'read as an Excel date serial',
      };
    }
  }

  // 12 Mar 2026 / Mar 12, 2026 — a spelled month is never ambiguous.
  const named = /^(\d{1,2})[\s-]+([a-z]{3,9})[\s-]+(\d{2,4})$/i.exec(text);
  if (named) {
    const m = MONTHS[named[2].toLowerCase().slice(0, 4).replace(/[^a-z]/g, '')] ??
      MONTHS[named[2].toLowerCase().slice(0, 3)];
    if (m) {
      let y = Number(named[3]);
      if (y < 100) y += 2000;
      return { iso: isoOf(y, m, Number(named[1])), raw: text, ambiguous: false };
    }
  }
  const named2 = /^([a-z]{3,9})[\s-]+(\d{1,2}),?[\s-]+(\d{2,4})$/i.exec(text);
  if (named2) {
    const m = MONTHS[named2[1].toLowerCase().slice(0, 3)];
    if (m) {
      let y = Number(named2[3]);
      if (y < 100) y += 2000;
      return { iso: isoOf(y, m, Number(named2[2])), raw: text, ambiguous: false };
    }
  }

  const parts = /^(\d{1,4})[\/.\-](\d{1,2})[\/.\-](\d{1,4})$/.exec(text);
  if (!parts) return { iso: null, raw: text, ambiguous: false };

  let a = Number(parts[1]);
  const b = Number(parts[2]);
  let c = Number(parts[3]);

  // Year first: 2026/03/04.
  if (parts[1].length === 4) return { iso: isoOf(a, b, c), raw: text, ambiguous: false };
  if (c < 100) c += 2000;

  if (a > 12 && b <= 12) return { iso: isoOf(c, b, a), raw: text, ambiguous: false };
  if (b > 12 && a <= 12) return { iso: isoOf(c, a, b), raw: text, ambiguous: false };
  if (a > 12 && b > 12) return { iso: null, raw: text, ambiguous: true, note: 'neither part can be a month' };

  // Both parts are 12 or less: the value itself cannot settle it.
  return {
    iso: dayFirst ? isoOf(c, b, a) : isoOf(c, a, b),
    raw: text,
    ambiguous: true,
    note: dayFirst
      ? `read as ${a} ${['','January','February','March','April','May','June','July','August','September','October','November','December'][b]} — could also be ${b}/${a}`
      : `read as month ${a} day ${b} — could also be ${b}/${a}`,
  };
}

/**
 * Decides the reading for a whole column by looking for one value that proves
 * it. A single 28/01/2026 settles every other row in the column.
 */
export function inferDayFirst(values: string[]): { dayFirst: boolean; proof: string | null; conflict: boolean } {
  let dayProof: string | null = null;
  let monthProof: string | null = null;
  for (const v of values) {
    const m = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-]\d{2,4}$/.exec(String(v ?? '').trim());
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 12 && b <= 12 && !dayProof) dayProof = m[0];
    if (b > 12 && a <= 12 && !monthProof) monthProof = m[0];
  }
  if (dayProof && monthProof)
    return { dayFirst: true, proof: dayProof, conflict: true };
  if (dayProof) return { dayFirst: true, proof: dayProof, conflict: false };
  if (monthProof) return { dayFirst: false, proof: monthProof, conflict: false };
  // Nothing settled it. Day-first matches this workbook and the region, and
  // every affected row is flagged so the reviewer can see what was assumed.
  return { dayFirst: true, proof: null, conflict: false };
}

/** Reads a number out of a cell written by a human: 1,234.56 / (500) / AED 12. */
export function parseAmount(raw: string): number | null {
  let text = String(raw ?? '').trim();
  if (!text) return null;
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  text = text.replace(/[^\d.,\-]/g, '');
  if (!text) return null;
  // 1.234,56 (European) vs 1,234.56 — decided by which separator comes last.
  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  if (lastComma > lastDot) text = text.replace(/\./g, '').replace(',', '.');
  else text = text.replace(/,/g, '');
  const n = Number(text);
  if (!Number.isFinite(n)) return null;
  return negative ? -Math.abs(n) : n;
}

/** 'USD  240' and 'TRY 934000.00' as the workbook writes them. */
export function parseCurrencyCell(raw: string): { code: string | null; amount: number | null; raw: string } {
  const text = String(raw ?? '').trim();
  if (!text) return { code: null, amount: null, raw: text };
  const m = /^([A-Za-z]{3})\b[\s:]*(.*)$/.exec(text);
  if (m) {
    const code = m[1].toUpperCase();
    return { code, amount: parseAmount(m[2]), raw: text };
  }
  if (/^[A-Za-z]{3}$/.test(text)) return { code: text.toUpperCase(), amount: null, raw: text };
  return { code: null, amount: parseAmount(text), raw: text };
}

/* ----------------------------------------------------------- the built rows */

export type RowKind = 'purchase' | 'refund' | 'funding' | 'fee';

export interface ImportRow {
  /** 1-based row number in the source sheet, for tracing back. */
  sourceRow: number;
  include: boolean;
  date: string | null;
  dateRaw: string;
  dateAmbiguous: boolean;
  supplier: string;
  amountAed: number | null;
  kind: RowKind;
  currency: string | null;
  originalAmount: number | null;
  rate: number | null;
  reqNumber: string;
  paymentRef: string;
  lpoNumber: string;
  invoice: string;
  crm: string;
  client: string;
  salesOperation: string;
  notes: string;
  /** Stops the import for this row. */
  errors: string[];
  /** Imported anyway, but the reviewer should see it. */
  warnings: string[];
  /** An existing transaction that looks like this one. */
  duplicateOf?: { id: string; date: string; amount: number; supplier: string };
}

export interface BuildOptions {
  dayFirst: boolean;
  /** Rows already in the ledger, used to spot a re-upload. */
  existing?: Transaction[];
  /** Only rows for this card are compared for duplicates. */
  cardId?: string;
}

const cell = (row: string[], i: number | undefined): string =>
  i === undefined ? '' : String(row[i] ?? '').trim();

export function buildRows(
  sheet: ParsedSheet,
  headerRow: number,
  mapping: ColumnMapping,
  options: BuildOptions,
): ImportRow[] {
  const out: ImportRow[] = [];

  const existingKey = new Map<string, Transaction>();
  for (const t of options.existing ?? []) {
    if (options.cardId && t.cardId !== options.cardId) continue;
    existingKey.set(
      `${t.txn_date}|${Math.abs(t.amount_aed).toFixed(2)}|${(t.supplier ?? t.description ?? '').toLowerCase().trim()}`,
      t,
    );
  }

  for (let r = headerRow + 1; r < sheet.rows.length; r++) {
    const row = sheet.rows[r] ?? [];
    if (!row.some((c) => String(c ?? '').trim())) continue;

    const errors: string[] = [];
    const warnings: string[] = [];

    /* amount and direction */
    const decrease = parseAmount(cell(row, mapping.decrease));
    const increase = parseAmount(cell(row, mapping.increase));
    const signed = parseAmount(cell(row, mapping.signed_amount));

    let amountAed: number | null = null;
    let kind: RowKind = 'purchase';
    if (decrease !== null && increase !== null && decrease !== 0 && increase !== 0) {
      errors.push('This row has an amount in both the decreasing and the increasing column.');
    } else if (decrease !== null && decrease !== 0) {
      amountAed = Math.abs(decrease);
      kind = 'purchase';
    } else if (increase !== null && increase !== 0) {
      amountAed = Math.abs(increase);
      kind = 'refund';
    } else if (signed !== null && signed !== 0) {
      amountAed = Math.abs(signed);
      kind = signed < 0 ? 'purchase' : 'refund';
    }

    const supplier = cell(row, mapping.supplier);
    const dateRaw = cell(row, mapping.date);

    // Rows that are not transactions: a spacer, a section label, a totals line.
    // The test is the date. Every transaction in every sheet of this workbook
    // has one, so a row without a date and without a single clear amount is
    // furniture and is passed over silently. A row that HAS a date is always
    // evaluated, so a real transaction missing its figure is still reported
    // rather than quietly dropped — that is the direction the error should
    // fall in.
    const hasDate = Boolean(dateRaw);
    const bothAmounts =
      decrease !== null && increase !== null && decrease !== 0 && increase !== 0;
    if (!hasDate && (amountAed === null || bothAmounts)) continue;
    if (amountAed === null && !supplier) continue;
    if (amountAed === null) errors.push('No amount in either amount column.');
    else if (amountAed === 0) errors.push('The amount is zero.');

    const parsed = parseDate(dateRaw, options.dayFirst);
    if (!parsed.iso) errors.push(dateRaw ? `Cannot read the date "${dateRaw}".` : 'No date.');
    else if (parsed.ambiguous)
      warnings.push(`Date "${parsed.raw}" is ambiguous — ${parsed.note ?? 'day and month could be either way round'}.`);
    else if (parsed.note) warnings.push(`Date ${parsed.note}.`);

    if (!supplier) errors.push('No supplier or description.');

    /* currency, original amount, rate */
    const currencyCell = parseCurrencyCell(cell(row, mapping.currency));
    let currency = currencyCell.code;
    let originalAmount = currencyCell.amount;
    const explicitOriginal = parseAmount(cell(row, mapping.original_amount));
    if (explicitOriginal !== null) originalAmount = explicitOriginal;
    const rate = parseAmount(cell(row, mapping.rate));

    let carriedNote = '';
    if (currency && !(currency in CURRENCIES)) {
      // The code is dropped rather than mapped to a near match, and the figure
      // that went with it has to go too: an original amount with no currency is
      // a number that means nothing, and the database rightly refuses one. The
      // cell is kept verbatim in the row's notes so the information reaches the
      // reviewer instead of disappearing.
      warnings.push(
        `"${currency}" is not one of the known currencies. The AED amount is imported and flagged` +
          ` for review; the original figure is kept in the notes rather than converted.`,
      );
      carriedNote = `original currency cell: "${currencyCell.raw}"`;
      currency = null;
      originalAmount = null;
    }
    if (currency && currency !== 'AED' && originalAmount === null)
      warnings.push(`${currency} has no original amount in this file.`);
    if (currency === 'AED') {
      // An AED row carries no conversion; the database refuses one anyway.
      currency = null;
      originalAmount = null;
    }

    const built: ImportRow = {
      sourceRow: r + 1,
      include: errors.length === 0,
      date: parsed.iso,
      dateRaw: parsed.raw,
      dateAmbiguous: parsed.ambiguous,
      supplier,
      amountAed,
      kind,
      currency,
      originalAmount,
      rate: currency ? rate : null,
      reqNumber: cell(row, mapping.req_number),
      paymentRef: cell(row, mapping.payment_ref),
      lpoNumber: cell(row, mapping.lpo_number),
      invoice: cell(row, mapping.invoice),
      crm: cell(row, mapping.crm) || cell(row, mapping.account),
      client: cell(row, mapping.client),
      salesOperation: cell(row, mapping.sales_operation),
      notes: [cell(row, mapping.notes), carriedNote].filter(Boolean).join(' — '),
      errors,
      warnings,
    };

    if (built.date && built.amountAed !== null) {
      const hit = existingKey.get(
        `${built.date}|${built.amountAed.toFixed(2)}|${supplier.toLowerCase().trim()}`,
      );
      if (hit) {
        built.duplicateOf = {
          id: hit.id,
          date: hit.txn_date ?? '',
          amount: hit.amount_aed,
          supplier: hit.supplier ?? hit.description ?? '',
        };
        built.warnings.push('This looks like a transaction already in the ledger.');
        // Left out by default. Importing it is one click, if it really is a
        // second identical charge on the same day.
        built.include = false;
      }
    }

    out.push(built);
  }

  // A file re-uploaded with itself: two identical rows inside the same file.
  const seen = new Map<string, number>();
  for (const row of out) {
    if (!row.date || row.amountAed === null) continue;
    const key = `${row.date}|${row.amountAed.toFixed(2)}|${row.supplier.toLowerCase()}`;
    const prior = seen.get(key);
    if (prior !== undefined)
      row.warnings.push(`Identical to row ${prior} of this file.`);
    else seen.set(key, row.sourceRow);
  }

  return out;
}
