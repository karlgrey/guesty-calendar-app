#!/usr/bin/env bash
# =====================================================================
# Einheitliches Deployment für guesty-calendar-app (Gäste-Messaging,
# Kalender, Reports — läuft als pm2-Prozess "guesty-calendar").
#
# Gleiches Modell wie die Site-Repos (studio-wandlitz.de/deploy.sh):
# lokal pushen → Server pullt → baut → startet neu → Health-Check.
# Zusätzlich (App mit SQLite-Daten): DB-Backup vor dem Restart.
# SQL-Migrationen (src/db/migrations) laufen beim App-Start automatisch.
#
#   ./deploy.sh
#
# Bricht `git pull --ff-only` ab, ist der Server-Checkout abgedriftet —
# Reparatur siehe Wiki [[Server-App anbinden]] („Drift geradeziehen").
# =====================================================================
set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-deploy@labs.remoterepublic.com}"
REMOTE_PATH="${REMOTE_PATH:-/opt/guesty-calendar-app}"
PM2_APP="${PM2_APP:-guesty-calendar}"
HEALTH_PORT="${HEALTH_PORT:-3005}"
# Ubuntu-Node 18 hat eine abweichende ABI → better-sqlite3 lädt nicht.
NODE_BIN="${NODE_BIN:-/home/deploy/.nvm/versions/node/v22.20.0/bin}"

if [ -n "$(git status --porcelain)" ]; then
  echo "✗ Abbruch: uncommittete Änderungen im Arbeitsbaum." >&2
  git status --short >&2
  exit 1
fi

echo "→ Lokal pushen"
git push

echo "→ Server: DB-Backup + pull + build + restart"
ssh "$REMOTE_HOST" bash -euo pipefail << REMOTE
export PATH="$NODE_BIN:\$PATH"
cd '$REMOTE_PATH'
# DB-Backup (ein Stand pro Tag reicht; ältere räumt der Monats-Lint ab)
cp -n data/calendar.db "data/calendar.db.bak-\$(date +%F)" || true
git pull --ff-only origin main
npm ci --silent
npm run build
pm2 restart '$PM2_APP' --update-env
REMOTE

echo "→ Health-Check (Server-lokal, Port $HEALTH_PORT)"
sleep 3
code=$(ssh "$REMOTE_HOST" "curl -s -o /dev/null -w '%{http_code}' --max-time 15 localhost:$HEALTH_PORT/health" || echo 000)
if [ "$code" != "200" ]; then
  echo "✗ Health-Check fehlgeschlagen: localhost:$HEALTH_PORT/health → $code" >&2
  echo "  Logs: ssh $REMOTE_HOST 'pm2 logs $PM2_APP --lines 40 --nostream'" >&2
  exit 1
fi
echo "✓ Deploy ok — /health → $code"
