/**
 * The bank accounts, written out as the reconciliation sheet they are kept in.
 *
 * Not a ledger export with the bank's rows in it — the hand-kept SAB sheet
 * itself, one tab per month per account, in the form the sheet already has:
 *
 *     row 1   DATE | describtion | DEBIT | CREDIT | BALANCE | Record @ Zoho
 *             System | Customer | REQ | Operation
 *     row 2   the opening balance, alone in BALANCE
 *     row 3…  one line per bank line, BALANCE carried down by formula
 *
 * The styles are the template's own, copied from the file (sabTemplate.ts),
 * so the fonts, borders, column widths and the green fill are the sheet's
 * rather than an approximation of it. The header keeps the sheet's spelling,
 * "describtion " and its trailing space included: anything that reads these
 * sheets by their headings should find them where it always has.
 *
 * Three things are decided here rather than copied, and each is said where it
 * is done:
 *
 *   - the order of the lines, which is the bank's, not the calendar's
 *   - which amounts are green, which follows the rule the sheet was coloured by
 *   - the number format on the euro and dollar tabs, which says EUR and USD
 *     where the template only ever had to say SAR
 */

import { strToU8, zipSync } from 'fflate';
import { SAB_TEMPLATE_STYLES, SAB_TEMPLATE_THEME } from './sabTemplate';
import type { Card, Transaction } from './types';

/* ------------------------------------------------------------- the order */

/**
 * The lines of one account in the order the bank printed them.
 *
 * Not date order. A day holds many lines and the date cannot say which came
 * first; and the sheets themselves sometimes list a later day above an
 * earlier one. What can say is the running balance the bank printed beside
 * each line: in the right order, every balance is the one before it plus this
 * line's amount.
 *
 * So the lines are taken a source file at a time — each monthly sheet, each
 * statement — and each file is walked in whichever direction its own
 * arithmetic holds. The bank's statements list the newest line first; the
 * monthly sheet lists the oldest first; neither is assumed. Files are then
 * placed by the earliest day each one covers.
 *
 * A line with no printed balance cannot be placed this way. It goes after the
 * last placed line on or before its own date, and the test that checks this
 * export reports how many there were.
 */
export function bankOrder(rows: Transaction[]): Transaction[] {
  const chained = rows.filter((t) => t.statement_balance != null);
  const loose = rows.filter((t) => t.statement_balance == null);

  const bySheet = new Map<string, Transaction[]>();
  for (const t of chained) {
    const key = t.source_sheet ?? '';
    const list = bySheet.get(key) ?? [];
    list.push(t);
    bySheet.set(key, list);
  }

  const holds = (seq: Transaction[]): number =>
    seq.reduce(
      (n, t, i) =>
        i > 0 &&
        Math.abs(Number(t.statement_balance) - (Number(seq[i - 1].statement_balance) + t.amount_aed)) < 0.005
          ? n + 1
          : n,
      0,
    );

  const blocks = [...bySheet.values()].map((list) => {
    const forward = list.slice().sort((a, b) => (a.source_row ?? 0) - (b.source_row ?? 0));
    const backward = forward.slice().reverse();
    const ordered = holds(backward) > holds(forward) ? backward : forward;
    const earliest = ordered.reduce(
      (d, t) => (t.txn_date && (!d || t.txn_date < d) ? t.txn_date : d),
      '',
    );
    return { earliest, name: ordered[0]?.source_sheet ?? '', ordered };
  });
  blocks.sort((a, b) => a.earliest.localeCompare(b.earliest) || a.name.localeCompare(b.name));

  const out = blocks.flatMap((b) => b.ordered);
  for (const t of loose.slice().sort((a, b) => String(a.txn_date).localeCompare(String(b.txn_date)))) {
    let at = out.length;
    while (at > 0 && String(out[at - 1].txn_date) > String(t.txn_date)) at--;
    out.splice(at, 0, t);
  }
  return out;
}

/* ------------------------------------------------------------ the styles */

/**
 * Style numbers in the template, by what they are used for. Read off the
 * September sheet cell by cell, not guessed from how it looks.
 */
const XF = {
  date: 1, //        d-mmm, bold, medium border
  text: 2, //        bold 10, wrapped
  zoho: 4, //        centred, wrapped
  ref: 5, //         bold 12, centred — the request number
  // per-currency, filled in below; these four are the SAR ones
  plain: 3, //       accounting format, no fill
  opening: 6, //     red, bold, accounting underline
  green: 7, //       accounting format, green fill
  balance: 8, //     bold 10, the running balance
};

interface CurrencyStyles {
  plain: number;
  opening: number;
  green: number;
  balance: number;
}

/**
 * The template's styles, with a set of amount styles for each currency other
 * than SAR.
 *
 * The template only ever held riyals, so its money format is hard-coded to
 * print "SAR". Used on the euro tab it would print SAR beside euros — the
 * mistake this ledger has already made once and removed at the root. Each
 * other currency gets the same four styles with its own code in the format,
 * cloned from the SAR ones so nothing else about them can drift.
 */
function stylesFor(currencies: string[]): { xml: string; byCurrency: Map<string, CurrencyStyles> } {
  let xml = SAB_TEMPLATE_STYLES;
  const byCurrency = new Map<string, CurrencyStyles>();
  byCurrency.set('SAR', {
    plain: XF.plain, opening: XF.opening, green: XF.green, balance: XF.balance,
  });

  const others = currencies.filter((c) => c !== 'SAR');
  if (!others.length) return { xml, byCurrency };

  const sarFormat = /<numFmt numFmtId="164" formatCode="([^"]*)"\/>/.exec(xml)?.[1];
  if (!sarFormat) throw new Error('The template no longer carries its SAR number format.');

  const cellXfs = /<cellXfs count="(\d+)">([\s\S]*?)<\/cellXfs>/.exec(xml);
  if (!cellXfs) throw new Error('The template no longer carries its cell styles.');
  const existing = cellXfs[2].split(/(?=<xf )/).filter((s) => s.startsWith('<xf '));
  let next = existing.length;

  const formats: string[] = [];
  const added: string[] = [];
  others.forEach((code, i) => {
    const id = 165 + i;
    formats.push(`<numFmt numFmtId="${id}" formatCode="${sarFormat.split('[$SAR]').join(`[$${code}]`)}"/>`);
    const clone = (index: number) => {
      added.push(existing[index].replace('numFmtId="164"', `numFmtId="${id}"`));
      return next++;
    };
    byCurrency.set(code, {
      plain: clone(XF.plain),
      opening: clone(XF.opening),
      green: clone(XF.green),
      balance: clone(XF.balance),
    });
  });

  xml = xml.replace(/<numFmts count="(\d+)">([\s\S]*?)<\/numFmts>/, (_, n: string, body: string) =>
    `<numFmts count="${Number(n) + formats.length}">${body}${formats.join('')}</numFmts>`,
  );
  xml = xml.replace(
    cellXfs[0],
    `<cellXfs count="${next}">${cellXfs[2]}${added.join('')}</cellXfs>`,
  );
  return { xml, byCurrency };
}

/* ------------------------------------------------------------ one sheet */

const HEADERS = [
  'DATE', 'describtion ', 'DEBIT', 'CREDIT', 'BALANCE',
  'Record @ Zoho System', 'Customer', 'REQ', 'Operation',
];

/** Column widths, exactly as the template sets them. */
const WIDTHS = [
  11.44140625, 34.33203125, 16.33203125, 25.44140625, 16.33203125,
  25.44140625, 56.88671875, 9.44140625, 34.33203125,
];

const COLS = 'ABCDEFGHI';

const escapeXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Days since 30 December 1899 — how Excel stores a date. */
const excelDate = (iso: string): number => {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
};

/**
 * What the importer wrote when the sheet had no description at all. It is the
 * ledger's note about a blank cell, not the cell; the cell was blank.
 */
const PLACEHOLDER = /^\(no description on the .* sheet, row \d+\)$/;

/**
 * The Record @ Zoho System text. The year import kept it as a note —
 * "sheet note: done" — rather than promote a workflow status to a request
 * number it is not. It goes back in its own column here.
 */
const zohoOf = (notes: string | null | undefined): string =>
  /sheet note: (.*?)(?: — |$)/.exec(String(notes ?? ''))?.[1]?.trim() ?? '';

const isBac = (ref: string): boolean => /^bac$/i.test(ref.trim());

/**
 * Whether an amount is green, by the rule the September sheet was coloured by:
 * money that came in, and money that went out against a real request number.
 * White is what is still open — a payment with nothing beside it, or a bank
 * charge. Measured over that sheet: 251 of its 253 lines follow this rule; the
 * two that do not are a payment left white with its number filled in, and one
 * coloured with none.
 */
const isGreen = (t: Transaction): boolean => {
  if (t.amount_aed > 0) return true;
  const ref = String(t.req_number ?? '').trim();
  return ref !== '' && !isBac(ref);
};

const cell = (ref: string, style: number, body = '', attrs = ''): string =>
  body ? `<c r="${ref}" s="${style}"${attrs}>${body}</c>` : `<c r="${ref}" s="${style}"/>`;

const text = (ref: string, style: number, value: string): string =>
  value
    ? `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`
    : `<c r="${ref}" s="${style}"/>`;

const num = (n: number): string => String(Math.round(n * 100) / 100);

const ROW = (r: number, cells: string) =>
  `<row r="${r}" ht="16.5" customHeight="1" thickBot="1">${cells}</row>`;

export interface MonthSheet {
  name: string;
  card: Card;
  month: string;
  opening: number;
  closing: number;
  rows: Transaction[];
}

function sheetXml(sheet: MonthSheet, st: CurrencyStyles, selected: boolean): string {
  const header = HEADERS.map((h, i) => {
    const style = [XF.date, XF.text, st.plain, st.plain, st.plain, XF.zoho, XF.ref, XF.date, XF.text][i];
    return text(`${COLS[i]}1`, style, h);
  }).join('');

  // Row 2 is the opening balance and nothing else, the way the sheet has it.
  const openingRow =
    cell('E2', st.opening, `<v>${num(sheet.opening)}</v>`) +
    cell('F2', XF.zoho) + cell('G2', XF.ref) + cell('H2', XF.date) + cell('I2', XF.text);

  let running = sheet.opening;
  const lines = sheet.rows.map((t, i) => {
    const r = i + 3;
    running += t.amount_aed;
    const out = t.amount_aed < 0;
    const amount = Math.abs(t.amount_aed);
    const fill = isGreen(t) ? st.green : st.plain;
    const description = PLACEHOLDER.test(String(t.supplier_raw ?? '')) ? '' : String(t.supplier_raw ?? '');
    return ROW(
      r,
      cell(`A${r}`, XF.date, t.txn_date ? `<v>${excelDate(t.txn_date)}</v>` : '') +
        text(`B${r}`, XF.text, description) +
        (out ? cell(`C${r}`, fill, `<v>${num(amount)}</v>`) : cell(`C${r}`, st.plain)) +
        (out ? cell(`D${r}`, st.plain) : cell(`D${r}`, fill, `<v>${num(amount)}</v>`)) +
        // A formula, as in the sheet: the balance is the one above it plus
        // what came in less what went out. The value beside it is the same
        // sum, so the file reads correctly before Excel recalculates it.
        cell(`E${r}`, st.balance, `<f>E${r - 1}+D${r}-C${r}</f><v>${num(running)}</v>`) +
        text(`F${r}`, XF.zoho, zohoOf(t.notes)) +
        text(`G${r}`, XF.ref, String(t.req_number ?? '').trim()) +
        cell(`H${r}`, XF.date) +
        cell(`I${r}`, XF.text),
    );
  });

  const last = sheet.rows.length + 2;
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<dimension ref="A1:I${last}"/>` +
    `<sheetViews><sheetView${selected ? ' tabSelected="1"' : ''} workbookViewId="0"/></sheetViews>` +
    '<sheetFormatPr defaultColWidth="8.88671875" defaultRowHeight="16.2" thickBottom="1"/>' +
    '<cols>' +
    WIDTHS.map((w, i) => {
      const style = [XF.date, XF.text, st.plain, st.plain, st.plain, XF.zoho, XF.ref, XF.date, XF.text][i];
      return `<col min="${i + 1}" max="${i + 1}" width="${w}" style="${style}" customWidth="1"/>`;
    }).join('') +
    '</cols>' +
    `<sheetData>${ROW(1, header)}${ROW(2, openingRow)}${lines.join('')}</sheetData>` +
    '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
    '</worksheet>'
  );
}

/* ------------------------------------------------------------ the months */

/**
 * Every account, cut into calendar months, each with the balance it opened at.
 *
 * The opening of a month is the account's opening balance plus every line
 * dated before the month — the same figure the Transactions screen shows for
 * that month, and the same one the bank's own balance implies. Each month's
 * closing is therefore the next month's opening; the test that checks this
 * export holds it to that.
 */
export function monthSheets(cards: Card[], transactions: Transaction[]): MonthSheet[] {
  const sheets: MonthSheet[] = [];
  const currencyCount = new Map<string, number>();
  for (const c of cards) currencyCount.set(c.settlementCurrency, (currencyCount.get(c.settlementCurrency) ?? 0) + 1);

  for (const card of cards) {
    const rows = bankOrder(
      transactions.filter((t) => t.cardId === card.id && t.status !== 'voided' && t.txn_date),
    );
    const months = [...new Set(rows.map((t) => String(t.txn_date).slice(0, 7)))].sort();
    // Named by month and currency. Where two accounts share a currency the
    // account's own reference is added, so no tab can be mistaken for another.
    const label =
      (currencyCount.get(card.settlementCurrency) ?? 0) > 1
        ? `${card.settlementCurrency} ${card.name.replace(/[^0-9]/g, '').slice(-4)}`
        : card.settlementCurrency;

    for (const month of months) {
      const opening = rows
        .filter((t) => String(t.txn_date) < `${month}-01`)
        .reduce((sum, t) => sum + t.amount_aed, card.openingBalance);
      const inMonth = rows.filter((t) => String(t.txn_date).startsWith(month));
      const closing = inMonth.reduce((sum, t) => sum + t.amount_aed, opening);
      const [y, m] = month.split('-');
      sheets.push({
        name: `${m}-${y} ${label}`.slice(0, 31),
        card, month,
        opening: Math.round(opening * 100) / 100,
        closing: Math.round(closing * 100) / 100,
        rows: inMonth,
      });
    }
  }
  return sheets;
}

/* ----------------------------------------------------------- the package */

export function buildBankWorkbook(cards: Card[], transactions: Transaction[]): Uint8Array {
  const sheets = monthSheets(cards, transactions);
  if (!sheets.length) throw new Error('There are no bank lines to write out.');

  // The file opens on the latest month of the first account — the one being
  // reconciled now. That tab is both the active one and the only selected one:
  // a tab selected without being active is grouped with the active tab, and
  // anything typed into one of a group is typed into all of them.
  const first = sheets[0].card.id;
  const active = sheets.reduce((at, s, i) => (s.card.id === first ? i : at), 0);

  const currencies = [...new Set(cards.map((c) => c.settlementCurrency))];
  const { xml: styles, byCurrency } = stylesFor(currencies);

  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        sheets
          .map(
            (_, i) =>
              `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
          )
          .join('') +
        '<Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '</Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    ),
    'xl/workbook.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<bookViews><workbookView activeTab="${active}"/></bookViews>` +
        '<sheets>' +
        sheets
          .map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
          .join('') +
        '</sheets>' +
        // Recalculated on opening, so the balances are Excel's own sums of the
        // lines above them, not only the figures written beside the formulas.
        '<calcPr calcId="191029" fullCalcOnLoad="1"/>' +
        '</workbook>',
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets
          .map(
            (_, i) =>
              `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
          )
          .join('') +
        `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>` +
        `<Relationship Id="rId${sheets.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        '</Relationships>',
    ),
    'xl/styles.xml': strToU8(styles),
    'xl/theme/theme1.xml': strToU8(SAB_TEMPLATE_THEME),
  };

  sheets.forEach((s, i) => {
    const st = byCurrency.get(s.card.settlementCurrency);
    if (!st) throw new Error(`No styles were made for ${s.card.settlementCurrency}.`);
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(s, st, i === active));
  });

  return zipSync(files, { level: 6 });
}
