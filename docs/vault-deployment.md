# Deployment — Vault + AI drafts on the server

How to run Schnitt 1–3 (Hostex message sync, AI drafts, vault feedback loop) autonomously on the
production server, so it no longer depends on a laptop.

**Server:** `deploy@labs.remoterepublic.com`, app at `/opt/guesty-calendar-app` (PM2 process
`guesty-calendar`, behind Caddy). The production scheduler already runs the ETL hourly
(`startScheduler()` fires only when `NODE_ENV=production`), and the Hostex ETL now includes the
message sync + draft generation. So once the vault is present and `VAULT_PATH` is set, **drafts are
generated autonomously every hour** — no manual trigger needed.

## What the server needs (the only gaps for Schnitt 1–3)
1. The vault (`TheBrain`) present on the server as a **writable git repo**.
2. `VAULT_PATH` pointing at it, in the app `.env`.
3. A **git identity** inside the vault repo (so the feedback loop's commits succeed).
4. `ANTHROPIC_API_KEY` in the app `.env` (needed for classification AND drafts/suggestions).

## Prerequisites
- The server needs **read access to the private vault repo** `git@github.com:karlgrey/TheBrain.git`
  (add the server's SSH key as a GitHub deploy key on that repo, or reuse existing access).
- The vault must be **pushed to origin from the laptop first** (so the clone reflects the current
  curated state): `git -C ~/Development/TheBrain push origin main`.

## Steps (run on the server as the `deploy` user)

```bash
# 1. Clone the vault as a writable repo
git clone git@github.com:karlgrey/TheBrain.git /opt/TheBrain

# 2. Git identity for the feedback-loop commits (REQUIRED — without it, git commit fails)
git -C /opt/TheBrain config user.name  "Remote Republic Bot"
git -C /opt/TheBrain config user.email "bot@remoterepublic.com"

# 3. App env: point at the vault + confirm the Anthropic key is set
cd /opt/guesty-calendar-app
grep -q '^VAULT_PATH='       .env || echo 'VAULT_PATH=/opt/TheBrain' >> .env
grep -q '^ANTHROPIC_API_KEY=' .env || echo '# ADD: ANTHROPIC_API_KEY=sk-ant-...' >> .env   # then edit .env

# 4. Deploy the latest app (Schnitt 1–3). Migrations 018–020 run on startup; the prod scheduler
#    (re)starts the hourly ETL that now syncs Hostex messages + generates drafts.
git pull && npm install && npm run build && pm2 restart guesty-calendar

# 5. Verify
pm2 logs guesty-calendar --lines 80
#   look for: scheduler start, "Hostex: message sync done", "draft-gen: done"
```

Then open the admin UI (Caddy host) → **Nachrichten**: threads should appear with "KI-Entwurf bereit"
badges, and **Vault-Vorschläge** approvals write + commit to `/opt/TheBrain`.

## Known limitations / next step (Vault-Commit-Push)
- **No push is set up.** The feedback loop commits to the server's local `/opt/TheBrain` only. Those
  commits do **not** propagate to the GitHub remote or the laptop yet.
- Conversely, vault edits made elsewhere (laptop) won't reach the server after the initial clone
  until a pull mechanism exists.
- For now: treat the **server's vault as the live one**; to seed it with laptop changes, re-`git pull`
  in `/opt/TheBrain` manually (only safe when there are no un-pushed local loop-commits).
- The proper fix is the **Vault-Commit-Push** item: after `applySuggestion` commits, `git push` (and a
  pull-with-rebase strategy for incoming changes). Design that before relying on multi-location edits.

## Rollback
- App: `git -C /opt/guesty-calendar-app checkout <previous-sha> && npm run build && pm2 restart guesty-calendar`.
- Vault: the loop's commits are ordinary git commits in `/opt/TheBrain` — `git -C /opt/TheBrain revert <sha>`.
