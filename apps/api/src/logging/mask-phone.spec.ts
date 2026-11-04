/**
 * Unit tests of phone masking.
 *
 * Serves: CLAUDE.md Security ("mask to last 4"), NFR-6, NFR-10.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { describe, expect, it } from '@jest/globals';
import { maskPhone } from './mask-phone.js';

const digitCount = (text: string): number => text.replaceAll(/\D/g, '').length;

// Proves no log line can show more of a phone number than the mask allows, whatever its shape.
describe('maskPhone', () => {
  it('masks the prompt example exactly', () => {
    expect(maskPhone('+923001234567')).toBe('+92*******4567');
  });

  it('drops spaces and dashes before masking', () => {
    expect(maskPhone('+92 300 123-4567')).toBe('+92*******4567');
  });

  it('keeps the shape of a local number without a plus', () => {
    expect(maskPhone('03001234567')).toBe('03*******4567');
  });

  it('shows only the last 4 digits of an 8- or 9-digit number', () => {
    expect(maskPhone('42123456')).toBe('*******3456');
    expect(maskPhone('+421234567')).toBe('+*******4567');
  });

  it('shows no digits of a number shorter than 8 digits', () => {
    expect(maskPhone('1234567')).toBe('*******');
    expect(maskPhone('+92')).toBe('*******');
  });

  it('returns an empty string when there are no digits', () => {
    expect(maskPhone('')).toBe('');
    expect(maskPhone('not a phone')).toBe('');
  });

  it('uses the same 7-star middle for numbers of different lengths', () => {
    expect(maskPhone('+9230012345678')).toBe('+92*******5678');
  });

  it('never shows more than 6 digits, even for very long or malformed input', () => {
    const inputs = ['+92300123456789012345', '(0300) 12x34y567', '++9230012345678', '1'.repeat(40)];

    for (const input of inputs) {
      expect(digitCount(maskPhone(input))).toBeLessThanOrEqual(6);
    }
  });
});
