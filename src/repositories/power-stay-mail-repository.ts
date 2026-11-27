/**
 * Versandvermerk der Strom-Mail je Gast (Migration 047, #1376).
 *
 * Eine Zeile je Buchung. `claimPowerStayMail` setzt den Vermerk VOR dem Versand (verhindert
 * Doppelversand), `releasePowerStayMail` nimmt ihn nach fehlgeschlagenem Versand zurück,
 * damit der nächste Lauf es erneut versucht.
 */
import { getDatabase } from '../db/index.js';
import { DatabaseError } from '../utils/errors.js';
import logger from '../utils/logger.js';

export interface PowerStayMailClaim {
  reservationId: string;
  propertySlug: string;
  checkOutUtc: string;
  completeness: 'complete' | 'incomplete';
  recipientCount: number;
}

function wrap<T>(what: string, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    logger.error({ error }, `Power stay mail: ${what} failed`);
    throw new DatabaseError(`${what} failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/** true = Vermerk neu angelegt (Versand darf erfolgen), false = Buchung hat schon einen Vermerk. */
export function claimPowerStayMail(input: PowerStayMailClaim): boolean {
  return wrap('claimPowerStayMail', () => {
    const res = getDatabase()
      .prepare(
        `INSERT OR IGNORE INTO power_stay_mails (reservation_id, property_slug, check_out_utc, completeness, recipient_count)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.reservationId, input.propertySlug, input.checkOutUtc, input.completeness, input.recipientCount);
    return res.changes === 1;
  });
}

/** Nimmt den Vermerk zurück (nach fehlgeschlagenem Versand). */
export function releasePowerStayMail(reservationId: string): void {
  wrap('releasePowerStayMail', () => {
    getDatabase().prepare('DELETE FROM power_stay_mails WHERE reservation_id = ?').run(reservationId);
  });
}

/** Alle Buchungen eines Objekts, für die schon eine Mail vermerkt ist. */
export function getPowerStayMailIds(propertySlug: string): Set<string> {
  return wrap('getPowerStayMailIds', () => {
    const rows = getDatabase()
      .prepare('SELECT reservation_id FROM power_stay_mails WHERE property_slug = ?')
      .all(propertySlug) as Array<{ reservation_id: string }>;
    return new Set(rows.map((r) => r.reservation_id));
  });
}
