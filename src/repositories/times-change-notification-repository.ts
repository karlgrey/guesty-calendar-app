/**
 * Dedupe-Tabelle für Zeit-Änderungs-Nachrichten (Migration 034, #793).
 */
import { getDatabase } from '../db/index.js';

/** true = Eintrag neu angelegt (jetzt versenden), false = schon benachrichtigt. */
export function claimTimesChangeNotification(reservationId: string, field: string, value: string): boolean {
  const r = getDatabase()
    .prepare('INSERT OR IGNORE INTO times_change_notifications (reservation_id, field, value) VALUES (?, ?, ?)')
    .run(reservationId, field, value);
  return r.changes > 0;
}

/** Claim zurücknehmen, wenn der Versand scheiterte. */
export function releaseTimesChangeNotification(reservationId: string, field: string, value: string): void {
  getDatabase()
    .prepare('DELETE FROM times_change_notifications WHERE reservation_id = ? AND field = ? AND value = ?')
    .run(reservationId, field, value);
}
