/**
 * Backfill Guest Company (#729, Fall momox)
 *
 * Guestys Kalender-API (blockRefs[].reservation.guest) liefert kein company-
 * Feld (siehe Typ-Kommentar in src/types/guesty.ts) — reguläre Syncs rufen
 * daher bewusst KEIN guestyClient.getGuest je Reservierung (Rate-Limit).
 * Dieses Skript holt die Firma EINMALIG je eindeutiger guest_id nach
 * (guestyClient.getGuest, /guests-crud/:id) und schreibt sie über
 * updateGuestCompanyByGuestId in reservations.guest_company für alle
 * Reservierungen dieses Gasts.
 *
 * Liefert Guesty für eine guest_id kein company, bleibt der lokale Bestand
 * unverändert (kein Überschreiben eines evtl. bereits per Namens-Fingerprint
 * erkannten Werts mit NULL) — das Skript ist ein additiver Nachtrag, kein
 * Reset.
 *
 * Usage:
 *   npx tsx src/scripts/backfill-guest-company.ts --dry-run [--limit N]
 *   npx tsx src/scripts/backfill-guest-company.ts --apply [--limit N]
 *
 * Sicher erneut ausführbar (idempotent) — verarbeitet bei jedem Lauf wieder
 * alle guest_ids mit mindestens einer Reservierung.
 */

import { initDatabase, getDatabase } from '../db/index.js';
import { guestyClient } from '../services/guesty-client.js';
import { updateGuestCompanyByGuestId } from '../repositories/reservation-repository.js';
import logger from '../utils/logger.js';

export interface BackfillDeps {
  listDistinctGuestIds: () => string[];
  getGuestCompany: (guestId: string) => Promise<string | null>;
  updateGuestCompany: (guestId: string, company: string) => number;
  log?: (line: string) => void;
}

export interface BackfillResult {
  guestId: string;
  company: string | null;
  reservationsUpdated: number;
  skipped: boolean;
  error?: string;
}

/**
 * Pure(ish) core — alle I/O kommt über injizierte Deps rein, damit sich der
 * Ablauf gegen Mocks testen lässt, ohne echte Guesty-Calls/DB zu brauchen.
 */
export async function runBackfill(
  deps: BackfillDeps,
  options: { dryRun: boolean; limit?: number }
): Promise<BackfillResult[]> {
  const log = deps.log ?? (() => {});
  const allGuestIds = deps.listDistinctGuestIds();
  const guestIds = typeof options.limit === 'number' ? allGuestIds.slice(0, options.limit) : allGuestIds;

  log(`${guestIds.length} eindeutige guest_id(s) zu verarbeiten (von ${allGuestIds.length} insgesamt).`);

  const results: BackfillResult[] = [];

  for (const guestId of guestIds) {
    try {
      const company = await deps.getGuestCompany(guestId);

      if (company === null) {
        results.push({ guestId, company: null, reservationsUpdated: 0, skipped: true });
        log(`[SKIP] guest_id=${guestId}: kein company bei Guesty — Bestand bleibt unverändert`);
        continue;
      }

      if (options.dryRun) {
        results.push({ guestId, company, reservationsUpdated: 0, skipped: false });
        log(`[DRY] guest_id=${guestId} company="${company}" → würde geschrieben`);
        continue;
      }

      const updated = deps.updateGuestCompany(guestId, company);
      results.push({ guestId, company, reservationsUpdated: updated, skipped: false });
      log(`[APPLY] guest_id=${guestId} company="${company}" → ${updated} Reservierung(en) aktualisiert`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      results.push({ guestId, company: null, reservationsUpdated: 0, skipped: false, error: message });
      log(`[FEHLER] guest_id=${guestId}: ${message}`);
    }
  }

  return results;
}

function listDistinctGuestIdsFromDb(): string[] {
  const db = getDatabase();
  const rows = db
    .prepare(`SELECT DISTINCT guest_id FROM reservations WHERE guest_id IS NOT NULL ORDER BY guest_id ASC`)
    .all() as Array<{ guest_id: string }>;
  return rows.map((r) => r.guest_id);
}

async function getGuestCompanyFromGuesty(guestId: string): Promise<string | null> {
  const guest = await guestyClient.getGuest(guestId);
  const company = guest.company?.trim();
  return company ? company : null;
}

function parseArgs(argv: string[]): { dryRun: boolean; apply: boolean; limit?: number } {
  const dryRun = argv.includes('--dry-run');
  const apply = argv.includes('--apply');
  const limitIdx = argv.indexOf('--limit');
  const limit = limitIdx !== -1 ? parseInt(argv[limitIdx + 1], 10) : undefined;
  return { dryRun, apply, limit: Number.isFinite(limit) ? limit : undefined };
}

async function main(): Promise<void> {
  const { dryRun, apply, limit } = parseArgs(process.argv.slice(2));

  if (!dryRun && !apply) {
    console.error('Usage: backfill-guest-company.ts --dry-run | --apply [--limit N]');
    process.exit(1);
  }

  initDatabase();

  const results = await runBackfill(
    {
      listDistinctGuestIds: listDistinctGuestIdsFromDb,
      getGuestCompany: getGuestCompanyFromGuesty,
      updateGuestCompany: updateGuestCompanyByGuestId,
      log: (line) => console.log(line),
    },
    { dryRun, limit }
  );

  const errors = results.filter((r) => r.error);
  const skipped = results.filter((r) => r.skipped);
  const written = results.filter((r) => !r.skipped && !r.error);

  console.log('');
  console.log(
    `${dryRun ? 'DRY-RUN' : 'APPLIED'}: ${results.length} guest_id(s) verarbeitet — ` +
      `${written.length} mit company, ${skipped.length} ohne company übersprungen, ${errors.length} Fehler.`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    logger.error({ error }, 'Backfill guest company failed');
    process.exit(1);
  });
}
