/**
 * The 28 currencies present in the audited workbook.
 *
 * This is a closed set, mirroring the `currencies` table. A code outside it is
 * shown as unrecognised rather than mapped to a best guess — a wrong currency
 * in a financial report is worse than a blank one.
 */

export const CURRENCIES = {
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
} as const;

export type Currency = keyof typeof CURRENCIES;

export const CURRENCY_CODES = Object.keys(CURRENCIES) as Currency[];

export function isKnownCurrency(code: string | undefined | null): code is Currency {
  return !!code && code in CURRENCIES;
}

export function currencyName(code: string | undefined | null): string {
  return isKnownCurrency(code) ? CURRENCIES[code].name : 'Unrecognised';
}

export function minorUnits(code: string | undefined | null): number {
  return isKnownCurrency(code) ? CURRENCIES[code].minor : 2;
}
