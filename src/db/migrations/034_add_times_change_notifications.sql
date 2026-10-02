-- Migration 034: Dedupe für Zeit-Änderungs-Nachrichten an die Putzcrew (#793)
--
-- Je Änderung genau eine WhatsApp: (reservation_id, field, value) ist unique.
-- field: 'dates' | 'planned_arrival' | 'planned_departure'
-- value: neuer Wert ('HH:MM' bzw. 'YYYY-MM-DD/YYYY-MM-DD' für Check-in/-out)
-- Bewusst KEIN FK auf reservations (ETL räumt Reservierungen ab, Dedupe-Zeilen sind
-- harmlos und verhindern einen Doppelversand bei Wiederauftauchen).

CREATE TABLE IF NOT EXISTS times_change_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id TEXT NOT NULL,
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  notified_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (reservation_id, field, value)
);
