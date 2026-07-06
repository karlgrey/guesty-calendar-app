import { describe, it, expect } from 'vitest';
import { getPropertiesByProvider } from './properties.js';

describe('hostex properties vaultNote mapping', () => {
  it('both hostex properties carry a vaultNote pointing at their vault file', () => {
    const hostex = getPropertiesByProvider('hostex');
    const bySlug = Object.fromEntries(hostex.map((p) => [p.slug, p.vaultNote]));
    expect(bySlug['bootshaus-alte-oder']).toBe('Gästekommunikation Bootshaus.md');
    expect(bySlug['alte-schilderwerkstatt']).toBe('Gästekommunikation Alte Schilderwerkstatt.md');
  });
});
