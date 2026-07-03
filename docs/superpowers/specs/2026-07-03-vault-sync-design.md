# Vault-Sync (Server ↔ GitHub) — Design

**Datum:** 2026-07-03
**Status:** Freigegeben von Micha
**Kontext:** Schnitt 3 (Vault-Feedback-Loop) committet Freigaben in den Server-Vault
(`/opt/TheBrain`), pusht aber nicht. Der Server pullt auch nie. Folge (2026-07-03 real
passiert): Server und Laptop divergieren, Push schlägt non-fast-forward fehl, manuelle
Merge-Aktion nötig. Dieses Vorhaben schließt den Loop: Server bleibt aktuell (Pull) und
Feedback-Commits landen automatisch auf GitHub (Push).

## Ziel

Nach jeder Vault-Freigabe und einmal pro Stunden-ETL synchronisiert der Server den Vault
mit `origin/main`: fetch → merge → push. Divergenz kann nicht mehr entstehen, solange der
Sync läuft; wenn er fehlschlägt, geht nichts verloren und der Fehler ist sichtbar.

## Nicht-Ziele (YAGNI)

- Kein Rebase, kein Force-Push, keine automatische Konfliktauflösung.
- Kein Webhook/Echtzeit-Pull vom Laptop — stündlich reicht.
- Kein Sync auf dem Laptop (dort arbeitet Micha selbst mit git).

## Entscheidung

Sync-Logik als Service **in der App** (nicht Crontab): im Repo, unit-getestet, Fehler
landen im UI/ETL-Ergebnis statt unsichtbar in einer Server-Crontab. Verworfen:
Push-only nach Freigabe (löst die Pull-Seite nicht), externer Cron (ungetestet,
unsichtbar, kann der App in einen laufenden Commit grätschen).

## Architektur

### Neuer Service: `src/services/vault-sync.ts`

```
syncVault(deps?): { synced: boolean; pushed: boolean; error?: string }
```

Ablauf (alle git-Aufrufe via `execFileSync('git', ['-C', vaultPath, ...])` — argv,
keine Shell):

1. `git fetch origin`
2. `git merge origin/main --no-edit` — Merge, kein Rebase (Michas Vorgabe; sicher bei
   paralleler Laptop-Arbeit)
3. `git push origin main`

Dependency-Injection wie in `vault-writer.ts` (`VaultWriterDeps`-Muster): `vaultPath` +
`git(args)` injizierbar, Default aus `config.vaultPath`.

Feature-Gate: ohne `VAULT_PATH` sofortiger No-op (`{ synced: false, pushed: false }`,
kein Fehler) — identisch zum bestehenden Vault-Verhalten.

### Fehlerbehandlung

- **Merge-Konflikt:** `git merge --abort`, dann `{ synced: false, error: 'merge
  conflict …' }`. Vault bleibt sauber (Drafts funktionieren weiter), Auflösung manuell.
  Bei den Append-only-Feedback-Commits praktisch nie zu erwarten.
- **Push-Fehler** (offline, GitHub down): Commit bleibt lokal, `{ synced: true,
  pushed: false, error }`. Nächster Sync (nächste Freigabe oder ETL-Lauf) räumt nach.
- **Abort-Fehler doppelt gesichert:** Schlägt auch `merge --abort` fehl, Fehler
  loggen und zurückgeben — nie werfen. `syncVault` ist überall non-fatal.

### Aufrufpunkt 1 — nach Freigabe (`src/routes/suggestions.ts`)

Direkt nach erfolgreichem `applySuggestion()` → `syncVault()`. Ergebnis non-fatal ins
Redirect/Flash: bei `pushed: false` zeigt das UI „Committet, Push ausstehend" statt
Fehler. Die Freigabe selbst scheitert dadurch nie.

### Aufrufpunkt 2 — stündlicher ETL (`src/jobs/etl-job.ts`)

Eigener Schritt (analog zu den bestehenden Sync-Schritten) am Anfang des Laufs, damit
Draft-Generierung mit frischem Vault-Wissen arbeitet. Ergebnis (synced/pushed/error) im
ETL-Ergebnis ausweisen. Fehler machen den ETL-Lauf nicht kaputt (non-fatal, wie
Draft-Gen heute).

## Voraussetzungen (erfüllt)

- Server kann pushen: 2026-07-03 nachgewiesen (manueller Push von `/opt/TheBrain`).
- git-Identität „Remote Republic Bot" auf dem Server gesetzt.

## Tests (Unit, über Fake-Git-Deps)

1. Happy Path: fetch → merge → push aufgerufen, `{ synced: true, pushed: true }`.
2. Push schlägt fehl → `{ synced: true, pushed: false, error }`.
3. Merge schlägt fehl → `merge --abort` wird aufgerufen, `{ synced: false, error }`.
4. Merge UND Abort schlagen fehl → Fehler zurückgegeben, nichts geworfen.
5. Kein `VAULT_PATH` → No-op ohne git-Aufrufe.
6. Route: Freigabe mit fehlgeschlagenem Push bleibt erfolgreich (Commit da, Hinweis).
7. ETL: Sync-Fehler lässt übrige ETL-Schritte weiterlaufen.
