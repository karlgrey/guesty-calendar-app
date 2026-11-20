/**
 * Einmaliger Import der Report-Empfänger aus properties.json in die DB (#1223) plus Seeds.
 * Marker in scheduler_state verhindert jede Wiederholung — spätere Änderungen im Dashboard
 * (/admin/reporting) bleiben damit erhalten.
 */
import { getDatabase } from '../../db/index.js';
import { getAllProperties, getBiReportConfig, type BiReportConfig, type PropertyConfig } from '../../config/properties.js';
import { getSchedulerState, setSchedulerState } from '../../repositories/scheduler-state-repository.js';
import { addRecipient, listRecipients, normalizeEmail, setSubscription } from '../../repositories/report-recipient-repository.js';
import logger from '../../utils/logger.js';

export const BOOTSTRAP_MARKER_KEY = 'report_recipients_bootstrap_v1';

export interface BootstrapResult {
  ran: boolean;
  imported: number;
  seeds: string[];
}

const localPart = (email: string): string => email.split('@')[0].toLowerCase();

export function bootstrapReportRecipients(
  properties: PropertyConfig[] = getAllProperties(),
  biReport: BiReportConfig | undefined = getBiReportConfig()
): BootstrapResult {
  if (getSchedulerState(BOOTSTRAP_MARKER_KEY) !== null) {
    return { ran: false, imported: 0, seeds: [] };
  }

  const db = getDatabase();
  const tx = db.transaction((): BootstrapResult => {
    const seeds: string[] = [];
    const emails = new Map<string, number>(); // normalisierte Adresse -> id, in Auftretensreihenfolge

    const ensure = (raw: string): number => {
      const email = normalizeEmail(raw);
      let id = emails.get(email);
      if (id === undefined) {
        id = addRecipient(email).id;
        emails.set(email, id);
      }
      return id;
    };

    for (const p of properties) {
      for (const raw of p.weeklyReport?.recipients ?? []) {
        setSubscription(ensure(raw), 'weekly-summary', p.slug, true);
      }
    }
    for (const raw of biReport?.recipients ?? []) {
      setSubscription(ensure(raw), 'portfolio-weekly', '', true);
    }

    /** Eindeutige Adresse zu einem Local-Part; sonst Warnung und undefined. */
    const find = (name: string): { email: string; id: number } | undefined => {
      const hits = [...emails.entries()].filter(([email]) => localPart(email) === name);
      if (hits.length !== 1) {
        logger.warn(
          { name, treffer: hits.map(([e]) => e) },
          hits.length === 0
            ? `Report-Bootstrap: Seed für "${name}" übersprungen (Adresse nicht gefunden)`
            : `Report-Bootstrap: Seed für "${name}" übersprungen (mehrdeutig)`
        );
        return undefined;
      }
      return { email: hits[0][0], id: hits[0][1] };
    };

    const christian = find('christian');
    if (christian) {
      for (const p of properties) {
        const has = listRecipients()
          .find((r) => r.id === christian.id)
          ?.subscriptions.some((s) => s.reportType === 'weekly-summary' && s.propertySlug === p.slug);
        if (has) setSubscription(christian.id, 'weekly-summary', p.slug, false);
      }
      setSubscription(christian.id, 'portfolio-weekly', '', false);
      for (const r of listRecipients()) {
        if (r.id !== christian.id && r.subscriptions.some((s) => s.reportType === 'portfolio-monthly' && s.active)) {
          setSubscription(r.id, 'portfolio-monthly', '', false);
        }
      }
      setSubscription(christian.id, 'portfolio-monthly', '', true);
      seeds.push(`portfolio-monthly: ${christian.email}`);
      seeds.push(`${christian.email}: weekly-summary (alle Objekte) und portfolio-weekly deaktiviert`);
    }

    for (const name of ['holger', 'ulf', 'angela']) {
      const hit = find(name);
      if (hit) {
        // je Objekt (#1284): genau dort, wo die Adresse ein aktives weekly-summary-Abo hat
        const slugs = (listRecipients().find((r) => r.id === hit.id)?.subscriptions ?? [])
          .filter((s) => s.reportType === 'weekly-summary' && s.active)
          .map((s) => s.propertySlug);
        for (const slug of slugs) setSubscription(hit.id, 'calendar-weekly', slug, true);
        seeds.push(`calendar-weekly: ${hit.email} (${slugs.join(', ')})`);
      }
    }

    setSchedulerState(BOOTSTRAP_MARKER_KEY, new Date().toISOString());
    return { ran: true, imported: emails.size, seeds };
  });

  const result = tx();
  logger.info({ imported: result.imported, seeds: result.seeds }, 'Report-Empfänger einmalig importiert und geseedet (#1223)');
  return result;
}
