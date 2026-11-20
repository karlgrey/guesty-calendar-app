-- Migration 045: Kalender-Report „Nächste Gäste" je Objekt abonnieren (#1284)
--
-- calendar-weekly war bisher objektübergreifend (property_slug ''). Ab jetzt wird er je
-- Objekt abonniert, wie weekly-summary (PER_PROPERTY_REPORT_TYPES in report-types.ts).
--
-- Übernahme: Jedes AKTIVE objektübergreifende Abo wird zu Objekt-Abos für genau die Objekte,
-- für die derselbe Empfänger heute ein AKTIVES weekly-summary-Abo hat. Inaktive
-- objektübergreifende Abos erzeugen nichts; inaktive weekly-summary-Abos zählen nicht.
-- Danach entfallen alle objektübergreifenden calendar-weekly-Zeilen (aktiv wie inaktiv).
--
-- Idempotent: INSERT OR IGNORE schützt bestehende Objekt-Abos (PK recipient_id, report_type,
-- property_slug); beim zweiten Lauf gibt es keine objektübergreifenden Zeilen mehr.
-- Kein Schema-Umbau: der CHECK-Constraint aus 041 bleibt unverändert.

INSERT OR IGNORE INTO report_subscriptions (recipient_id, report_type, property_slug, active, updated_at)
SELECT c.recipient_id, 'calendar-weekly', w.property_slug, 1, datetime('now')
FROM report_subscriptions c
JOIN report_subscriptions w
  ON w.recipient_id = c.recipient_id
 AND w.report_type = 'weekly-summary'
 AND w.active = 1
WHERE c.report_type = 'calendar-weekly'
  AND c.property_slug = ''
  AND c.active = 1;

DELETE FROM report_subscriptions
WHERE report_type = 'calendar-weekly' AND property_slug = '';
