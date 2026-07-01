import { describe, it, expect } from 'vitest';
import { getPropertiesByProvider } from './properties.js';

describe('hostex properties vaultNote mapping', () => {
  it('both hostex properties carry a vaultNote pointing at their vault file', () => {
    const hostex = getPropertiesByProvider('hostex');
    const bySlug = Object.fromEntries(hostex.map((p) => [p.slug, p.vaultNote]));
    expect(bySlug['bootshaus-alte-oder']).toBe('Bootshaus.md');
    expect(bySlug['alte-schilderwerkstatt']).toBe('Alte-Schilderwerkstatt.md');
  });
});
