-- Migration 035: Zeit-Abweichungen pro Aufenthalt, plattformneutral (#799)
--
-- Zugesagte Abweichungen von den Listing-Standardzeiten (Late-Checkout, früher Check-in,
-- Folgetag-Block) leben in UNSERER Datenbank — für Guesty UND Hostex. Der Override gewinnt
-- über planned_arrival/planned_departure des Providers; NULL = Provider-/Standardwert gilt.
--
-- Bewusst KEIN FK auf reservations (wie 033/034): der ETL räumt Reservierungen ab und legt
-- sie wieder an (deleteStaleReservationsInRange); mit ON DELETE CASCADE ginge dabei eine
-- zugesagte Abweichung verloren, ohne FK überlebt sie das Wiederauftauchen. Verwaiste Zeilen
-- sind harmlos (der Kalender-Sync liest Overrides nur zu aktiven Reservierungen).
-- reservation_id = reservations.reservation_id (bei Hostex der reservation_code).
--
-- source: 'agent' (Agent-API) | 'admin' (Thread-Formular) | 'etl' (reserviert, noch ungenutzt)

CREATE TABLE IF NOT EXISTS stay_time_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id TEXT NOT NULL UNIQUE,
  planned_arrival TEXT,
  planned_departure TEXT,
  block_next_day INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  source TEXT NOT NULL CHECK (source IN ('agent', 'admin', 'etl')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
