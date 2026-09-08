/**
 * parseAmount, against the shapes a spreadsheet actually produces.
 *
 * The one that mattered: Excel writes a small number in scientific notation, so
 * an exchange rate of 0.0763635527485667 arrives as "7.6363552748566696E-2".
 * The parser stripped every character that was not a digit, dot, comma or
 * minus — which took the E with it — and returned null. The row lost its rate,
 * the database refused it, and a Turkish visa charge went missing from a
 * balance. It only ever shows on currencies worth a fraction of a dirham.
 *
 *   IMPORT_BUNDLE=/tmp/importFile.mjs node scripts/export/parse_amount_test.mjs
 */

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const { parseAmount } = await import(
  pathToFileURL(resolve(process.env.IMPORT_BUNDLE ?? 'web/src/lib/importFile.ts')).href
);

let failures = 0;
const near = (a, b) => a !== null && Math.abs(a - b) < 1e-12;
const check = (input, expected) => {
  const got = parseAmount(input);
  const ok = expected === null ? got === null : near(got, expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${JSON.stringify(input).padEnd(26)} -> ${got}` +
              (ok ? '' : `   expected ${expected}`));
};

console.log('scientific notation, as Excel stores small numbers');
check('7.6363552748566696E-2', 0.0763635527485667);
check('7.6363552748566696e-2', 0.0763635527485667);
check('1.5E-5', 0.000015);
check('2.5E+3', 2500);
check('2.5E3', 2500);
check('-3.25E-2', -0.0325);

console.log('\nthe ordinary shapes, which must not have changed');
check('4.97955', 4.97955);
check('1,234.56', 1234.56);
check('1.234,56', 1234.56);
check('(500)', -500);
check('AED 1,000.00', 1000);
check('  42  ', 42);
check('', null);
check('   ', null);
check('not a number', null);

// These fall through to the ordinary path and read exactly as they always did.
// Asserted so the new branch is proved NOT to have widened the net: a stray E
// must not start being treated as an exponent.
console.log('\nstrings with an E that are not exponents — unchanged by the fix');
check('1E', 1);              // strips to "1"
check('E-2', -2);            // strips to "-2"
check('REQ-2026E-14', null); // strips to "-2026-14", which is not a number
check('1.5E-5X', null);      // a trailing letter, so not an exponent; strips to "1.5-5"

console.log('');
if (failures) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log('parseAmount reads every shape the sheets produce.');
