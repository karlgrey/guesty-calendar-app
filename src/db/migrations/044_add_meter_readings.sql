-- Migration 044: Zählerstände je Objekt (#1169, Stromverbrauch je Buchung)
--
-- Home Assistant schickt stündlich den fortlaufenden kWh-Stand des Hauszählers an
-- POST /api/meter/readings (Token METER_INGEST_TOKEN). Die App holt nichts ab.
-- Je Objekt (property_slug aus data/properties.json), damit später weitere Objekte
-- dazukommen können; genutzt wird zunächst nur `farmhouse`.
--
-- measured_at: Messzeitpunkt, normalisiert auf UTC (`Date#toISOString()`), damit derselbe
-- Zeitpunkt in anderer Offset-Schreibweise (+01:00 vs. Z) als Dublette erkannt wird.
-- Idempotenz: UNIQUE(property_slug, measured_at) + INSERT OR IGNORE — der erste Wert bleibt.
CREATE TABLE IF NOT EXISTS meter_readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_slug TEXT NOT NULL,
  measured_at TEXT NOT NULL,
  kwh REAL NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (property_slug, measured_at)
);
