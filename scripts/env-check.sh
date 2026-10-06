#!/bin/sh
# =====================================================================
# env-check.sh — Struktur-Check der Umgebungsvariablen vor dem Deploy
# (TheBrain2 #797). Vertrag ist .env.example: jeder dort gesetzte Key
# (`KEY=` am Zeilenanfang, auch `export KEY=`) muss am Ziel existieren.
# Verglichen werden NUR Key-Namen — Werte werden nie ausgegeben.
#
#   sh scripts/env-check.sh <example> <env-datei>
#   sh scripts/env-check.sh <example> --systemd <unit>
#
# - Kommentar- und Leerzeilen zählen nicht; auskommentierte Keys auch nicht.
# - Optional: steht direkt über dem Key eine Zeile `# optional …`, löst
#   sein Fehlen keinen Abbruch aus (nur Hinweis).
# - Keys, die nur am Ziel stehen, werden als Hinweis gelistet.
# - Leerer Wert (`KEY=`) gilt als vorhanden.
# - --systemd: Ziel sind die Environment=-Einträge der Unit
#   (`systemctl show <unit> -p Environment --value`; Binary per $SYSTEMCTL
#   überschreibbar, für Tests).
#
# Exit: 0 = ok · 1 = Pflicht-Keys fehlen · 2 = Aufruffehler / Ziel nicht lesbar
# Identische Kopie in guesty-calendar-app und SmartTasks — Änderungen in
# beiden Repos nachziehen.
# =====================================================================
set -u

usage() {
  echo "Aufruf: sh scripts/env-check.sh <example> <env-datei> | <example> --systemd <unit>" >&2
  exit 2
}

[ $# -ge 2 ] || usage
EXAMPLE=$1
shift
if [ ! -f "$EXAMPLE" ]; then
  echo "✗ env-check: Vertrag $EXAMPLE fehlt" >&2
  exit 2
fi

TMP=$(mktemp -d "${TMPDIR:-/tmp}/env-check.XXXXXX") || exit 2
trap 'rm -rf "$TMP"' EXIT

# Key-Namen aus einer Datei im .env-Format (eine Zeile pro Key, optional mit Typ).
# Mit mark=1 wird je Key "req" oder "opt" angehängt (Marker in der Zeile davor).
keys_from_file() {
  awk -v mark="$2" '
    {
      if (match($0, /^[ \t]*(export[ \t]+)?[A-Za-z_][A-Za-z0-9_]*=/)) {
        k = substr($0, RSTART, RLENGTH)
        sub(/^[ \t]*(export[ \t]+)?/, "", k)
        sub(/=$/, "", k)
        if (mark == 1) {
          p = tolower(prev)
          print k, (p ~ /^[ \t]*#[ \t]*optional([^a-z0-9_]|$)/ ? "opt" : "req")
        } else {
          print k
        }
      }
      prev = $0
    }
  ' "$1"
}

keys_from_file "$EXAMPLE" 1 > "$TMP/contract"

if [ "$1" = "--systemd" ]; then
  [ $# -eq 2 ] || usage
  UNIT=$2
  TARGET="systemd-Unit $UNIT (Environment=)"
  HINT="Wert als Environment= in der systemd-Unit $UNIT eintragen (Admin: systemctl edit $UNIT, dann systemctl daemon-reload), dann erneut deployen."
  if ! "${SYSTEMCTL:-systemctl}" show "$UNIT" -p Environment --value > "$TMP/raw" 2>/dev/null; then
    echo "✗ env-check: systemctl show $UNIT fehlgeschlagen" >&2
    exit 2
  fi
  # Format: KEY=VALUE durch Leerzeichen getrennt, Werte mit Leerzeichen in "…".
  awk '
    function emit(t) { if (match(t, /^[A-Za-z_][A-Za-z0-9_]*=/)) print substr(t, 1, RLENGTH - 1) }
    {
      n = length($0); tok = ""; q = 0
      for (i = 1; i <= n; i++) {
        c = substr($0, i, 1)
        if (c == "\\" && i < n) { tok = tok substr($0, i, 2); i++; continue }
        if (c == "\"") { q = !q; continue }
        if (c == " " && !q) { emit(tok); tok = ""; continue }
        tok = tok c
      }
      emit(tok)
    }
  ' "$TMP/raw" > "$TMP/have.raw"
else
  [ $# -eq 1 ] || usage
  ENVFILE=$1
  TARGET="$(cd "$(dirname "$ENVFILE")" 2>/dev/null && pwd)/$(basename "$ENVFILE")"
  HINT="Wert in $TARGET eintragen (deploy-Fenster), dann erneut deployen."
  if [ -f "$ENVFILE" ]; then
    keys_from_file "$ENVFILE" 0 > "$TMP/have.raw"
  else
    echo "✗ env-check: $TARGET existiert nicht" >&2
    : > "$TMP/have.raw"
  fi
fi

sort -u "$TMP/have.raw" > "$TMP/have"
awk '$2 == "req" { print $1 }' "$TMP/contract" | sort -u > "$TMP/req"
awk '$2 == "opt" { print $1 }' "$TMP/contract" | sort -u | comm -23 - "$TMP/req" > "$TMP/opt"
awk '{ print $1 }' "$TMP/contract" | sort -u > "$TMP/all"

comm -23 "$TMP/req" "$TMP/have" > "$TMP/missing"
comm -23 "$TMP/opt" "$TMP/have" > "$TMP/missing_opt"
comm -13 "$TMP/all" "$TMP/have" > "$TMP/extra"

list() { tr '\n' ' ' < "$1" | sed 's/ $//'; }

if [ -s "$TMP/missing_opt" ]; then
  echo "Hinweis env-check: optionale Keys nicht gesetzt: $(list "$TMP/missing_opt")"
fi
if [ -s "$TMP/extra" ]; then
  echo "Hinweis env-check: Keys nur in $TARGET, nicht in $(basename "$EXAMPLE"): $(list "$TMP/extra")"
fi

if [ -s "$TMP/missing" ]; then
  {
    echo "✗ env-check: Pflicht-Keys aus $(basename "$EXAMPLE") fehlen in $TARGET:"
    sed 's/^/  - /' "$TMP/missing"
    echo "  $HINT"
  } >&2
  exit 1
fi

echo "✓ env-check: alle $(wc -l < "$TMP/req" | tr -d ' ') Pflicht-Keys aus $(basename "$EXAMPLE") vorhanden in $TARGET"
exit 0
