# Schnitt 4 — Guesty-Send: KI-Entwürfe + Freigabe-Send für Guesty-Properties

**Datum:** 2026-07-07 · **Status:** approved (Micha, 2026-07-07)
**Kontext:** Schnitte 1–3 (Hostex-Messages, KI-Entwürfe, Vault-Feedback-Loop) laufen
produktiv. Dieser Schnitt zieht Farmhouse Prasser und Ferienwohnung Uferstraße 19
(Provider Guesty) hinter dieselbe Draft-/Freigabe-Abstraktion.

## Vorab geklärte Fragen (Projektseite Gäste-Messaging-Automation)

1. **Guesty Open API freigeschaltet?** JA — live verifiziert 2026-07-06 (read-only
   Probe mit Prod-Credentials): `GET /communication/conversations` → 200,
   219 Conversations, Posts lesbar, Kanal `airbnb2` sichtbar. Kein Tier-Gate.
2. **OTA-Restriktionen bei API-Sends?** Send-Endpoint existiert:
   `POST /communication/conversations/{id}/send-message` mit `{module: {type}, body}`.
   Doku: `platform`-Module wird als **E-Mail** zugestellt; `airbnb2` geht über den
   Airbnb-Kanal (Einschränkung nur für Owner-Conversations — irrelevant für uns).
   API-Sends laufen durch dieselbe Guesty-Pipeline wie die Web-Inbox; Airbnbs
   Off-Platform-Content-Policy (keine E-Mail-Adressen/externen Links) gilt inhaltlich
   weiter und ist in den Vault-Playbooks verankert. Die Web-Inbox antwortet
   automatisch auf dem Eingangskanal — via API setzen WIR den `module.type` und
   spiegeln dafür den Kanal der letzten Gastnachricht.

## Entscheidung: kein Stufen-Flag

Ein konfiguriertes Rollout-Stufenmodell (read/draft/send) wurde erwogen und
**verworfen** (Micha, 2026-07-07): Die per-Nachricht-Freigabe im Admin-UI ist das
eigentliche Sicherungs-Gate — ohne Michas Klick geht nichts raus. Statt Flags gibt es
zwei gezielte Vorsichts-Elemente (siehe „Vorsicht & Erst-Send").

## Ausgangslage im Code (Ist-Stand)

- `src/jobs/sync-guesty-messages.ts` — vollständiger Guesty-Lese-Sync
  (Conversations + Posts → `message_threads`/`messages`, `source='guesty'`,
  Thread-IDs `guesty:{convId}`, Message-IDs `guesty:{postId}`), aber **nirgends
  eingebunden** (keine Caller).
- `src/services/guesty-client.ts` — `listConversations` (Cursor-Pagination,
  Page-Cap 50) + `listConversationPosts` existieren; **kein Send**.
- Draft-Schema/UI sind provider-aware (`provider: 'hostex' | 'guesty'`,
  `thread.source`), aber: `getThreadsNeedingDraft` filtert hart `source='hostex'`,
  Regenerate-Route lehnt Nicht-Hostex ab, `sendReply` wirft für Guesty,
  Sync-Button/ETL syncen nur Hostex-Messages.
- `getThreadsNeedingReply` (Threadliste der UI) ist bereits provider-agnostisch.
- Vault: `Gästekommunikation Farmhouse Prasser.md` und
  `Gästekommunikation Ferienwohnung Uferstraße 19.md` liegen mit `scopes: [gaeste]`
  bereits im Deploy-Vault (brainstem-gaeste).

## Design

### 1. Konfiguration
`data/properties.json`: `farmhouse` und `u19` bekommen ausschließlich `vaultNote`:
- farmhouse → `"Gästekommunikation Farmhouse Prasser.md"`
- u19 → `"Gästekommunikation Ferienwohnung Uferstraße 19.md"`

Keine neuen Config-Felder, keine Schema-Änderung (Feld existiert, optional).

### 2. Guesty-Client: Send-Methode
`guestyClient.sendMessage(conversationId: string, body: string, moduleType: string)`
→ `POST /communication/conversations/{conversationId}/send-message` mit Body
`{ module: { type: moduleType }, body }`.
- Rückgabe: die Message-/Post-ID aus der Response (Feldname beim Erst-Send
  verifizieren); die Rohantwort wird bei den ersten Sends vollständig geloggt.
- Läuft durch die bestehende `request()`-Infrastruktur (OAuth, Bottleneck,
  Backoff) — keine Sonderbehandlung.

### 3. Kanal-Spiegelung (pure function)
Neuer Helper (z. B. `src/services/guesty-channel.ts`):
`resolveOutboundModuleType(messages: Message[]): string | null`
- Findet die letzte `direction='inbound'`-Nachricht des Threads und liest
  `raw_meta.type` (dort speichert der bestehende Sync `post.module.type`,
  z. B. `airbnb2`, `platform`).
- Nicht auflösbar (keine Inbound-Message, `type` fehlt oder ist `log`) → `null`
  → **kein Send** (UI-Hinweis statt Button).
- Der aufgelöste Typ wird beim Send unverändert gespiegelt (alle Kanäle,
  Entscheidung Micha 2026-07-06).

### 4. `sendReply`: Guesty-Zweig (`src/services/message-sender.ts`)
- `thread.source === 'guesty'`: `guesty:`-Prefix von `thread.id` abstreifen,
  Thread-Messages via `getMessagesByThread` laden (als injizierbare Dep im
  `SendDeps`-Interface, wie `hostexSend`), Modul-Typ via Helper auflösen,
  Client-Send, `{ externalMessageId }` zurück.
- Kanal nicht auflösbar → Fehler mit klarer Meldung (Route fängt ihn, Draft geht
  auf `error`, UI zeigt die Meldung). Der Fall ist aber schon vorher in der UI
  abgefangen (kein Send-Button) — der Fehlerpfad ist Defense-in-depth.
- Outbound-Row nach erfolgreichem Send: ID `guesty:{messageId}` (Duplikat-Kollaps
  beim nächsten Sync, gleiches Muster wie `hostex:{message_id}`), Fallback
  `sent:{draftId}` wenn die Response keine ID liefert.

### 5. Sync-Einbindung
- **Button** (`runMessageSync` in `src/routes/messages.ts`): zusätzlich über alle
  Properties mit `provider='guesty'` iterieren → `syncGuestyMessagesForProperty`
  + `generateDraftsForProperty`.
- **ETL**: gleicher Aufruf im stündlichen Guesty-ETL (`runETLJobForProperty`),
  non-fatal in eigenen try/catch-Blöcken — Spiegelbild der Hostex-Integration
  (`runHostexETL`: Messages nach Reservierungen, Drafts danach).
- `getLastHostexMessageSync` → provider-übergreifend (MAX über `source IN
  ('hostex','guesty')`) oder Funktion generalisieren; UI-Label bleibt „Letzter Sync".
- Effizienz: `fetchAllConversations` ist account-weit; bei zwei Guesty-Properties
  NICHT doppelt fetchen. `syncGuestyMessagesForProperty` bekommt einen optionalen
  Parameter mit der vorab gefetchten Conversation-Liste (ein Fetch pro Run, dann
  pro Property gefiltert — analog zum `detailCache`-Muster bei Hostex).

### 6. Draft-Generierung provider-agnostisch
- `getThreadsNeedingDraft(source, listingId, limit, sinceModifier)` — `source` als
  Parameter statt hart `'hostex'`. Übrige Filter unverändert (letzte Nachricht
  inbound, < 72h, kein pending-Draft).
- `generateDraftsForProperty(property)` generalisieren: `(source, listingId)` aus
  dem Provider der Property ableiten (`hostex` → `hostexPropertyId`, `guesty` →
  `guestyPropertyId`); Draft-`provider` entsprechend. Gates unverändert:
  `vaultNote` + `VAULT_PATH` + Voice/Fakten vorhanden, Cap `DRAFT_GEN_CAP=10`,
  Fenster `DRAFT_MAX_AGE_HOURS=72`.
- Regenerate-Route (`POST /:threadId/regenerate`): Guesty-Threads zulassen;
  Property-Lookup via neuem `getPropertyByGuestyId` (analog
  `getPropertyByHostexId` in `src/config/properties.ts`).

### 7. Admin-UI (`/admin/messages`)
- Guesty-Threads erscheinen automatisch in der Liste (Query schon agnostisch).
- Thread-Detail: „KI-Entwurf generieren"-Button auch für Guesty-Threads.
- Send-Button („Senden (Freigabe)") für Guesty-Threads nur, wenn der Kanal
  auflösbar ist; sonst an gleicher Stelle der Hinweis:
  „Kanal unklar — bitte direkt in der Guesty-Inbox antworten."
- Sonst keine UI-Änderungen; Feedback-Formular/Vault-Vorschläge funktionieren
  unverändert (Suggestion-Pfad ist `vaultNote`-basiert; der Property-Lookup im
  Feedback-Handler muss Guesty-Listings auflösen können — mit `getPropertyByGuestyId`).

### 8. Vorsicht & Erst-Send (manueller Verifikationsschritt)
1. **Erst-Send kontrolliert:** Die erste Guesty-Freigabe geht an eine beobachtbare
   Konversation (eigene Test-Anfrage oder ein unkritischer echter Thread). Dabei
   verifizieren: (a) Nachricht kommt auf dem richtigen Kanal an (Airbnb-App/Inbox),
   (b) Formatierung ok (Zeilenumbrüche), (c) Response-ID == Post-ID im nächsten
   Sync (Duplikat-Kollaps greift). Ergebnis im Spec-/Plan-Verlauf dokumentieren.
   (Dieselbe Annahme ist beim Hostex-Send noch offen — Code-Kommentar „confirm on
   first live send" — und wird hier gleich mitgeprüft.)
2. **Kein Send bei Kanal-Unklarheit** (Abschnitt 3/7).
3. Unverändert: kein Auto-Send; jede Nachricht braucht Michas Freigabe-Klick.

### 9. Tests (Vitest, Fake-Deps wie bei den Hostex-Tests)
- `resolveOutboundModuleType`: inbound airbnb2 → airbnb2; nur log/keine inbound →
  null; letzte inbound zählt (nicht frühere).
- `sendReply` Guesty-Zweig: Prefix-Strip, Modul-Spiegelung, Fehler bei null-Kanal;
  Hostex-Zweig unverändert grün.
- `getThreadsNeedingDraft` mit `source`-Parameter (hostex + guesty Fälle).
- `generateDraftsForProperty` für eine Guesty-Property (Fake-Deps): erzeugt Draft
  mit `provider='guesty'`.
- Bestehende Suites bleiben unverändert grün (`npx vitest run`).

## Nicht im Scope
- Auto-Send jeglicher Art.
- Guesty-Webhooks (wir bleiben beim Pull-Sync; Latenz stündlich/Button reicht).
- Booking.com-Sonderbehandlung (Spiegelung deckt es generisch ab; erst bei realem
  Bedarf verfeinern).
- Änderungen am Feedback-Loop/Vault-Sync (funktioniert `vaultNote`-basiert mit).
- Airbnb-Mail-Provider (firenze-loft) — hat keinen Rückkanal, bleibt read-only.

## Risiken
- **Send-Response-Schema unbekannt** → Erst-Send-Verifikation (Abschnitt 8);
  Fallback `sent:{draftId}` verhindert Datenverlust, schlimmstenfalls erscheint
  eine gesendete Nachricht nach dem nächsten Sync doppelt im Verlauf (kosmetisch).
- **Account-weite Conversation-Liste wächst** (aktuell 219, Page-Cap 50×50): Cap
  loggt Warning; reicht auf Jahre.
- **Draft-Qualität für neue Properties**: Playbooks Farmhouse/U19 sind frisch
  befüllt; Feedback-Loop (`/admin/suggestions`) fängt Lücken ein.
