# Differenzierte Block-Labels im Google-Kalender — Design

**Datum:** 2026-06-05
**Status:** Spec (genehmigt im Brainstorming)
**Betrifft:** `src/services/google-calendar-blocks.ts`, `src/jobs/sync-google-calendar.ts` (+ Tests).
**Baut auf:** `2026-06-04-owner-blocks-design.md` (Block-Sync existiert bereits).

## Ziel

Die Block-Termine im geteilten Owner-Google-Kalender sind aktuell zu generisch (überwiegend
„🔒 Blockiert"). Sie sollen den **Grund/die Quelle** eines Blocks zeigen, so weit der Provider das
hergibt — und die **Schloss-Emojis (🔒) entfallen**.

## Datengrenze (wichtig, ehrlich)

Kein Provider liefert einen *echten* Grund (Owner-Aufenthalt vs. Wartung vs. Fremdkanal). Verfügbar
ist nur:
- **Guesty:** Flags `o` (owner) / `m` (manual) → in `availability.block_type` als `'owner'`/`'manual'`.
  In der Praxis bei farmhouse/u19 faktisch immer `'manual'`.
- **Hostex:** `inventory=0`, kein Grund → `block_type=null`.
- **Airbnb (Florence):** „Not available" → `block_type='owner'` (durch Owner-Blocks-Feature gesetzt).

Maximale Differenzierung = bester verfügbarer Typ + Quelle. Das wird hier umgesetzt.

## Label-Logik

Neue reine Funktion `blockLabel(blockType: string | null, provider: string): string`:

| Bedingung | Label (Termin-Titel, **ohne** Emoji) |
|---|---|
| `blockType === 'owner'` | `Owner-Block` |
| `blockType === 'maintenance'` | `Wartung` |
| `blockType === 'manual'` | `Manuell blockiert` |
| sonst, `provider === 'hostex'` | `Blockiert (Hostex)` |
| sonst, `provider === 'airbnb-mail'` | `Blockiert (Airbnb)` |
| sonst | `Blockiert` |

## Änderungen

### `src/services/google-calendar-blocks.ts` (pure)
1. **`blockLabel(blockType, provider)`** wie oben (exportiert, testbar).
2. **`buildBlockSpans`** trennt Spannen zusätzlich bei **Wechsel des `block_type`**: eine laufende
   Spanne wird nur verlängert, wenn `last.endExclusive === day.date` **und** `last.blockType ===
   day.block_type`. Sonst beginnt eine neue Spanne. (Verhindert, dass unterschiedliche Gründe zu
   einem Termin verschmelzen. In der Praxis selten, aber korrekt.)
3. **`buildBlockEvent(span, propertyName, provider)`** — Signatur um `provider` erweitert:
   - `summary = blockLabel(span.blockType, provider)` (kein „🔒").
   - **Beschreibung** mit Kontext: `Quelle: {ProviderLabel} · {nights} Nächte · {DD.MM.}–{DD.MM.}`
     - `ProviderLabel`: `guesty`→„Guesty", `hostex`→„Hostex", `airbnb-mail`→„Airbnb".
     - `nights` = Tage zwischen `startDate` und `endExclusive`.
     - Datumsbereich: `startDate`–`endExclusive` im Format `DD.MM.` (deutsch).
   - `extendedProperties.private.kind = 'owner-block'` bleibt (Cleanup-Marker), `transparency='opaque'`,
     `start.date`/`end.date` unverändert.

### `src/jobs/sync-google-calendar.ts`
- Beim Bau der Block-Events `property.provider` an `buildBlockEvent(span, name, property.provider)`
  durchreichen. (`provider` ist auf `PropertyConfig` vorhanden.) Sonst unverändert.

## Architektur / Isolation

- `blockLabel` und `buildBlockEvent` bleiben **reine** Funktionen (kein I/O), voll unit-testbar.
- `buildBlockSpans` bleibt rein; nur die Merge-Bedingung wird verschärft.
- Der Sync-Job reicht nur den `provider` durch — keine neue Logik dort.

## Tests (Vitest, `google-calendar-blocks.test.ts`)

- `blockLabel`: alle Zeilen der Tabelle (owner/maintenance/manual + Provider-Fallbacks); kein „🔒".
- `buildBlockSpans`: Trennung bei `block_type`-Wechsel an aufeinanderfolgenden Tagen (neuer Test);
  bestehende Gruppierungs-/Lücken-Tests bleiben grün.
- `buildBlockEvent`: Titel je Kombination ohne Emoji; Beschreibung enthält `Quelle:`, Nächte-Anzahl,
  Datumsbereich; `provider`-Parameter wirkt; `extendedProperties`-Marker & exklusives Enddatum bleiben.

## Bewusst nicht (YAGNI)

- Kein Versuch, einen „echten" Grund zu erraten, den der Provider nicht liefert.
- Keine User-konfigurierbaren Block-Kategorien.
- Hostex-Blocks werden **nicht** pauschal als „Owner-Block" gelabelt (bewusst „Blockiert (Hostex)",
  ehrlich statt geraten) — kann später geändert werden, falls gewünscht.

## Offene Detailfrage für die Umsetzung

- Exaktes Datums-/Nächte-Format in der Beschreibung beim Implementieren in Tests fixieren
  (`DD.MM.`, `nights = endExclusive − startDate` in Tagen).
