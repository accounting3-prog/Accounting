/**
 * The currencies this ledger accepts.
 *
 * The list lives in the database and is loaded with the ledger. It used to be
 * written out here as well, which meant every new currency needed a code change
 * and a deploy, and meant two lists that could disagree — the dangerous
 * direction being a code the database knows and this file does not, because the
 * importer then calls it unrecognised, drops it, and carries the original
 * amount off into a note while the AED settles correctly. Quietly wrong.
 *
 * It is still a CLOSED set, and that is the point. A code outside it is reported
 * as unrecognised rather than mapped to a best guess. Accepting whatever is
 * typed sounds friendlier until GPB is entered once beside GBP's hundred-odd
 * rows: two currencies in the report, both looking equally real, nothing
 * flagged. The set is now all of ISO 4217, so a genuine currency is always
 * known and a typo still is not.
 *
 * The values below are the fallback for a session with no database — the sample
 * a signed-out visitor sees. They are the 28 the audited workbook contained.
 */

interface CurrencyInfo {
  name: string;
  minor: number;
}

const FALLBACK: Record<string, CurrencyInfo> = {
  AED: { name: 'UAE Dirham', minor: 2 },
  USD: { name: 'US Dollar', minor: 2 },
  EUR: { name: 'Euro', minor: 2 },
  GBP: { name: 'Pound Sterling', minor: 2 },
  SAR: { name: 'Saudi Riyal', minor: 2 },
  JPY: { name: 'Japanese Yen', minor: 0 },
  EGP: { name: 'Egyptian Pound', minor: 2 },
  CHF: { name: 'Swiss Franc', minor: 2 },
  TRY: { name: 'Turkish Lira', minor: 2 },
  OMR: { name: 'Omani Rial', minor: 3 },
  QAR: { name: 'Qatari Riyal', minor: 2 },
  BHD: { name: 'Bahraini Dinar', minor: 3 },
  KRW: { name: 'South Korean Won', minor: 0 },
  MYR: { name: 'Malaysian Ringgit', minor: 2 },
  SGD: { name: 'Singapore Dollar', minor: 2 },
  KWD: { name: 'Kuwaiti Dinar', minor: 3 },
  VND: { name: 'Vietnamese Dong', minor: 0 },
  HKD: { name: 'Hong Kong Dollar', minor: 2 },
  MOP: { name: 'Macanese Pataca', minor: 2 },
  JOD: { name: 'Jordanian Dinar', minor: 3 },
  INR: { name: 'Indian Rupee', minor: 2 },
  ZAR: { name: 'South African Rand', minor: 2 },
  MAD: { name: 'Moroccan Dirham', minor: 2 },
  SEK: { name: 'Swedish Krona', minor: 2 },
  CZK: { name: 'Czech Koruna', minor: 2 },
  MUR: { name: 'Mauritian Rupee', minor: 2 },
  CAD: { name: 'Canadian Dollar', minor: 2 },
  NZD: { name: 'New Zealand Dollar', minor: 2 },
};

/** Replaced when the ledger loads; the fallback until then. */
let live: Record<string, CurrencyInfo> = { ...FALLBACK };

/**
 * Takes the list from the database.
 *
 * Refuses an empty or unreadable list rather than replacing a working set with
 * nothing — a failed fetch must not turn every currency in the app into an
 * unrecognised one.
 */
export function setCurrencies(
  rows: { code: string; name: string; minor_units: number }[] | null | undefined,
): void {
  if (!rows?.length) return;
  const next: Record<string, CurrencyInfo> = {};
  for (const r of rows) {
    const code = String(r.code ?? '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) continue;
    next[code] = { name: String(r.name ?? code), minor: Number(r.minor_units ?? 2) };
  }
  if (Object.keys(next).length) live = next;
}

/** Everything currently accepted, in alphabetical order. */
export function currencyCodes(): string[] {
  return Object.keys(live).sort();
}

/** How many currencies are known — for telling someone why a code was refused. */
export function currencyCount(): number {
  return Object.keys(live).length;
}

export function isKnownCurrency(code: string | undefined | null): boolean {
  return !!code && code.toUpperCase() in live;
}

export function currencyName(code: string | undefined | null): string {
  if (!code) return '';
  return live[code.toUpperCase()]?.name ?? code;
}

export function currencyMinorUnits(code: string | undefined | null): number {
  if (!code) return 2;
  return live[code.toUpperCase()]?.minor ?? 2;
}
