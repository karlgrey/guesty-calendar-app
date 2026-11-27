/**
 * Strom-Mail je Gast (#1376): nach jedem Check-out einer bestätigten Farmhouse-Buchung genau
 * eine Mail mit dem Stromverbrauch dieser Buchung an die Abonnenten des Report-Typs `power-stay`.
 *
 * Grundlage ist immer `buildPowerReport` (dieselbe Rechnung wie /admin/strom). Doppelversand
 * verhindert der Vermerk `power_stay_mails` (claim vor dem Versand, Freigabe bei Fehlschlag).
 * Stichtag `scheduler_state.power_stay_mail_since` (von Migration 047 gesetzt): Buchungen mit
 * Check-out davor bekommen nie eine Mail.
 */
import { config } from '../config/index.js';
import { getPropertyBySlug } from '../config/properties.js';
import { getActiveRecipientEmails } from '../repositories/report-recipient-repository.js';
import { claimPowerStayMail, getPowerStayMailIds, releasePowerStayMail } from '../repositories/power-stay-mail-repository.js';
import { getSchedulerState, setSchedulerState } from '../repositories/scheduler-state-repository.js';
import { sendEmail } from '../services/email-service.js';
import type { PowerRow } from '../services/power-consumption.js';
import { buildPowerReport, type PowerReport } from '../services/power-report-service.js';
import { buildPowerStayEmail } from '../services/power-stay-email-template.js';
import { isPropertyInReporting } from '../services/reporting/reporting-scope.js';
import { REPORT_TYPE_PROPERTY_SLUGS } from '../services/reporting/report-types.js';
import logger from '../utils/logger.js';

export const POWER_STAY_SINCE_KEY = 'power_stay_mail_since';
/** So lange nach Check-out wird auf einen verwertbaren Zählerstand gewartet; danach geht die Mail als „unvollständig“ raus. */
export const POWER_STAY_FALLBACK_MS = 6 * 60 * 60 * 1000;

export interface DuePowerStay {
  stay: PowerRow;
  vacancyBefore: PowerRow | null;
  completeness: 'complete' | 'incomplete';
}

/** Pure: welche Buchungen des Reports sind jetzt mailreif? */
export function selectDuePowerStays(report: PowerReport, nowMs: number, sinceMs: number, alreadySent: Set<string>): DuePowerStay[] {
  const due: DuePowerStay[] = [];
  report.rows.forEach((stay, i) => {
    if (stay.kind !== 'stay' || !stay.reservationId) return;
    if (alreadySent.has(stay.reservationId)) return;
    const endMs = Date.parse(stay.endUtc);
    if (!(endMs <= nowMs) || !(endMs >= sinceMs)) return;

    let completeness: 'complete' | 'incomplete';
    if (stay.status === 'complete') completeness = 'complete';
    else if (nowMs >= endMs + POWER_STAY_FALLBACK_MS) completeness = 'incomplete';
    else return; // wartet auf einen Zählerstand nach Check-out

    const prev = i > 0 ? report.rows[i - 1] : null;
    const vacancyBefore = prev && prev.kind === 'vacancy' && prev.endUtc === stay.startUtc ? prev : null;
    due.push({ stay, vacancyBefore, completeness });
  });
  return due;
}

export interface PowerStayRunResult {
  sent: number;
  failed: number;
  /** Anzahl mailreifer Buchungen (vor claim/Versand) */
  due: number;
}

async function runForProperty(slug: string, now: Date): Promise<PowerStayRunResult> {
  const result: PowerStayRunResult = { sent: 0, failed: 0, due: 0 };

  const property = getPropertyBySlug(slug);
  if (!property || !isPropertyInReporting(property, now)) {
    logger.info({ propertySlug: slug }, 'Strom-Mail: Objekt fehlt oder nicht im Reporting, übersprungen');
    return result;
  }

  const since = getSchedulerState(POWER_STAY_SINCE_KEY);
  if (!since || Number.isNaN(Date.parse(since))) {
    setSchedulerState(POWER_STAY_SINCE_KEY, now.toISOString());
    logger.warn({ propertySlug: slug }, 'Strom-Mail: Stichtag fehlte, auf jetzt gesetzt — in diesem Lauf wird nichts gesendet');
    return result;
  }

  const recipients = getActiveRecipientEmails('power-stay', slug);
  if (recipients.length === 0) {
    logger.info({ propertySlug: slug }, 'Strom-Mail: keine Empfänger, nichts gesendet');
    return result;
  }

  const report = buildPowerReport(slug, now);
  const due = selectDuePowerStays(report, now.getTime(), Date.parse(since), getPowerStayMailIds(slug));
  result.due = due.length;
  const adminUrl = `${config.baseUrl.replace(/\/$/, '')}/admin/strom?property=${slug}`;

  for (const { stay, vacancyBefore, completeness } of due) {
    const reservationId = stay.reservationId!;
    if (!claimPowerStayMail({ reservationId, propertySlug: slug, checkOutUtc: stay.endUtc, completeness, recipientCount: recipients.length })) {
      continue;
    }
    try {
      const mail = buildPowerStayEmail({ report, stay, vacancyBefore, adminUrl });
      const ok = await sendEmail({ to: recipients, subject: mail.subject, html: mail.html, text: mail.text });
      if (!ok) throw new Error('sendEmail lieferte false');
      result.sent++;
      logger.info({ propertySlug: slug, reservationId, completeness, recipientCount: recipients.length }, 'Strom-Mail gesendet');
    } catch (error) {
      releasePowerStayMail(reservationId);
      result.failed++;
      logger.error({ error, propertySlug: slug, reservationId }, 'Strom-Mail fehlgeschlagen, nächster Lauf versucht es erneut');
    }
  }
  return result;
}

/** Stündlicher Lauf. Wirft nie (darf den Scheduler nicht crashen). */
export async function runPowerStayMails(now: Date = new Date()): Promise<PowerStayRunResult> {
  const total: PowerStayRunResult = { sent: 0, failed: 0, due: 0 };
  try {
    for (const slug of REPORT_TYPE_PROPERTY_SLUGS['power-stay'] ?? []) {
      try {
        const r = await runForProperty(slug, now);
        total.sent += r.sent;
        total.failed += r.failed;
        total.due += r.due;
      } catch (error) {
        logger.error({ error, propertySlug: slug }, 'Strom-Mail: Fehler bei Objekt');
      }
    }
  } catch (error) {
    logger.error({ error }, 'Strom-Mail: Fehler im Lauf');
  }
  return total;
}
