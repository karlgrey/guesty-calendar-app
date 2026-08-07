/**
 * Airbnb-Mail Staleness Detection (#327)
 *
 * #324 fixed the WEDGE (one bad mail permanently stuck a property's UID
 * progress). This closes the remaining gap: the sync can still silently stop
 * working (e.g. a broken IMAP login) without wedging anything — nothing
 * flagged that no successful poll had happened in a long time. That's what
 * let Florence's sync stand still, unnoticed, for ~10 weeks.
 *
 * Pure, fully-testable core. The DB read + logging side-effects live in
 * `src/jobs/airbnb-mail/check-staleness.ts`.
 */
import type { PropertyConfig } from '../config/properties.js';

export const DEFAULT_STALENESS_THRESHOLD_HOURS = 26;

export interface StaleAirbnbMailSource {
  slug: string;
  name: string;
  /** Hours since the last successful sync, or null if it never synced at all. */
  hoursSinceSync: number | null;
}

/**
 * SQLite's `datetime('now')` produces `YYYY-MM-DD HH:MM:SS` — UTC, but WITHOUT
 * a timezone marker. `new Date(...)` on a string like that is parsed as LOCAL
 * time by JS engines (unlike the same string with a `T` separator), which
 * would silently skew the staleness math by the server's UTC offset. Force it
 * to be read as UTC.
 */
function parseSqliteUtcDatetime(value: string): Date {
  // Already carries an explicit timezone marker (e.g. `...Z` or `...+02:00`) — trust it.
  if (/Z$|[+-]\d{2}:\d{2}$/.test(value)) return new Date(value);
  // Bare "YYYY-MM-DD HH:MM:SS" (SQLite's `datetime('now')`) or "YYYY-MM-DDTHH:MM:SS" —
  // both are UTC wall-clock values without a marker. Normalize to ISO + Z.
  return new Date(`${value.replace(' ', 'T')}Z`);
}

/**
 * Properties with `provider === 'airbnb-mail'` whose last successful sync is
 * older than `thresholdHours` (or never happened at all). Properties on any
 * other provider are ignored — they have no airbnb-mail sync channel.
 */
export function findStaleAirbnbMailSources(
  properties: Pick<PropertyConfig, 'slug' | 'name' | 'provider'>[],
  lastSyncAtBySlug: ReadonlyMap<string, string | null>,
  now: Date,
  thresholdHours: number = DEFAULT_STALENESS_THRESHOLD_HOURS
): StaleAirbnbMailSource[] {
  const stale: StaleAirbnbMailSource[] = [];

  for (const property of properties) {
    if (property.provider !== 'airbnb-mail') continue;

    const lastSyncAt = lastSyncAtBySlug.get(property.slug) ?? null;

    if (lastSyncAt === null) {
      stale.push({ slug: property.slug, name: property.name, hoursSinceSync: null });
      continue;
    }

    const hoursSinceSync = (now.getTime() - parseSqliteUtcDatetime(lastSyncAt).getTime()) / (1000 * 60 * 60);
    if (hoursSinceSync >= thresholdHours) {
      stale.push({ slug: property.slug, name: property.name, hoursSinceSync: Math.round(hoursSinceSync * 10) / 10 });
    }
  }

  return stale;
}
