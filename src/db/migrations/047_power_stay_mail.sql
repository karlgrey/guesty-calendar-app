-- Migration 047: Strom-Mail je Gast im Farmhouse (#1376)
--
-- Nach jedem Check-out einer bestätigten Farmhouse-Buchung geht genau eine Mail mit dem
-- Stromverbrauch dieser Buchung an die Abonnenten des neuen Report-Typs `power-stay`
-- (Job src/jobs/power-stay-email.ts, Typ-Definition in src/services/reporting/report-types.ts).
--
-- a) report_subscriptions wird neu aufgebaut: der CHECK aus 041 erlaubt nur die damals
--    bekannten Report-Typen, und SQLite kann einen CHECK-Constraint nicht ändern. Spalten,
--    Defaults, Primärschlüssel, Fremdschlüssel und Index bleiben wie in 041; einziger
--    Unterschied ist `power-stay` in der Liste. Alle bestehenden Abos (041/045) werden kopiert.
--    report_subscriptions ist nur Kindtabelle von report_recipients (kein Fremdschlüssel zeigt
--    auf sie), das DROP ist daher auch bei foreign_keys = ON unkritisch.
-- b) power_stay_mails: Versandvermerk, eine Zeile je Buchung (claim vor dem Versand,
--    Freigabe bei Fehlschlag) — schützt vor Doppelversand.
-- c) Stichtag `scheduler_state.power_stay_mail_since` = Zeitpunkt dieser Migration (Deploy).
--    Buchungen mit Check-out VOR diesem Zeitpunkt bekommen nie eine Mail, damit der erste
--    Lauf keine Altbuchungen nachsendet. INSERT OR IGNORE: ein bestehender Wert bleibt.

CREATE TABLE report_subscriptions_new (
  recipient_id INTEGER NOT NULL REFERENCES report_recipients(id) ON DELETE CASCADE,
  report_type TEXT NOT NULL CHECK (report_type IN ('weekly-summary', 'portfolio-weekly', 'portfolio-monthly', 'calendar-weekly', 'power-stay')),
  property_slug TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (recipient_id, report_type, property_slug)
);

INSERT INTO report_subscriptions_new (recipient_id, report_type, property_slug, active, updated_at)
SELECT recipient_id, report_type, property_slug, active, updated_at FROM report_subscriptions;

DROP TABLE report_subscriptions;

ALTER TABLE report_subscriptions_new RENAME TO report_subscriptions;

CREATE INDEX idx_report_subscriptions_type ON report_subscriptions (report_type, property_slug, active);

CREATE TABLE power_stay_mails (
  reservation_id TEXT PRIMARY KEY,
  property_slug TEXT NOT NULL,
  check_out_utc TEXT NOT NULL,
  completeness TEXT NOT NULL CHECK (completeness IN ('complete', 'incomplete')),
  recipient_count INTEGER NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT OR IGNORE INTO scheduler_state (key, value) VALUES ('power_stay_mail_since', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
