/**
 * Airbnb-Mail Staleness Check (#327)
 *
 * DB + config wiring around the pure `findStaleAirbnbMailSources()`. Logs an
 * ERROR per stale property so pm2 log-monitoring catches it — the existing
 * per-run WARN in sync-mail.ts (a single failed poll) drowns in hourly ETL
 * noise, which is exactly how Florence's broken IMAP login stood unnoticed
 * for ~10 weeks. This check runs independently of whether today's poll
 * succeeded — it looks at how long it's been since the LAST successful one.
 */
import { config } from '../../config/index.js';
import { getPropertiesByProvider } from '../../config/properties.js';
import { getLastSyncAt } from '../../repositories/airbnb-mail-archive-repository.js';
import { findStaleAirbnbMailSources, type StaleAirbnbMailSource } from '../../services/airbnb-mail-staleness.js';
import logger from '../../utils/logger.js';

export function checkAirbnbMailStaleness(now: Date = new Date()): StaleAirbnbMailSource[] {
  const properties = getPropertiesByProvider('airbnb-mail');
  const thresholdHours = config.airbnbMailStalenessThresholdHours;

  const lastSyncAtBySlug = new Map(properties.map((p) => [p.slug, getLastSyncAt(p.slug)]));
  const stale = findStaleAirbnbMailSources(properties, lastSyncAtBySlug, now, thresholdHours);

  for (const source of stale) {
    logger.error(
      {
        propertySlug: source.slug,
        propertyName: source.name,
        hoursSinceSync: source.hoursSinceSync,
        thresholdHours,
      },
      source.hoursSinceSync === null
        ? `🚨 Airbnb-Mail sync stale for ${source.name} — never synced successfully. Check AIRBNB_MAIL_* env-vars / IMAP login.`
        : `🚨 Airbnb-Mail sync stale for ${source.name} — last successful poll ${source.hoursSinceSync}h ago (threshold ${thresholdHours}h). Check IMAP login.`
    );
  }

  return stale;
}
