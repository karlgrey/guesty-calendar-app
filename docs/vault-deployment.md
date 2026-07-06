# Deployment — Vault + AI drafts on the server

How to run Schnitt 1–3 (Hostex message sync, AI drafts, vault feedback loop) autonomously on the
production server, so it no longer depends on a laptop.

**Server:** `deploy@labs.remoterepublic.com`, app at `/opt/guesty-calendar-app` (PM2 process
`guesty-calendar`, behind Caddy). The production scheduler already runs the ETL hourly
(`startScheduler()` fires only when `NODE_ENV=production`), and the Hostex ETL includes the
message sync + draft generation. So once the vault is present and `VAULT_PATH` is set, **drafts are
generated autonomously every hour** — no manual trigger needed.

## Vault architecture (since 2026-07-06)

The server vault is **`brainstem-gaeste`** — a *generated* deploy artifact, exported from the
master wiki `TheBrain2` (laptop-only, private) via `tools/publish.py gaeste`. Only pages with
`scopes: [gaeste]` are exported; `## Nicht-öffentlich` sections (access codes) are stripped at
publish time and never reach the server.

- Voice: `prozesse/Gästekommunikation Grundsätze.md`
- Per-property facts: `prozesse/<vaultNote>` (e.g. `prozesse/Gästekommunikation Bootshaus.md`)
- Feedback-loop commits (git author "Remote Republic Bot") land in this repo and are pulled back
  into the master via the **Ingest-Feedback** workflow documented in TheBrain2's `CLAUDE.md`.
- Do NOT hand-edit the deploy repo; edit the master wiki and republish.
- The old `/opt/TheBrain` vault is decommissioned (repo archived).

## What the server needs

1. The deploy vault present as a **writable git repo**: `/opt/brainstem-gaeste`.
2. `VAULT_PATH=/opt/brainstem-gaeste` in the app `.env`.
3. A **git identity** inside the vault repo (so the feedback loop's commits succeed).
4. `ANTHROPIC_API_KEY` in the app `.env` (needed for classification AND drafts/suggestions).

## Steps (run on the server as the `deploy` user)

```bash
# 1. Clone the deploy vault as a writable repo
git clone git@github.com:karlgrey/brainstem-gaeste.git /opt/brainstem-gaeste

# 2. Git identity for the feedback-loop commits (REQUIRED — without it, git commit fails)
git -C /opt/brainstem-gaeste config user.name  "Remote Republic Bot"
git -C /opt/brainstem-gaeste config user.email "bot@remoterepublic.com"

# 3. App env: point at the vault + confirm the Anthropic key is set
cd /opt/guesty-calendar-app
grep -q '^VAULT_PATH='        .env || echo 'VAULT_PATH=/opt/brainstem-gaeste' >> .env
grep -q '^ANTHROPIC_API_KEY=' .env || echo '# ADD: ANTHROPIC_API_KEY=sk-ant-...' >> .env   # then edit .env

# 4. Deploy the latest app. The prod scheduler (re)starts the hourly ETL
#    (vault sync → message sync → draft gen).
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22
git pull && npm install && npm run build && pm2 restart guesty-calendar

# 5. Verify
pm2 logs guesty-calendar --lines 120
#   look for: "📚 Vault synced" (pushed: true), "Hostex: message sync done", "draft-gen: done",
#   and NO "vault-knowledge" warnings.
```

Then open the admin UI (Caddy host) → **Nachrichten**: threads should appear with "KI-Entwurf bereit"
badges, and **Vault-Vorschläge** approvals write + commit to `/opt/brainstem-gaeste`.

## Vault sync (server ↔ GitHub)

`vault-sync.ts` runs after each vault approval and as the first step of every hourly ETL:
fetch → merge → push (no rebase, non-fatal). Push failure: the commit stays local, the UI shows
"Push ausstehend", the next run retries. Merge conflict: `merge --abort`, resolve manually.
Laptop side: pull the deploy repo, ingest bot commits into the master wiki, republish
(see TheBrain2 `CLAUDE.md`, workflows "Publish" and "Ingest-Feedback").

## Rollback

- App: `git -C /opt/guesty-calendar-app checkout <previous-sha> && npm run build && pm2 restart guesty-calendar`.
- Vault: the loop's commits are ordinary git commits in `/opt/brainstem-gaeste` —
  `git -C /opt/brainstem-gaeste revert <sha>`.
- Full vault rollback: re-run `tools/publish.py` from the master wiki and force-push — the deploy
  repo is a generated artifact, the master is always the source of truth.
