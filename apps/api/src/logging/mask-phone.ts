/**
 * Masks a phone number before it is logged.
 *
 * Serves: CLAUDE.md Security ("mask to last 4"), NFR-6 (privacy), NFR-10.
 * Used by: every log line that mentions a phone number (first caller: the lead source, #10).
 */

// Fewer digits than this and the number is too short for its last 4 to be safe to show.
const MIN_DIGITS_FOR_LAST_FOUR = 8;
// From this length the first two digits are a country or network code, not part of the subscriber.
const MIN_DIGITS_FOR_PREFIX = 10;
// Fixed width, as in the prompt's example, so the mask does not reveal how long the number is.
const MASK = '*******';

/**
 * Hides all but the last 4 digits of a phone number, keeping a leading `+` and the 2-digit prefix
 * of full-length numbers: `maskPhone("+923001234567")` returns `"+92*******4567"`.
 *
 * Does not validate the number: spaces, dashes and brackets are dropped and other characters are
 * ignored. The output never shows more than 6 digits (2 + 4), only the last 4 for numbers of 8 or
 * 9 digits, and none for shorter ones. The middle is always 7 stars, whatever its real length.
 * @param phone - Phone number in any format.
 * @returns The masked number; `""` when the input has no digits.
 */
export function maskPhone(phone: string): string {
  const digits = phone.replaceAll(/\D/g, '');
  if (digits.length === 0) return '';
  if (digits.length < MIN_DIGITS_FOR_LAST_FOUR) return MASK;
  const plus = phone.trimStart().startsWith('+') ? '+' : '';
  const prefix = digits.length < MIN_DIGITS_FOR_PREFIX ? '' : digits.slice(0, 2);
  return `${plus}${prefix}${MASK}${digits.slice(-4)}`;
}
