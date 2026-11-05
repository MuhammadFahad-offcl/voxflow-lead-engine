/**
 * Unit tests of phone and website normalization.
 *
 * Serves: FR-6, PRD "Lead scoring model" (mobile_number), issue #10.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { describe, expect, it } from '@jest/globals';
import { normalizePhone, normalizeUrl } from './normalize.js';

// Proves every shape a listing writes a Pakistani mobile in ends as one +923… E.164 number (FR-6).
describe('normalizePhone: mobiles', () => {
  it.each([
    ['0300-1234567'],
    ['+92 300 1234567'],
    ['0300 1234567'],
    ['(0300) 1234567'],
    ['00923001234567'],
    ['923001234567'],
    ['3001234567'],
    ['۰۳۰۰۱۲۳۴۵۶۷'],
  ])('reads %s as the mobile +923001234567', (raw) => {
    expect(normalizePhone(raw)).toEqual({ e164: '+923001234567', type: 'MOBILE' });
  });

  it('accepts the fictional numbers the fixtures use', () => {
    expect(normalizePhone('+923000000001')).toEqual({ e164: '+923000000001', type: 'MOBILE' });
  });
});

// Proves a landline or service number never earns the 12-point mobile_number signal by mistake.
describe('normalizePhone: numbers that are not mobiles', () => {
  it.each([
    ['042 35123456', '+924235123456'],
    ['042-35123456', '+924235123456'],
    ['+92 42 35123456', '+924235123456'],
    // Karachi and Islamabad: the digit after the area code must not be read as a mobile prefix.
    ['021 34567890', '+922134567890'],
    ['051 2345678', '+92512345678'],
  ])('reads %s as the landline %s', (raw, e164) => {
    expect(normalizePhone(raw)).toEqual({ e164, type: 'LANDLINE' });
  });

  it('keeps a UAN number but does not call it a mobile or a landline', () => {
    expect(normalizePhone('042 111 222 333')).toEqual({ e164: '+9242111222333', type: 'UNKNOWN' });
  });

  it('keeps a toll-free number but does not call it a mobile or a landline', () => {
    expect(normalizePhone('0800 12345')).toEqual({ e164: '+9280012345', type: 'UNKNOWN' });
  });
});

// Proves a listing with several numbers gives its mobile, else its first valid one (FR-6).
describe('normalizePhone: several numbers in one listing', () => {
  it.each([
    ['0300-1234567 - 0321-7654321', '+923001234567'],
    ['0300 1234567 or 0321 7654321', '+923001234567'],
    ['0300 1234567 OR 0321 7654321', '+923001234567'],
    ['042-35123456, 0300-1234567', '+923001234567'],
    ['042-35123456 - 0300-1234567', '+923001234567'],
    ['042 35123456 or 0300 1234567', '+923001234567'],
    ['042 111 222 333 / 0300-1234567', '+923001234567'],
  ])('takes the first mobile of %s', (raw, e164) => {
    expect(normalizePhone(raw)).toEqual({ e164, type: 'MOBILE' });
  });

  it('keeps the first valid number when none is a mobile', () => {
    expect(normalizePhone('042 35123456 or 042 35123457')).toEqual({
      e164: '+924235123456',
      type: 'LANDLINE',
    });
  });

  it('reads a spaced dash inside one number as one number', () => {
    expect(normalizePhone('0300 - 1234567')).toEqual({ e164: '+923001234567', type: 'MOBILE' });
  });
});

// Proves bad input gives "no phone" rather than a wrong number the caller would dial (FR-6).
describe('normalizePhone: junk', () => {
  it.each([
    [''],
    ['   '],
    ['N/A'],
    ['call us'],
    ['12345'],
    ['0300-12345678'],
    ['0300-123456'],
    ['0000000000'],
    // A UAN needs its area code; without one it cannot be dialled.
    ['111 222 333'],
  ])('finds no phone in %j', (raw) => {
    expect(normalizePhone(raw)).toEqual({ e164: null, type: 'UNKNOWN' });
  });

  it('takes the first number of a listing that gives several', () => {
    expect(normalizePhone('0300-1234567 / 0321-7654321').e164).toBe('+923001234567');
    expect(normalizePhone('0300-1234567, 0321-7654321').e164).toBe('+923001234567');
  });

  it('skips a broken first number when a later one is valid', () => {
    expect(normalizePhone('N/A / 0321-7654321').e164).toBe('+923217654321');
  });

  it('refuses a valid foreign number, because stored phones are +92 only', () => {
    expect(normalizePhone('+1 212 555 0100')).toEqual({ e164: null, type: 'UNKNOWN' });
    expect(normalizePhone('+44 20 7946 0000')).toEqual({ e164: null, type: 'UNKNOWN' });
  });
});

// Proves one clinic always gets one canonical https address, whatever the listing wrote (FR-6).
describe('normalizeUrl: canonical form', () => {
  it.each([
    ['https://example.com', 'https://example.com'],
    ['https://example.com/', 'https://example.com'],
    ['http://example.com/', 'https://example.com'],
    ['HTTP://EXAMPLE.COM/', 'https://example.com'],
    ['example.com', 'https://example.com'],
    ['www.example.com/', 'https://www.example.com'],
    ['//example.com/clinic', 'https://example.com/clinic'],
    ['  https://example.com/  ', 'https://example.com'],
    ['https://example.com/clinic/', 'https://example.com/clinic'],
    ['https://example.com/clinic//', 'https://example.com/clinic'],
    ['https://example.com/Clinic', 'https://example.com/Clinic'],
    ['example.com:8443/clinic', 'https://example.com:8443/clinic'],
    ['https://example.com/#contact', 'https://example.com'],
  ])('turns %s into %s', (raw, expected) => {
    expect(normalizeUrl(raw)).toBe(expected);
  });
});

// Proves tracking noise goes and real query parameters stay, so two listings of one site match.
describe('normalizeUrl: query parameters', () => {
  it.each([
    ['https://example.com/?utm_source=gmb&utm_medium=organic', 'https://example.com'],
    ['https://example.com/?UTM_Campaign=x', 'https://example.com'],
    ['https://example.com/a?gclid=1&fbclid=2&msclkid=3', 'https://example.com/a'],
    ['https://example.com/a?page=2&utm_source=gmb', 'https://example.com/a?page=2'],
    ['https://example.com/?page=2', 'https://example.com?page=2'],
  ])('turns %s into %s', (raw, expected) => {
    expect(normalizeUrl(raw)).toBe(expected);
  });
});

// Proves the enrich step is never handed something that is not a public website (FR-9).
describe('normalizeUrl: junk', () => {
  it.each([
    [''],
    ['   '],
    ['N/A'],
    ['not a url'],
    ['localhost'],
    ['http://localhost:4000/admin'],
    ['http://127.0.0.1:4000/admin'],
    ['https://192.168.1.1'],
    ['http://[::1]/'],
    ['foo.localhost'],
    ['https://router.local/admin'],
    ['https://db.internal'],
    ['printer.lan'],
    ['https://127.0.0.1.nip.io:4000'],
    ['https://127.0.0.1.sslip.io:4000'],
    ['ftp://example.com'],
    ['file:///etc/hosts'],
    ['mailto:clinic@example.com'],
    ['tel:+923000000001'],
    ['javascript:alert(1)'],
    ['https://user:secret@example.com'],
  ])('finds no website in %j', (raw) => {
    expect(normalizeUrl(raw)).toBeNull();
  });
});
