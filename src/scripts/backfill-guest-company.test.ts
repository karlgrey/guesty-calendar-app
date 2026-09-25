import { describe, it, expect, vi } from 'vitest';
import { runBackfill } from './backfill-guest-company.js';

/**
 * #729 (Fall momox): reines Deps-Mock — kein echter Guesty-Call, keine echte
 * DB. Ausführung des Skripts selbst (main()) ist NICHT Teil dieses Tests
 * (Spec-Präzisierung: nur schreiben + gegen Mock testen, nicht ausführen).
 */

function deps(overrides: Partial<Parameters<typeof runBackfill>[0]> = {}) {
  return {
    listDistinctGuestIds: vi.fn().mockReturnValue(['guest-1', 'guest-2']),
    getGuestCompany: vi.fn().mockResolvedValue('momox SE'),
    updateGuestCompany: vi.fn().mockReturnValue(2),
    log: vi.fn(),
    ...overrides,
  };
}

describe('runBackfill (#729)', () => {
  it('schreibt company für jede guest_id, die eine liefert', async () => {
    const d = deps();
    const results = await runBackfill(d, { dryRun: false });

    expect(d.updateGuestCompany).toHaveBeenCalledTimes(2);
    expect(d.updateGuestCompany).toHaveBeenCalledWith('guest-1', 'momox SE');
    expect(d.updateGuestCompany).toHaveBeenCalledWith('guest-2', 'momox SE');
    expect(results).toEqual([
      { guestId: 'guest-1', company: 'momox SE', reservationsUpdated: 2, skipped: false },
      { guestId: 'guest-2', company: 'momox SE', reservationsUpdated: 2, skipped: false },
    ]);
  });

  it('--dry-run schreibt NICHT (updateGuestCompany wird nicht gerufen)', async () => {
    const d = deps();
    const results = await runBackfill(d, { dryRun: true });

    expect(d.updateGuestCompany).not.toHaveBeenCalled();
    expect(results.every((r) => r.reservationsUpdated === 0)).toBe(true);
    expect(results[0].company).toBe('momox SE');
  });

  it('überspringt guest_ids ohne company bei Guesty (lässt lokalen Bestand unangetastet)', async () => {
    const d = deps({ getGuestCompany: vi.fn().mockResolvedValue(null) });
    const results = await runBackfill(d, { dryRun: false });

    expect(d.updateGuestCompany).not.toHaveBeenCalled();
    expect(results.every((r) => r.skipped)).toBe(true);
    expect(results.every((r) => r.company === null)).toBe(true);
  });

  it('--limit N verarbeitet nur die ersten N guest_ids', async () => {
    const d = deps({ listDistinctGuestIds: vi.fn().mockReturnValue(['guest-1', 'guest-2', 'guest-3']) });
    const results = await runBackfill(d, { dryRun: false, limit: 1 });

    expect(results).toHaveLength(1);
    expect(results[0].guestId).toBe('guest-1');
    expect(d.getGuestCompany).toHaveBeenCalledTimes(1);
  });

  it('ein Fehler bei einer guest_id (z. B. Guesty 404) bricht den Lauf nicht ab', async () => {
    const getGuestCompany = vi.fn()
      .mockRejectedValueOnce(new Error('Guesty API error: 404 Not Found'))
      .mockResolvedValueOnce('momox SE');
    const d = deps({ getGuestCompany });
    const results = await runBackfill(d, { dryRun: false });

    expect(results[0]).toMatchObject({ guestId: 'guest-1', error: 'Guesty API error: 404 Not Found' });
    expect(results[1]).toMatchObject({ guestId: 'guest-2', company: 'momox SE', reservationsUpdated: 2 });
  });
});
