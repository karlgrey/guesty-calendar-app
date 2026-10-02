-- Migration 036: Block-Zustand am Zeit-Override (#799 Nachbesserung)
--
-- Der Folgetag-Block läuft nur noch über den Listing-Kalender und nur, wenn der Tag frei ist
-- (Guesty blockt am Farmhouse/U19 per Vorbereitungszeit 'pt' ohnehin). Damit die Rücknahme nur
-- entfernt, was WIR gesetzt haben, wird der Zustand am Override persistiert.
--
-- block_state: NULL (kein Block angefragt/aktiv) | 'set-by-us' (wir haben den Tag geblockt)
--              | 'already-blocked' (Tag war schon unavailable, nichts geschrieben)

ALTER TABLE stay_time_overrides ADD COLUMN block_state TEXT NULL;
