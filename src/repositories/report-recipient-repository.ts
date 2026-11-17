/**
 * Report-Empfänger (#1223, Migration 041).
 *
 * report_recipients = Mailadressen, report_subscriptions = Häkchen der Matrix im
 * Admin-UI (/admin/reporting). Alle Report-Jobs lesen ihre Empfänger bei jedem Versand
 * frisch über getActiveRecipientEmails() — eine Änderung im Dashboard wirkt damit beim
 * nächsten Versand ohne Neustart.
 */
import { getDatabase } from '../db/index.js';
import { DatabaseError, ValidationError } from '../utils/errors.js';
import logger from '../utils/logger.js';
import { isPerPropertyReportType, type ReportType } from '../services/reporting/report-types.js';

export interface ReportRecipient {
  id: number;
  email: string;
  created_at: string;
}

export interface ReportSubscription {
  reportType: ReportType;
  propertySlug: string; // '' bei objektübergreifenden Reports
  active: boolean;
}

export interface ReportRecipientWithSubscriptions extends ReportRecipient {
  subscriptions: ReportSubscription[];
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Objekt-Typen brauchen einen Slug, objektübergreifende speichern immer ''. */
function slugFor(reportType: ReportType, propertySlug: string | null | undefined): string {
  if (isPerPropertyReportType(reportType)) {
    if (!propertySlug) throw new ValidationError(`Report-Typ ${reportType} braucht einen Objekt-Slug`);
    return propertySlug;
  }
  return '';
}

function wrap<T>(what: string, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    logger.error({ error }, `Report recipients: ${what} failed`);
    throw new DatabaseError(`${what} failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/** Aktive Empfänger eines Reports (bei weekly-summary: des Objekts), in Anlage-Reihenfolge. */
export function getActiveRecipientEmails(reportType: ReportType, propertySlug?: string | null): string[] {
  const slug = slugFor(reportType, propertySlug);
  return wrap('getActiveRecipientEmails', () => {
    const rows = getDatabase()
      .prepare(
        `SELECT r.email FROM report_subscriptions s
         JOIN report_recipients r ON r.id = s.recipient_id
         WHERE s.report_type = ? AND s.property_slug = ? AND s.active = 1
         ORDER BY r.id ASC`
      )
      .all(reportType, slug) as Array<{ email: string }>;
    return rows.map((r) => r.email);
  });
}

/** Legt einen Empfänger an; existiert die Adresse schon, wird der bestehende geliefert. */
export function addRecipient(email: string): ReportRecipient {
  const normalized = normalizeEmail(email);
  return wrap('addRecipient', () => {
    const db = getDatabase();
    db.prepare(`INSERT INTO report_recipients (email) VALUES (?) ON CONFLICT(email) DO NOTHING`).run(normalized);
    return db.prepare(`SELECT id, email, created_at FROM report_recipients WHERE email = ?`).get(normalized) as ReportRecipient;
  });
}

export function getRecipientById(id: number): ReportRecipient | undefined {
  return wrap('getRecipientById', () =>
    getDatabase().prepare(`SELECT id, email, created_at FROM report_recipients WHERE id = ?`).get(id) as
      | ReportRecipient
      | undefined
  );
}

/** Entfernt einen Empfänger samt aller Häkchen. true, wenn es ihn gab. */
export function removeRecipient(id: number): boolean {
  return wrap('removeRecipient', () => {
    const db = getDatabase();
    const tx = db.transaction(() => {
      db.prepare(`DELETE FROM report_subscriptions WHERE recipient_id = ?`).run(id);
      return db.prepare(`DELETE FROM report_recipients WHERE id = ?`).run(id).changes > 0;
    });
    return tx();
  });
}

/** Setzt bzw. entfernt ein Häkchen (Upsert). */
export function setSubscription(
  recipientId: number,
  reportType: ReportType,
  propertySlug: string | null | undefined,
  active: boolean
): void {
  const slug = slugFor(reportType, propertySlug);
  wrap('setSubscription', () => {
    if (!getRecipientById(recipientId)) throw new ValidationError(`Unbekannter Empfänger ${recipientId}`);
    getDatabase()
      .prepare(
        `INSERT INTO report_subscriptions (recipient_id, report_type, property_slug, active, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(recipient_id, report_type, property_slug) DO UPDATE SET
           active = excluded.active,
           updated_at = excluded.updated_at`
      )
      .run(recipientId, reportType, slug, active ? 1 : 0);
  });
}

/** Alle Empfänger mit ihren Häkchen (für die Matrix), Empfänger in Anlage-Reihenfolge. */
export function listRecipients(): ReportRecipientWithSubscriptions[] {
  return wrap('listRecipients', () => {
    const db = getDatabase();
    const recipients = db
      .prepare(`SELECT id, email, created_at FROM report_recipients ORDER BY id ASC`)
      .all() as ReportRecipient[];
    const subs = db
      .prepare(
        `SELECT recipient_id, report_type, property_slug, active FROM report_subscriptions
         ORDER BY recipient_id ASC, report_type ASC, property_slug ASC`
      )
      .all() as Array<{ recipient_id: number; report_type: ReportType; property_slug: string; active: number }>;
    return recipients.map((r) => ({
      ...r,
      subscriptions: subs
        .filter((s) => s.recipient_id === r.id)
        .map((s) => ({ reportType: s.report_type, propertySlug: s.property_slug, active: s.active === 1 })),
    }));
  });
}
