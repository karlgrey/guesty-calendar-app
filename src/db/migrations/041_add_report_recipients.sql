-- Migration 041: Report-Empfänger in der Datenbank (#1223)
--
-- Die Empfänger aller Report-Mails werden im Admin-UI (/admin/reporting) gepflegt statt
-- in data/properties.json. Zwei Tabellen statt einer, damit ein Empfänger ohne ein
-- einziges Häkchen in der Matrix stehen bleibt (hinzufügen, später ankreuzen).
--
-- report_recipients:    eine Zeile je Mailadresse (klein geschrieben gespeichert)
-- report_subscriptions: Häkchen der Matrix — Empfänger × Report-Typ × Objekt
--   report_type:   weekly-summary (je Objekt) | portfolio-weekly | portfolio-monthly |
--                  calendar-weekly (die drei letzten objektübergreifend)
--   property_slug: Objekt-Slug bei weekly-summary, '' (leer) bei objektübergreifenden Reports
--   active:        1 = bekommt den Report, 0 = Häkchen entfernt
--
-- Die heutigen Empfänger aus properties.json übernimmt beim ersten Start der Bootstrap
-- src/services/reporting/report-recipients-bootstrap.ts (einmalig, Marker in scheduler_state).

CREATE TABLE report_recipients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE report_subscriptions (
  recipient_id INTEGER NOT NULL REFERENCES report_recipients(id) ON DELETE CASCADE,
  report_type TEXT NOT NULL CHECK (report_type IN ('weekly-summary', 'portfolio-weekly', 'portfolio-monthly', 'calendar-weekly')),
  property_slug TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (recipient_id, report_type, property_slug)
);

CREATE INDEX idx_report_subscriptions_type ON report_subscriptions (report_type, property_slug, active);
