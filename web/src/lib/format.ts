/**
 * Formatting helpers.
 *
 * One rule governs everything here: an amount is never shown without the
 * currency it is denominated in, and amounts in different currencies are never
 * summed. `formatMoney` therefore always takes a currency, and there is
 * deliberately no helper that totals a mixed-currency list.
 */

import type { Currency } from './currencies';
import { minorUnits } from './currencies';

/** AED, the settlement currency every card balance is denominated in. */
export const BASE_CURRENCY = 'AED';

export function formatMoney(
  amount: number | null | undefined,
  currency: string = BASE_CURRENCY,
  opts: { signed?: boolean; withCode?: boolean } = {},
): string {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return '—';
  const digits = minorUnits(currency as Currency);
  const abs = Math.abs(amount).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  const sign = opts.signed ? (amount < 0 ? '−' : amount > 0 ? '+' : '') : amount < 0 ? '−' : '';
  const code = opts.withCode === false ? '' : ` ${currency}`;
  return `${sign}${abs}${code}`;
}

/** Bare number, no currency code — for use beside an explicit currency column. */
export function formatAmount(
  amount: number | null | undefined,
  currency: string = BASE_CURRENCY,
  signed = false,
): string {
  return formatMoney(amount, currency, { signed, withCode: false });
}

/** An exchange rate: AED per one unit of the foreign currency. */
export function formatRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined) return '—';
  // Rates range from 0.000038 (VND) to 263 (unknown), so significant digits
  // matter more than a fixed scale.
  if (rate !== 0 && Math.abs(rate) < 0.01) return rate.toPrecision(4);
  return rate.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** ISO date to '14 Aug 2026'. Parsed as calendar parts, never through Date(),
 *  so a date never shifts by a day because of the viewer's timezone. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const m = iso.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

/** Short form for dense tables: '14 Aug 26'. */
export function formatDateShort(iso: string | null | undefined): string {
  if (!iso) return '—';
  const m = iso.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1].slice(2)}`;
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

/** Sentence-case a snake_case status or kind for display. */
export function humanise(value: string): string {
  return value
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}

/** Today, as an ISO date in the viewer's own calendar. */
export function todayISO(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
