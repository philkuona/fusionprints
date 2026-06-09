/**
 * Phone number normalization and validation for Zimbabwean mobile networks.
 *
 * EcoCash is run by EcoNet, so EcoCash payments require an EcoNet number.
 * EcoNet prefixes (after country code 263): 77, 78
 * NetOne prefixes: 71, 73, 74
 * Telecel prefixes: 73 (some), 75 (legacy)
 */

import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

export type ZimNetwork = 'econet' | 'netone' | 'telecel' | 'unknown';

/**
 * Normalise ANY phone number to E.164 (+<country><number>), for contact /
 * WhatsApp-notification use — FusionPrints serves diaspora/international
 * customers, not only Zimbabwe.
 *
 * A bare local number (e.g. "077..." or "771...") is interpreted using
 * `defaultCountry` (Zimbabwe by default, our main market). A number already in
 * international form ("+1...", "+44...") keeps its own country.
 *
 * Returns null if it isn't a valid phone number for any country.
 *
 * NB: This is distinct from normalizeZimMobile / isEcocashCapable below, which
 * stay Zimbabwe-only because EcoCash genuinely requires a Zim EcoNet number.
 */
export function normalizePhone(input: string, defaultCountry: CountryCode = 'ZW'): string | null {
  if (!input || !input.trim()) return null;
  try {
    const parsed = parsePhoneNumberFromString(input.trim(), defaultCountry);
    return parsed && parsed.isValid() ? parsed.number : null;
  } catch {
    return null;
  }
}

/**
 * Normalize a Zim mobile number to E.164 format (+263XXXXXXXXX).
 * Accepts:
 *   - 0771234567
 *   - 263771234567
 *   - +263771234567
 *   - 077 123 4567
 *   - 077-123-4567
 *
 * Returns null if the input doesn't look like a Zim mobile number.
 */
export function normalizeZimMobile(input: string): string | null {
  // Strip everything except digits and a leading +
  const cleaned = input.replace(/[\s\-()]/g, '').trim();
  let digits = cleaned.replace(/^\+/, '');

  // Strip 263 prefix if present
  if (digits.startsWith('263')) {
    digits = digits.slice(3);
  } else if (digits.startsWith('0')) {
    // Local format: 077... — strip leading 0
    digits = digits.slice(1);
  }

  // After normalization, we should have 9 digits starting with 7
  if (!/^7\d{8}$/.test(digits)) {
    return null;
  }

  return `+263${digits}`;
}

/**
 * Identify which Zim mobile network a normalized number belongs to.
 * Pass a number already normalized via normalizeZimMobile.
 */
export function identifyNetwork(normalizedNumber: string): ZimNetwork {
  // Number is +263XXXXXXXXX — strip prefix and check first 2 digits
  const local = normalizedNumber.replace(/^\+263/, '');
  const prefix = local.slice(0, 2);

  if (prefix === '77' || prefix === '78') return 'econet';
  if (prefix === '71' || prefix === '73' || prefix === '74') return 'netone';
  if (prefix === '75') return 'telecel';
  return 'unknown';
}

/**
 * Check if a number is a valid EcoNet (and therefore EcoCash-capable) number.
 */
export function isEcocashCapable(input: string): { ok: true; number: string } | { ok: false; reason: 'invalid_format' | 'wrong_network' } {
  const normalized = normalizeZimMobile(input);
  if (!normalized) return { ok: false, reason: 'invalid_format' };
  if (identifyNetwork(normalized) !== 'econet') return { ok: false, reason: 'wrong_network' };
  return { ok: true, number: normalized };
}
