// src/repositories/draft-repository.ts
import { getDatabase } from '../db/index.js';
import type { MessageDraft, NewDraft } from '../types/messages.js';
import type { AutoSendDecision, AutoSendMode } from '../services/auto-send/types.js';

export function createDraft(d: NewDraft): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO message_drafts (id, thread_id, provider, body, generated_by, model)
     VALUES (@id, @thread_id, @provider, @body, @generated_by, @model)`,
  ).run({ ...d, model: d.model ?? null });
}

export function getDraftById(id: string): MessageDraft | null {
  const db = getDatabase();
  const row = db.prepare(`SELECT * FROM message_drafts WHERE id = ?`).get(id) as MessageDraft | undefined;
  return row ?? null;
}

export function getActiveDraftByThread(threadId: string): MessageDraft | null {
  const db = getDatabase();
  const row = db
    .prepare(`SELECT * FROM message_drafts WHERE thread_id = ? AND status = 'pending'
              ORDER BY created_at DESC LIMIT 1`)
    .get(threadId) as MessageDraft | undefined;
  return row ?? null;
}

/**
 * Atomically transition a draft from 'pending' → 'sending'.
 * Returns true if the claim succeeded (exactly one row updated), false otherwise.
 * Two concurrent callers: the first wins, the second gets false (TOCTOU guard).
 */
export function claimDraftForSending(id: string): boolean {
  const db = getDatabase();
  const result = db
    .prepare(`UPDATE message_drafts SET status = 'sending' WHERE id = ? AND status = 'pending'`)
    .run(id);
  return result.changes === 1;
}

// Signatur erweitert: dritter Parameter (Default 'micha') — bestehende Aufrufer bleiben gültig.
export function markDraftSent(id: string, externalMessageId: string | null, sentBy: 'micha' | 'auto' = 'micha'): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE message_drafts
     SET status = 'sent', external_message_id = ?, sent_at = datetime('now'), error = NULL, sent_by = ?
     WHERE id = ?`,
  ).run(externalMessageId, sentBy, id);
}

export function markDraftError(id: string, error: string): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE message_drafts
     SET status = 'error', error = ?, send_attempts = send_attempts + 1
     WHERE id = ?`,
  ).run(error, id);
}

export function discardDraft(id: string): void {
  const db = getDatabase();
  db.prepare(`UPDATE message_drafts SET status = 'discarded' WHERE id = ?`).run(id);
}

export function updateDraftBody(id: string, body: string): void {
  const db = getDatabase();
  db.prepare(`UPDATE message_drafts SET body = ? WHERE id = ?`).run(body, id);
}

// --- Stale-Draft-Regeneration (Migration 032, #699) ---

/**
 * Atomarer Drossel-Claim: "höchstens ein Neugenerierungs-Versuch pro Draft und Fenster" — auch
 * bei parallelem Öffnen desselben Threads (zwei Tabs) und nach einem Fehlschlag (kein
 * Dauer-LLM-Kosten beim wiederholten Öffnen). Referenzzeit fürs Alter ist
 * COALESCE(regenerated_at, created_at) — nach einer erfolgreichen Neugenerierung zählt deren
 * Zeitpunkt, nicht mehr die ursprüngliche Anlage. Ein vorheriger Versuch (Erfolg ODER
 * Fehlschlag) sperrt weitere Claims, bis er selbst außerhalb des Fensters liegt. true bei
 * genau einer betroffenen Zeile (changes===1) — der zweite gleichzeitige Aufruf bekommt false.
 */
export function claimDraftRegeneration(id: string, staleHours: number): boolean {
  const db = getDatabase();
  const result = db
    .prepare(
      `UPDATE message_drafts
       SET regen_attempted_at = datetime('now')
       WHERE id = ?
         AND status = 'pending'
         AND generated_by = 'llm'
         AND datetime(COALESCE(regenerated_at, created_at)) < datetime('now', '-' || ? || ' hours')
         AND (regen_attempted_at IS NULL OR datetime(regen_attempted_at) < datetime('now', '-' || ? || ' hours'))`,
    )
    .run(id, staleHours, staleHours);
  return result.changes === 1;
}

/**
 * Übernimmt eine erfolgreich neu generierte Fassung IN DENSELBEN Draft-Datensatz (draftId bleibt
 * gleich — der Push-Watcher dedupliziert darüber, ein neuer Datensatz würde einen zweiten Push
 * auslösen). Sichert den bisherigen Text als previous_body/previous_body_at, bevor er
 * überschrieben wird. WHERE status='pending' schützt gegen ein Wettrennen mit Senden/Verwerfen,
 * das zwischen Claim und Anwenden passiert ist — dann bleibt der gesendete/verworfene Draft
 * unangetastet (false).
 */
export function applyDraftRegeneration(id: string, newBody: string): boolean {
  const db = getDatabase();
  const result = db
    .prepare(
      `UPDATE message_drafts
       SET previous_body = body,
           previous_body_at = COALESCE(regenerated_at, created_at),
           body = ?,
           regenerated_at = datetime('now')
       WHERE id = ? AND status = 'pending'`,
    )
    .run(newBody, id);
  return result.changes === 1;
}

// --- Auto-Send-Gate (Migration 027) ---

// #702 Punkt 4: auto_judge_reasoning trägt das reasoning-Feld des Prüfmodells (decide() reicht
// es aus dem Judge-Urteil durch, siehe policy.ts) — auto_reason bleibt der Policy-Text.
// d.judgeReasoning ist optional, ?? null deckt ältere/handgebaute AutoSendDecision-Objekte ohne
// dieses Feld ab (z. B. bestehende Testfixtures).
export function setAutoDecision(id: string, d: AutoSendDecision, mode: AutoSendMode): void {
  getDatabase().prepare(
    `UPDATE message_drafts SET auto_decision = ?, auto_category = ?, auto_flags = ?, auto_reason = ?,
       auto_mode = ?, auto_judge_reasoning = ?, auto_judged_at = datetime('now') WHERE id = ?`,
  ).run(d.decision, d.category, JSON.stringify(d.flags), d.reason, mode, d.judgeReasoning ?? null, id);
}

export function setSentBodyChanged(id: string, changed: boolean): void {
  getDatabase().prepare(`UPDATE message_drafts SET sent_body_changed = ? WHERE id = ?`).run(changed ? 1 : 0, id);
}

// --- Zusagen-Task (Migration 029, #696) ---

/** Persistiert den (neu angelegten ODER wiederverwendeten) SmartTasks-Task am Draft. */
export function setSmartTasksTask(draftId: string, taskId: number, guestMessageId: string | null): void {
  getDatabase().prepare(
    `UPDATE message_drafts SET smarttasks_task_id = ?, smarttasks_task_guest_message_id = ? WHERE id = ?`,
  ).run(taskId, guestMessageId, draftId);
}

/**
 * Idempotenz (Spec Punkt 6): existiert im selben Thread bereits ein Task für GENAU
 * diese Gastnachricht (z. B. ein vorheriger Draft, der wegen einer Sprach-Pin-Korrektur
 * verworfen und neu generiert wurde, ohne dass eine neue Gastnachricht eintraf), wird
 * dessen Task-Id zurückgegeben statt eines neuen Anlage-Versuchs. Über alle Draft-
 * Status hinweg (auch discarded/error) — die Zusage bleibt gültig, unabhängig davon,
 * ob der jeweilige Entwurf am Ende gesendet wurde.
 */
export function findExistingSmartTasksTaskId(threadId: string, guestMessageId: string): number | null {
  const row = getDatabase().prepare(
    `SELECT smarttasks_task_id AS id FROM message_drafts
     WHERE thread_id = ? AND smarttasks_task_guest_message_id = ? AND smarttasks_task_id IS NOT NULL
     ORDER BY created_at DESC LIMIT 1`,
  ).get(threadId, guestMessageId) as { id: number } | undefined;
  return row?.id ?? null;
}

// --- Buchungsanfrage (Migration 030, #697) ---

/**
 * Persistiert die mechanisch erkannte Airbnb-Buchungsanfrage (request_kind +
 * platform_deadline_at, siehe booking-request.ts) am Draft — unabhängig vom Gate-Ergebnis
 * (Micha braucht die Frist auch, wenn die Rückfrage auf 'wait' steht).
 */
export function setBookingRequestContext(
  draftId: string,
  requestKind: 'inquiry' | 'request_to_book',
  platformDeadlineAt: string,
): void {
  getDatabase().prepare(
    `UPDATE message_drafts SET request_kind = ?, platform_deadline_at = ? WHERE id = ?`,
  ).run(requestKind, platformDeadlineAt, draftId);
}

/**
 * Micha hat in diesem Thread schon eingegriffen (Spec 5.3 Thread-Ausschlüsse) — #702 Punkt 1:
 * der Ausschluss gilt nur noch für die AKTUELLE Nachrichtenrunde, nicht mehr dauerhaft. Ein
 * verworfener Draft oder eine Feedback-Zeile zählt nur, wenn der betroffene Draft NACH
 * `lastGuestMessageSentAt` angelegt wurde (also zur aktuellen letzten Gastnachricht gehört) —
 * ältere Eingriffe (z. B. ein Verwerfen vor der letzten, längst bestätigten Buchung) blockieren
 * künftige, unabhängige Nachrichten (Fall Anika: eine simple WLAN-Frage nach der Buchung) nicht
 * mehr. draft_feedback bleibt dabei als Wissens-Signal für den Vault erhalten (Feedback-Formular
 * unverändert), verliert aber ebenfalls seine Dauer-Sperre — Feedback ohne draft_id (Formular
 * ohne aktiven Entwurf) gehört zu keiner Runde und blockiert seitdem gar nicht mehr.
 * `lastGuestMessageSentAt` = null (keine Gastnachricht bestimmbar) verhält sich konservativ wie
 * vor #702 (dauerhafte Sperre), da sich dann keine Runde abgrenzen lässt.
 * manually_categorized bleibt bewusst eine DAUERHAFTE Sperre: es ist keinem Draft/keiner Runde
 * zugeordnet (Konversation-weite Klassifikation, z. B. SPAM/PARTY über /admin/threads), also
 * gibt es keinen Rundenbezug, an dem man sie befristen könnte.
 */
export function threadHasHumanIntervention(threadId: string, lastGuestMessageSentAt: string | null): boolean {
  const row = getDatabase().prepare(
    `SELECT (
        EXISTS (
          SELECT 1 FROM message_drafts
          WHERE thread_id = @t AND status = 'discarded'
            AND (@since IS NULL OR datetime(created_at) > datetime(@since))
        )
     OR EXISTS (
          SELECT 1 FROM draft_feedback f
          JOIN message_drafts d ON d.id = f.draft_id
          WHERE f.thread_id = @t
            AND (@since IS NULL OR datetime(d.created_at) > datetime(@since))
        )
     OR EXISTS (SELECT 1 FROM message_threads WHERE id = @t AND manually_categorized = 1)
    ) AS hit`,
  ).get({ t: threadId, since: lastGuestMessageSentAt }) as { hit: number };
  return row.hit === 1;
}

/**
 * Vorheriger Versand in diesem Thread ist fehlgeschlagen oder hängt fest (Final-Review F1):
 * ohne diesen Ausschluss erzeugt der nächste Loop-Lauf nach einem fehlgeschlagenen Auto-Send
 * einen neuen Entwurf, der das Gate erneut passieren und erneut senden könnte (Doppelversand-
 * Risiko, unbegrenzte Opus+Sende-Zyklen bei anhaltendem Fehler).
 *
 * #702 Punkt 2: anders als threadHasHumanIntervention bleibt dieser Ausschluss bewusst
 * DAUERHAFT (ein technisches Problem beim Versand entwertet sich nicht von selbst über neue
 * Nachrichtenrunden) — Micha gibt den Thread stattdessen explizit über den Admin-UI-Button
 * „Auto-Send für diesen Thread wieder erlauben" frei (releaseAutoSendForThread unten). Danach
 * zählen nur noch Drafts, die NACH der Freigabe angelegt wurden (created_at >
 * auto_send_released_at) — ein neuer Fehlschlag NACH der Freigabe sperrt den Thread erneut.
 */
export function threadHasFailedSend(threadId: string): boolean {
  const row = getDatabase().prepare(
    `SELECT EXISTS (
       SELECT 1 FROM message_drafts d JOIN message_threads t ON t.id = d.thread_id
       WHERE d.thread_id = ? AND d.status IN ('error', 'sending')
         AND (t.auto_send_released_at IS NULL OR datetime(d.created_at) > datetime(t.auto_send_released_at))
     ) AS hit`,
  ).get(threadId) as { hit: number };
  return row.hit === 1;
}

/**
 * #702 Punkt 2: Micha gibt einen wegen fehlgeschlagenem/hängendem Versand gesperrten Thread
 * manuell frei (POST /admin/messages/:threadId/release-auto-send) — threadHasFailedSend zählt
 * danach nur noch NEUE Fehlschläge.
 */
export function releaseAutoSendForThread(threadId: string): void {
  getDatabase().prepare(`UPDATE message_threads SET auto_send_released_at = datetime('now') WHERE id = ?`).run(threadId);
}

export function countAutoSentSince(sinceIso: string): number {
  const row = getDatabase().prepare(
    `SELECT COUNT(*) AS n FROM message_drafts WHERE sent_by = 'auto' AND datetime(sent_at) >= datetime(?)`,
  ).get(sinceIso) as { n: number };
  return row.n;
}

export interface AwaitingDraftRow {
  id: string; thread_id: string; provider: string; status: string; created_at: string;
  reason: string; guest_name: string | null; listing_id: string; source: string;
  last_guest_message: string | null; smarttasks_task_id: number | null;
  // Buchungsanfrage (#697)
  request_kind: 'inquiry' | 'request_to_book' | null;
  platform_deadline_at: string | null;
  auto_category: string | null;
  auto_decision: 'auto' | 'wait' | null;
  auto_mode: 'off' | 'shadow' | 'live' | null;
  // #702 Punkt 4: reasoning-Feld des Prüfmodells (siehe setAutoDecision) — zusätzlich zum
  // Policy-Text `reason` oben.
  auto_judge_reasoning: string | null;
}

/**
 * Entwürfe, die auf Micha warten: Gate-Entscheidung 'wait' (noch pending), Send-Fehler,
 * oder hängende Sends (Final-Review F3, re-review-korrigiert) — zwei Zustände, die sonst
 * durchs Raster fallen: (a) auto_decision='auto'/auto_mode='live'/status='pending', aber
 * nie gesendet (Claim verloren / Prozess gestorben — blockiert neue Entwürfe im Thread und
 * wird nie gepusht), und (b) status='sending' nach einem Crash mitten im Versand (manuell
 * oder auto — deshalb kein auto_mode-Filter hier). 10-Minuten-Schwelle, damit ein Auto-Send,
 * der gerade erst geurteilt/geclaimt wurde, nicht fälschlich als hängend gilt.
 *
 * WICHTIG: der auto+pending-Fall gilt NUR für auto_mode='live' — im Schattenmodus ist
 * auto_decision='auto'/status='pending' der Normalzustand (nichts wird automatisch
 * gesendet, der Entwurf wartet bewusst auf Micha), Spec 4 verlangt „Push nur für
 * wait-Entscheidungen, auch im Schattenmodus". Ohne diesen Filter würde jeder gute
 * Schatten-Entwurf nach 10 Minuten fälschlich als „hängt" gepusht.
 *
 * #697: Buchungsanfrage-Entwürfe (auto_category='buchungsanfrage') erscheinen ZUSÄTZLICH IMMER,
 * wenn die Entscheidung 'auto' ist — egal ob live bereits gesendet oder im Schatten nur
 * protokolliert: Micha muss die Airbnb-Entscheidung (Annehmen/Ablehnen) so oder so treffen,
 * unabhängig davon, ob die (reine Rückfrage-)Antwort automatisch rausging.
 *
 * #686 Nachzieh-Liste: `since`-Vergleich ist `>=` (inklusiv, vereinheitlicht mit
 * countAutoSentSince) statt vormals `>` — created_at kommt aus `datetime('now')` und hat daher
 * nur Sekundenauflösung. Ein Cursor-Aufrufer, der `since` exakt auf den created_at-Wert des
 * zuletzt gesehenen Drafts setzt (übliches Poll-Muster), hätte mit `>` jeden WEITEREN Draft
 * derselben Sekunde für immer verloren (kein späterer Poll liefert ihn nach). Mit `>=` taucht
 * höchstens der Cursor-Draft selbst nochmal auf — das ist harmlos, WENN der Aufrufer per
 * `draftId` (im Response enthalten) dedupliziert; ein für immer verlorener Draft ist es nicht.
 */
export function getAwaitingDrafts(sinceIso: string, limit: number): AwaitingDraftRow[] {
  return getDatabase().prepare(
    `SELECT d.id, d.thread_id, d.provider, d.status, d.created_at, d.smarttasks_task_id,
       d.request_kind, d.platform_deadline_at, d.auto_category, d.auto_decision, d.auto_mode,
       d.auto_judge_reasoning,
       CASE
         WHEN d.status = 'error' THEN 'Auto-Send fehlgeschlagen: ' || COALESCE(d.error, '?')
         WHEN d.status = 'sending' THEN 'Versand hängt — bitte manuell prüfen'
         WHEN d.auto_decision = 'auto' AND d.auto_mode = 'live' AND d.status = 'pending' THEN 'Auto-Send hängt — bitte manuell prüfen'
         WHEN d.auto_category = 'buchungsanfrage' AND d.auto_decision = 'auto' AND d.status = 'sent'
           THEN 'Rückfrage automatisch gesendet — Entscheidung in Airbnb nach Gast-Antwort'
         WHEN d.auto_category = 'buchungsanfrage' AND d.auto_decision = 'auto' AND d.auto_mode = 'shadow'
           THEN 'Rückfrage wäre automatisch gesendet worden (Schatten) — Entscheidung in Airbnb nach Gast-Antwort'
         ELSE COALESCE(d.auto_reason, '')
       END AS reason,
       t.guest_name, t.listing_id, t.source,
       (SELECT m.body FROM messages m WHERE m.thread_id = t.id AND m.direction = 'inbound'
          ORDER BY m.sent_at DESC, m.created_at DESC LIMIT 1) AS last_guest_message
     FROM message_drafts d JOIN message_threads t ON t.id = d.thread_id
     WHERE datetime(d.created_at) >= datetime(?)
       AND (
         (d.auto_decision = 'wait' AND d.status = 'pending')
         OR d.status = 'error'
         OR (d.auto_decision = 'auto' AND d.auto_mode = 'live' AND d.status = 'pending' AND datetime(d.auto_judged_at) < datetime('now', '-10 minutes'))
         OR (d.status = 'sending' AND datetime(d.created_at) < datetime('now', '-10 minutes'))
         OR (d.auto_category = 'buchungsanfrage' AND d.auto_decision = 'auto')
       )
     ORDER BY d.created_at ASC LIMIT ?`,
  ).all(sinceIso, limit) as AwaitingDraftRow[];
}

export interface AutoSendStats {
  autoSent: number; waited: number; shadowWouldAuto: number;
  shadowUnchanged: number; shadowChanged: number; shadowDiscarded: number;
}
export function getAutoSendStats(sinceIso: string): AutoSendStats {
  return getDatabase().prepare(
    `SELECT
       SUM(sent_by = 'auto') AS autoSent,
       SUM(auto_decision = 'wait') AS waited,
       SUM(auto_decision = 'auto' AND auto_mode = 'shadow') AS shadowWouldAuto,
       SUM(auto_decision = 'auto' AND auto_mode = 'shadow' AND status = 'sent' AND sent_body_changed = 0) AS shadowUnchanged,
       SUM(auto_decision = 'auto' AND auto_mode = 'shadow' AND status = 'sent' AND sent_body_changed = 1) AS shadowChanged,
       SUM(auto_decision = 'auto' AND auto_mode = 'shadow' AND status = 'discarded') AS shadowDiscarded
     FROM message_drafts WHERE datetime(created_at) >= datetime(?)`,
  ).get(sinceIso) as AutoSendStats;
}

export function listAutoDecisions(limit: number): Array<MessageDraft & { guest_name: string | null }> {
  return getDatabase().prepare(
    `SELECT d.*, t.guest_name FROM message_drafts d JOIN message_threads t ON t.id = d.thread_id
     WHERE d.auto_decision IS NOT NULL ORDER BY d.created_at DESC LIMIT ?`,
  ).all(limit) as Array<MessageDraft & { guest_name: string | null }>;
}

/** Zuletzt gesendeter Draft eines Threads — für das grüne Auto-Send-Badge, wenn es gerade keinen aktiven (pending) Draft gibt. */
export function getLastSentDraftByThread(threadId: string): MessageDraft | null {
  const db = getDatabase();
  const row = db
    .prepare(`SELECT * FROM message_drafts WHERE thread_id = ? AND status = 'sent'
              ORDER BY sent_at DESC LIMIT 1`)
    .get(threadId) as MessageDraft | undefined;
  return row ?? null;
}
