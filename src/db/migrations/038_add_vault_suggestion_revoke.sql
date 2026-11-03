-- Migration 038: Vault-Vorschläge zurückziehen (#969)
--
-- Ein freigegebener Vorschlag (status 'approved') kann zurückgezogen werden: die Zeile wird per
-- Git-Commit aus dem Vault entfernt. status ist TEXT ohne CHECK, 'revoked' braucht keine Schemaänderung.
--
-- status:        'pending' | 'approved' | 'discarded' | 'revoked'
-- revoked_at:    NULL | Zeitpunkt der Rücknahme (bei Re-Approve wieder NULL)
-- revoke_commit: NULL | SHA des Revoke-Commits im Vault (NULL auch, wenn die Zeile schon weg war)

ALTER TABLE vault_suggestions ADD COLUMN revoked_at TEXT;
ALTER TABLE vault_suggestions ADD COLUMN revoke_commit TEXT;
