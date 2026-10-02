import { describe, it, expect } from 'vitest';
import { getPropertyBySlug } from './properties.js';

describe('blocksNextDayOnLateCheckout (#799)', () => {
  it('nur Farmhouse blockt den Folgetag', () => {
    expect(getPropertyBySlug('farmhouse')?.blocksNextDayOnLateCheckout).toBe(true);
    for (const slug of ['u19', 'alte-schilderwerkstatt', 'bootshaus-alte-oder', 'firenze-loft']) {
      expect(getPropertyBySlug(slug)?.blocksNextDayOnLateCheckout).toBeFalsy();
    }
  });
});
