import { callClaudeTool, SONNET_MODEL, type ClaudeToolDefinition } from './anthropic-client.js';
import type { MessageThread, Message } from '../types/messages.js';
import { LANGUAGE_LABEL, type SupportedLanguage } from '../utils/language-detect.js';
import { buildTodayBlock } from './auto-send/today-facts.js';
import type { BookingRequestKind } from './booking-request.js';
import type { AlterationSituation } from './alteration-request.js';

/** #758: zentrale Sonnet-Konstante (claude-sonnet-5-5) aus anthropic-client. */
export const DRAFT_MODEL = SONNET_MODEL;

export const SUBMIT_REPLY_TOOL: ClaudeToolDefinition = {
  name: 'submit_reply',
  description: 'Gib die fertige Antwort an den Gast zurück — oder melde explizit, dass keine Antwort nötig ist.',
  input_schema: {
    type: 'object',
    properties: {
      no_reply_needed: {
        type: 'boolean',
        description:
          'true NUR, wenn die Nachricht weder eine Frage noch ein Anliegen/eine Bitte enthält ' +
          '(reines Danke/Bestätigung/Emoji). Sonst immer false — auch wenn die Nachricht mit Dank beginnt.',
      },
      reply: {
        type: 'string',
        description: 'Die fertige Gastantwort in Michas Stimme. Pflicht, wenn no_reply_needed=false.',
      },
      reason: {
        type: 'string',
        description: 'Kurze Begründung, nur wenn no_reply_needed=true (z. B. "reine Dankesnachricht ohne Frage").',
      },
    },
    required: ['no_reply_needed'],
  },
};

/**
 * #379: drei unterscheidbare Ausgänge statt string|null — der Aufrufer (generate-drafts.ts,
 * routes/messages.ts Regenerate) muss (b) bewusstes "keine Antwort nötig" von (c) technischem
 * Ausfall (Tool-Output fehlt/unbrauchbar) trennen können: nur (b) darf markThreadAiNoReply auslösen,
 * (c) soll beim nächsten Lauf erneut versucht werden.
 */
export type DraftResult =
  | { kind: 'text'; body: string }
  | { kind: 'no_reply'; reason: string }
  | { kind: 'failed'; error: string };

export interface DraftInput {
  thread: MessageThread;
  messages: Message[];
  voice: string;
  facts: string;
  // #364: what the platform already knows about this thread's booking
  // (dates, nights, guests, confirmation code) — see booking-context.ts.
  // null when the thread isn't linked to a reservation/inquiry.
  bookingContext: string | null;
  // #695: deterministisch erkannte Sprache der letzten Gastnachricht (language-detect.ts) —
  // optional mit Fallback Deutsch, damit bestehende Aufrufer/Tests ohne dieses Feld weiterlaufen.
  guestLanguage?: SupportedLanguage;
  // #695: true beim automatischen Neuversuch nach language_mismatch — fügt eine explizite
  // Korrektur-Anweisung an (Spec Punkt 3).
  languageRetry?: boolean;
  // #697: mechanisch erkannte Airbnb-Buchungsanfrage (booking-request.ts) — wählt den
  // Buchungsanfrage-Prompt-Block (Rückfrage statt normaler Antwort). Optional, damit
  // bestehende Aufrufer/Tests ohne dieses Feld weiterlaufen (dann der normale Prompt).
  isBookingRequest?: boolean;
  // #1004 (Fall #1002): Art der offenen Buchungsanfrage aus findOpenBookingRequest — benennt im
  // Buchungsanfrage-Block Inquiry vs. Request-to-Book und wählt den Schlusssatz. Optional
  // (null/fehlend = unbekannt); nur wirksam zusammen mit isBookingRequest.
  requestKind?: BookingRequestKind | null;
  // #698 (Fall Lorenzo U19): Zeitpunkt der Entwurfs-Generierung für den HEUTE-Fakt
  // (today-facts.ts) — optional, Default new Date() in generateDraftForThread/buildSystemPrompt,
  // damit bestehende Aufrufer/Tests ohne dieses Feld weiterlaufen. In Tests injizierbar, damit
  // Datum/Wochentag deterministisch geprüft werden können.
  now?: Date;
  // #976 (Fall Gast AS 20.–21.11.): offener Änderungsantrag (Hostex-Karte) bzw. per Heuristik
  // erkannter Änderungswunsch — resolveAlterationSituation (alteration-request.ts). Optional,
  // null/fehlend = kein Änderungs-Block.
  alteration?: AlterationSituation | null;
}
export interface DraftDeps {
  call: typeof callClaudeTool;
}
const defaultDeps: DraftDeps = { call: callClaudeTool };

// #440 Root-Cause-Fix: Der Prompt gab dem Modell VOICE+OBJEKTWISSEN bisher nur als flachen
// Text-Dump, ohne je explizit zu sagen, auf welchem KANAL dieser Thread läuft oder ob die
// Buchung BESTÄTIGT ist — das Modell musste beides aus dem Gesprächstext erraten und dann selbst
// entscheiden, welche der vielen (teils kanalspezifischen, teils gegenläufigen) Regeln im
// Vault-Text gerade gelten. Zwei Vorfälle (Fall Sophie: Domain-Link in einer Airbnb-Anfrage vor
// Bestätigung; Fall Sophie #2: KI bietet in einer Airbnb-Anfrage ein Direktbuchungs-"Angebot" an)
// gingen exakt darauf zurück — die richtigen (zustandsabhängigen!) Regeln standen im Vault, aber
// ohne strukturierten Kanal-/Status-Fakt + Präzedenz-Hinweis wählte das Modell die falsche von
// mehreren im selben Dokument stehenden Anweisungen. WICHTIG (Präzisierung Micha): Es gibt KEIN
// pauschales Airbnb-Link-Verbot — nach bestätigter Buchung sind Links (z. B. Hausordnung)
// ausdrücklich erwünscht, das Vault formuliert seine Regeln bereits zustandsabhängig. Dieser Block
// macht Kanal+Status zur expliziten, nicht zu erratenden Tatsache und weist das Modell an,
// kanalfremde/statusfremde Regeln zu ignorieren bzw. explizite Ausnahmeklauseln im Vault-Text
// (z. B. "AUSNAHME Airbnb vor bestätigter Buchung") vorrangig zu behandeln — bewusst OHNE die
// konkreten Regeln hier zu duplizieren (die bleiben allein im Vault, sonst zwei Quellen für
// dieselbe Policy, die auseinanderlaufen können).
const CHANNEL_LABELS: Record<MessageThread['channel'], string> = {
  airbnb: 'Airbnb',
  'booking.com': 'Booking.com',
  vrbo: 'VRBO',
  direct_email: 'Direkt-E-Mail',
  manual: 'Manuell erfasst',
  landfolk: 'Landfolk',
  meetreet: 'Meetreet',
  other: 'Sonstiger/unbekannter Kanal',
};

// Deckungsgleich mit reservation-repository.ts (`status IN ('confirmed','reserved')` = aktive/
// bestätigte Buchung). Alles andere (null, 'inquiry', storniert/abgelehnt, unbekannt …) gilt
// konservativ als NICHT bestätigt — lieber eine bestätigte Buchung fälschlich vorsichtig
// behandeln als umgekehrt. Seit #441 gilt das auch für Hostex-Threads: sync-hostex-messages.ts
// löst reservation_status über einen Lookup auf inquiries.hostex_conversation_id auf (Mapper
// STATUS_TO_INQUIRY in reservation-mapper.ts nutzt exakt dasselbe Vokabular 'confirmed'/
// 'reserved'/'inquiry'/… wie Guesty) — vorher stand hier hart null (Grauzone, siehe #440-Bericht).
const CONFIRMED_RESERVATION_STATUSES = new Set(['confirmed', 'reserved']);

function resolveBookingStatusLabel(reservationStatus: string | null): string {
  if (reservationStatus && CONFIRMED_RESERVATION_STATUSES.has(reservationStatus)) {
    return 'bestätigt';
  }
  return 'NICHT bestätigt (bzw. Status unbekannt — konservativ als unbestätigt behandeln)';
}

function buildThreadFactsBlock(thread: Pick<MessageThread, 'channel' | 'reservation_status'>): string {
  const channelLabel = CHANNEL_LABELS[thread.channel] ?? thread.channel;
  const statusLabel = resolveBookingStatusLabel(thread.reservation_status);
  return [
    '### FAKTEN ZU DIESEM GESPRÄCH — gelten VOR jeder Regel in Voice/Objektwissen unten ###',
    `Kanal dieses Threads: ${channelLabel}`,
    `Buchungsstatus dieses Threads: ${statusLabel}`,
    'Voice und Objektwissen unten gelten kanal- und statusübergreifend — nicht jede Zeile darin passt ' +
      'auf DIESES Gespräch. Eine Regel, die einen ANDEREN Kanal oder Buchungsstatus voraussetzt (z. B. ' +
      '„bei Direktbuchung", „nach fester Buchung", „vor bestätigter Buchung", „Direktlink mitgeben"), ' +
      'wende nur an, wenn Kanal/Status oben dazu passen — sonst gilt sie HIER NICHT. Enthält das ' +
      'Objektwissen eine explizite Kanal-/Status-Ausnahme (z. B. „AUSNAHME Airbnb vor bestätigter ' +
      'Buchung"), hat DIESE Ausnahme Vorrang vor der allgemeineren Regel im selben Dokument, wenn ' +
      'Kanal/Status oben zutreffen.',
    '### ENDE FAKTEN ###',
  ].join('\n');
}

// #697 (Fall Anika Farmhouse, 20.09.2026): eigener Prompt-Block für Airbnb-Buchungsanfragen
// (Inquiry/Request-to-Book) — nie eine Zusage/Bestätigung, keine internen Prüfbedingungen an
// den Gast. Bewusst OHNE die konkreten Objektregeln (Limit, ausgeschlossene Event-Arten) hier zu
// duplizieren — die stehen im OBJEKTWISSEN (Vault), der Block weist nur an, WIE damit umzugehen ist.
// #1004 (Fall #1002, 02.11.2026, Micha: „inquisitorische Frage nach dem Anlass muss weg"): die
// frühere Pflichtstruktur (Dank → Rückfrage Anlass/Personenzahl/Ablauf → Limit → „Bestätigung
// folgt") ist ersetzt. Der Entwurf stellte im Fall #1002 keine Frage, schloss aber trotzdem mit
// „Sobald ich deine Antworten habe …" (Struktur-Punkt 4 ohne Punkt 2). Neu: Art der Anfrage als
// Fakt (requestKind aus findOpenBookingRequest), auf den Inhalt eingehen, höchstens EINE gezielte
// Rückfrage und nur bei Hausregel-Bezug, Schlusssatz je Art, Verbot des Verweises auf nicht
// gestellte Fragen. Schlusssatz bewusst mit dem Substantiv „Bestätigung" — die Verbformen
// (bestätigt/bestätige/angenommen) stoppt der mechanische Check confirmation_words.
const REQUEST_KIND_LABEL: Record<BookingRequestKind, string> = {
  request_to_book:
    'Request-to-Book) — der Gast hat bereits eine verbindliche Buchungsanfrage gestellt; Micha nimmt sie an oder lehnt sie ab',
  inquiry:
    'Inquiry) — der Gast hat bisher nur angefragt bzw. eine Frage gestellt, noch KEINE verbindliche Buchungsanfrage',
};

function buildBookingClosingRule(requestKind: BookingRequestKind | null): string {
  if (requestKind === 'request_to_book') {
    return '4. Schlusssatz: kündige an, dass die Bestätigung in Kürze kommt — sinngemäß „die Bestätigung kommt in ' +
      'Kürze" (Substantiv „Bestätigung", NICHT „bestätigt/bestätige ich/angenommen"; keine Zusage, dass die Buchung ' +
      'angenommen ist). Hast du die eine Rückfrage aus Punkt 2 gestellt, ersetzt ein kurzer Bezug darauf diesen Satz ' +
      '(z. B. „Sag mir kurz Bescheid, dann melde ich mich gleich wieder.").';
  }
  if (requestKind === 'inquiry') {
    return '4. Schlusssatz: lade den Gast ein, die Buchungsanfrage zu stellen — sinngemäß „Wenn es für euch passt, ' +
      'stell gern die Buchungsanfrage." (ohne die Plattform zu nennen). Hast du die eine Rückfrage aus Punkt 2 ' +
      'gestellt, kommt die Einladung nach der Frage.';
  }
  return '4. Schlusssatz: freundlich und offen, ohne Zusage und ohne Ankündigung einer Bestätigung.';
}

function buildBookingRequestBlock(requestKind: BookingRequestKind | null): string {
  const kindLabel = requestKind ? REQUEST_KIND_LABEL[requestKind] : 'Inquiry oder Request-to-Book)';
  return [
    '### BUCHUNGSANFRAGE — Sonderregeln für DIESE Antwort (haben Vorrang vor allgemeinen Regeln unten) ###',
    `Dies ist eine Airbnb-Buchungsanfrage (${kindLabel}.`,
    'Die Entscheidung (Annehmen/Ablehnen) trifft ausschließlich Micha. Deine Antwort enthält deshalb KEINE Zusage ' +
      'und KEINE Bestätigung als Fakt, KEIN Angebot, KEIN Preis, KEIN Hold.',
    'Baue die Antwort so auf:',
    '1. Kurzer Dank für die Anfrage. Geh auf den INHALT der Gastnachricht ein: spiegle die Vorfreude bzw. das, was ' +
      'der Gast über sich und seinen Aufenthalt erzählt, und beantworte seine Fragen (z. B. Tipps zur Umgebung, ' +
      'Ausstattung) aus dem OBJEKTWISSEN — fehlt ein Fakt, bleib allgemein.',
    '2. KEINE Routine-Rückfrage nach Anlass, Ablauf oder Personenzahl. Nur wenn die Gastnachricht SELBST einen ' +
      'Hausregel-Punkt aus dem OBJEKTWISSEN berührt — eine Feier, einen Geburtstag, eine Hochzeit oder ein Event, ' +
      'oder eine Personenzahl über dem Limit des Objekts (Tagesgäste mitgezählt) —, stellst du GENAU EINE gezielte ' +
      'Rückfrage zu diesem Punkt (bei Feier/Event: wie viele Personen insgesamt dabei sind, INKLUSIVE Tagesgästen) ' +
      'und nennst das Personenlimit und die laut OBJEKTWISSEN ausgeschlossenen Event-Arten als reinen FAKT. Diese ' +
      'Tagesgäste-Frage ist erlaubt, obwohl die Plattform die Personenzahl kennt — Tagesgäste kennt sie nicht. ' +
      'Berührt die Nachricht keinen Hausregel-Punkt (z. B. Freundesgruppe, Familienurlaub, ruhiges Wochenende ' +
      'innerhalb des Limits), stellst du KEINE Rückfrage.',
    '3. Interne Prüfbedingungen NIEMALS als Aussage ("passt das für uns", "steht einer Bestätigung nichts im Weg", ' +
      '"eine Runde wie eure ist willkommen/passt gut") — ' +
      'Unsicheres nur als Frage an den Gast, nie als Aussage über den Ausgang der Prüfung.',
    buildBookingClosingRule(requestKind),
    // #976: Kürze-Regel gilt auch hier (#1004-Abnahme: Tipps-Antwort war zu lang).
    'Länge: auch hier gilt die LÄNGE-Regel oben — insgesamt höchstens 3–4 kurze Sätze. Tipps-Fragen knapp ' +
      'beantworten: eine kleine Auswahl (höchstens zwei, drei Tipps) in EINEM Satz, keine Liste, keine Beschreibungen.',
    'Verboten: auf „deine Antworten“, „deine Rückmeldung“ oder sonstige ausstehende Fragen verweisen (z. B. „Sobald ' +
      'ich deine Antworten habe …"), wenn du in DIESER Antwort keine Frage gestellt hast. Die Plattform nie beim ' +
      'Namen nennen (Voice-Regel Micha 21.09.2026: Airbnb, Guesty o. ä. nie im Text an den Gast; "über Airbnb ' +
      'bestätigen" ist tabu).',
    '### ENDE BUCHUNGSANFRAGE-REGELN ###',
  ].join('\n');
}

// #976 (Micha 26.10.2026: „die Antworten sind alle immer etwas zu lang und ausschweifend"):
// harte Längenregel als eigener Block VOR Voice/Objektwissen — die Wiki-Regel „Kürze zuerst"
// (Grundsätze, Harte Ausgaberegeln) steht zwar im Vault, wurde aber von der Menge an
// Objektwissen regelmäßig überstimmt (Bot zählte ungefragt Betten/Bad/Bettwäsche auf).
// Ausnahmeliste explizit: nur Angebote, Absagen und Problemfälle dürfen länger sein.
export const LENGTH_RULE_BLOCK = [
  '### LÄNGE DER ANTWORT — harte Regel, gilt vor Voice und Objektwissen ###',
  'Routine-Antworten (Frage beantwortet, Bestätigung, Dank, kleine Zusage) haben HÖCHSTENS 2–3 kurze Sätze, ' +
    'ca. 300 Zeichen (ohne Anrede und Gruß). Was man am Handy nicht ohne Scrollen liest, ist zu lang.',
  '- Beantworte NUR, was der Gast gefragt oder angesprochen hat. Mehrere Fragen: je Frage höchstens ein Satz.',
  '- Wiederhole KEINE Fakten, die der Gast schon kennt: Buchungsdaten (Zeitraum, Nächte, Personenzahl) und ' +
    'Inhalte der Inseratsbeschreibung (Betten, Bad, Ausstattung, Platz für X Gäste).',
  '- KEINE unaufgeforderten Zusatzinfos, Hinweise, Regeln oder Ausstattungsaufzählungen (Bettwäsche, Handtücher, ' +
    'Tor, Verkehr, Anreise …) — die stehen im Gäste-Handbuch.',
  '- Länger werden darf eine Antwort NUR bei: (1) einem Angebot, (2) einer Absage/Ablehnung, (3) einem Problemfall ' +
    '(Beschwerde, Schaden, Störung/Ausfall, Notfall).',
  '### ENDE LÄNGE ###',
].join('\n');

// #976 (Fall Gast AS 20.–21.11.2026): Gast hat sich bei der Personenzahl vertan und die Änderung
// schon beantragt — der Entwurf leitete ihn trotzdem an, die Buchung selbst anzupassen, und zählte
// die Ausstattung auf. Situation kommt als Fakt aus alteration-request.ts (Hostex-Karte bzw.
// Heuristik); der Block sagt nur, WIE zu antworten ist (Wiki: „Gast meldet Buchungsfehler /
// Änderungsantrag läuft").
function buildAlterationBlock(s: AlterationSituation): string {
  const situation = s.kind === 'pending_request'
    ? 'Der Gast hat für diese Buchung BEREITS einen Änderungsantrag gestellt' +
      (s.describe ? ` (Anzeige der Plattform: „${s.describe}")` : '') +
      '. Der Antrag liegt bei Micha zur Annahme — der Gast muss NICHTS mehr tun.'
    : `Die Gastnachricht meldet einen Änderungswunsch zur Buchung (${s.detail}). Meist hat der Gast die ` +
      'Änderung bereits beantragt; Micha kümmert sich darum — der Gast muss NICHTS weiter tun.';
  const confirm = s.kind === 'pending_request'
    ? 'sinngemäß „alles gut, ich nehme die Änderung auf drei Gäste an"'
    : 'sinngemäß „kein Problem, ich kümmere mich um die Änderung auf drei Gäste"';
  return [
    '### ÄNDERUNG DER BUCHUNG — Sonderregeln für DIESE Antwort (Vorrang vor allgemeinen Regeln unten) ###',
    situation,
    `Antworte mit einer kurzen Bestätigung in 1–2 Sätzen, ${confirm}.`,
    'VERBOTEN: den Gast auffordern oder anleiten, die Buchung selbst zu ändern oder anzupassen (z. B. „pass die ' +
      'Personenzahl direkt in der Buchung an", „kannst du direkt dort ändern"); Ausstattung, Betten, Bad, ' +
      'Bettwäsche oder Platzangaben aufzählen; die Plattform beim Namen nennen.',
    'Passt die neue Personenzahl bzw. der neue Zeitraum laut OBJEKTWISSEN offensichtlich NICHT (z. B. mehr Personen ' +
      'als die Maximalbelegung), sage KEINE Annahme zu — schreibe nur kurz, dass du dich gleich meldest.',
    '### ENDE ÄNDERUNG ###',
  ].join('\n');
}

// Exportiert (statt privat) für das Abnahme-Werkzeug src/scripts/dump-draft-prompt.ts (#440,
// SmartTasks-Doc #20) — der Prompt-Dump MUSS exakt dieselbe Funktion verwenden wie der echte
// Generierungspfad, sonst könnte das Abnahme-Tool unbemerkt vom tatsächlichen Prompt abweichen.
export function buildSystemPrompt(
  voice: string,
  facts: string,
  bookingContext: string | null,
  thread: Pick<MessageThread, 'channel' | 'reservation_status'>,
  // #695: harter Fakt statt Prosa-Regel — Default Deutsch (deckungsgleich mit dem Fallback in
  // language-detect.ts), damit bestehende Aufrufer ohne dieses Argument weiterlaufen.
  guestLanguage: SupportedLanguage = 'de',
  languageRetry = false,
  // #697: siehe DraftInput.isBookingRequest.
  isBookingRequest = false,
  // #698 (Fall Lorenzo U19): LETZTER optionaler Parameter — Signatur bleibt rückwärtskompatibel,
  // dump-draft-prompt.ts (#440-Abnahme-Werkzeug) ruft buildSystemPrompt ohne dieses Argument
  // weiterhin unverändert lauffähig auf.
  now: Date = new Date(),
  // #1004: Art der offenen Buchungsanfrage (findOpenBookingRequest) — nur wirksam mit
  // isBookingRequest; null = unbekannt (generischer Kontext, kein artspezifischer Schlusssatz).
  requestKind: BookingRequestKind | null = null,
  // #976: Änderungsantrag/-wunsch (alteration-request.ts) — LETZTER optionaler Parameter,
  // Signatur bleibt rückwärtskompatibel. Nie zusammen mit dem Buchungsanfrage-Block.
  alteration: AlterationSituation | null = null,
): string {
  const lines = [
    buildThreadFactsBlock(thread),
    // #695 (Fall Lorenzo U19, 20.09.2026): als eigene harte Zeile VOR Voice/Objektwissen, damit
    // sie nicht von den (meist deutschen) Voice-Beispielen überstimmt wird.
    `ANTWORTSPRACHE: ${LANGUAGE_LABEL[guestLanguage]}`,
    // #698 (Fall Lorenzo U19, 20.09.2026): der Prompt kannte bisher weder Wochentag noch
    // Uhrzeit — Zeitbezüge kamen ausschließlich aus der Gastnachricht. Ein sonntags gepostetes
    // "have a wonderful Sunday" wurde deshalb erst montags mit gespiegeltem "schönen Sonntag"
    // versandt. Direkt nach ANTWORTSPRACHE, vor Voice/Objektwissen — als harter Fakt.
    buildTodayBlock(now, bookingContext),
    // #976: Längenregel für ALLE Antworten (auch Buchungsanfragen, dort mit Tipps-Zusatz im Block).
    LENGTH_RULE_BLOCK,
  ];
  if (isBookingRequest) lines.push(buildBookingRequestBlock(requestKind));
  else if (alteration) lines.push(buildAlterationBlock(alteration));
  lines.push(
    'Du entwirfst eine Antwort auf eine Gastnachricht für eine Ferienunterkunft, in Michas Stimme.',
    'Halte dich strikt an den folgenden Ton/Stil (Voice):',
    '--- VOICE ---', voice, '--- ENDE VOICE ---',
    'Nutze ausschließlich die folgenden Objektfakten. Erfinde nichts; fehlt ein Fakt, bleib allgemein.',
    '--- OBJEKTWISSEN ---', facts, '--- ENDE OBJEKTWISSEN ---',
  );
  if (bookingContext) {
    lines.push(
      '--- BUCHUNGSKONTEXT (liegt der Plattform bereits vor) ---',
      bookingContext,
      '--- ENDE BUCHUNGSKONTEXT ---',
      // #976: früher „beziehe dich direkt darauf (z. B. bei Bestätigungen den Zeitraum nennen)" —
      // widersprach der Kürze-Regel (keine Wiederholung von Buchungsdaten, die der Gast kennt).
      'Diese Buchungsdaten sind der Plattform UND dem Gast bekannt — frage den Gast NIEMALS erneut nach Zeitraum, ' +
        'Nächten oder Personenzahl und wiederhole sie auch nicht ungefragt; nenne sie nur, wenn der Gast danach fragt.'
    );
  }
  if (languageRetry) {
    // #695 Spec Punkt 3: genau ein automatischer Neuversuch nach mechanisch/vom Prüfmodell
    // erkanntem language_mismatch — explizite Korrektur-Anweisung statt stillem zweiten Versuch.
    lines.push(
      `Die vorige Antwort war in der falschen Sprache. Schreibe ausschließlich auf ${LANGUAGE_LABEL[guestLanguage]}.`,
    );
  }
  lines.push(
    // #695: verweist auf die harte ANTWORTSPRACHE-Zeile oben statt eigener Prosa-Regel — die
    // Sprache ist ein Fakt, kein Stilhinweis, den Voice-Beispiele überstimmen dürfen.
    'Regeln: Kein Auto-Versand von Zugangscodes. Antworte AUSSCHLIESSLICH auf der oben festgelegten ' +
      'ANTWORTSPRACHE — unabhängig von der Sprache der Voice-Beispiele, kein Sprachenmix. Kurz und konkret (siehe LÄNGE-Regel oben).',
    // #698 (Fall Lorenzo U19, 20.09.2026): Tages-/Tageszeitwünsche des Gastes NICHT wörtlich
    // spiegeln — der Entwurf wird ggf. an einem anderen Tag/zu anderer Zeit gelesen (Vorfall:
    // Gast schrieb sonntags "have a wonderful Sunday", der Entwurf spiegelte "schönen Sonntag",
    // gesendet wurde aber erst montags). AUSNAHME für buchungsbezogene Zeitangaben (Check-in-
    // Zeit, Anreise-/Abreisetag) — die bleiben konkret, siehe HEUTE-Block oben/Buchungskontext.
    'Tages- und Tageszeitwünsche des Gastes (z. B. „schönen Sonntag", „guten Abend", „have a nice ' +
      'Sunday") NIEMALS wörtlich spiegeln — deine Antwort wird möglicherweise erst an einem anderen ' +
      'Tag oder zu einer anderen Uhrzeit gelesen. Formuliere stattdessen neutral (z. B. „euch eine ' +
      'gute Zeit", „eine schöne Woche"). AUSNAHME: Zeitangaben, die die Buchung selbst betreffen ' +
      '(Check-in-Zeit, Anreise-/Abreisetag laut HEUTE-Block/Buchungskontext), bleiben konkret. Nenne ' +
      'einen Wochentag nur, wenn er zum HEUTE-Fakt oder zu Anreise/Abreise passt.',
    'Keine Antwort nötig (no_reply_needed=true) NUR, wenn die Nachricht WEDER eine Frage NOCH ein ' +
      'Anliegen/eine Bitte enthält — also eine reine Dankes-/Bestätigungsnachricht oder ein bloßes Emoji.',
    'Beginnt eine Nachricht mit Dank, enthält aber danach eine Frage oder ein Anliegen, ist das KEIN ' +
      'Grund für no_reply_needed=true — antworte auf die Frage/das Anliegen. Im Zweifel antworten ' +
      '(no_reply_needed=false).',
    // #697: gilt für ALLE Kategorien, nicht nur Buchungsanfragen (Fall Anika: "passt Zweck und
    // Personenzahl, steht einer Bestätigung nichts im Weg" ging wörtlich an den Gast raus).
    'Interne Prüfbedingungen (z. B. ob etwas "passt", "genehmigt" oder "bestätigt" werden kann) ' +
      'NIEMALS als Aussage oder Zusicherung an den Gast schreiben — formuliere sie stattdessen als ' +
      'offene Rückfrage an den Gast (z. B. statt "die Personenzahl passt" → "wie viele Personen ' +
      'wärt ihr insgesamt?").',
    'Gib die Antwort über das Tool submit_reply zurück: entweder reply (nur der Nachrichtentext, ' +
      'keine Anrede-Meta) mit no_reply_needed=false, oder no_reply_needed=true mit reason.'
  );
  return lines.join('\n');
}

/**
 * #384: die Anrede soll immer die Person treffen, die die LETZTE eingegangene Gastnachricht
 * unterschrieben hat (z. B. Buchung läuft auf "Anna", aber die Nachricht endet mit "Viele Grüße,
 * Lisa" → Anrede "Lisa") — nicht pauschal den Buchungsnamen. Bewusst als Prompt-Instruktion statt
 * deterministischer Regex-Extraktion gelöst: Signaturen sind sprachlich zu vielgestaltig (Sprache,
 * Grußformel, mit/ohne Nachname) für zuverlässiges Pattern-Matching, und das Modell sieht die
 * letzte Gastnachricht ohnehin im Verlauf — passt zum bestehenden Muster dieser Datei, in dem auch
 * andere Nuancen (z. B. no_reply_needed) dem Modell per Instruktion übergeben werden statt Regex.
 */
export function buildConversation(messages: Message[], guestName: string | null): string {
  const hasInbound = messages.some((m) => m.direction === 'inbound');
  const lines = messages.map((m) => {
    const who = m.direction === 'inbound' ? 'Gast' : m.direction === 'outbound' ? 'Host' : 'System';
    return `${who}: ${m.body}`;
  });

  let nameLine: string;
  if (!hasInbound) {
    // Keine Gastnachricht vorhanden (z. B. leerer Verlauf) — keine Signatur zu prüfen,
    // altes Verhalten unverändert: Buchungsname bzw. namenlose Begrüßung.
    nameLine = guestName
      ? `Der Gast heißt „${guestName}". Sprich ihn direkt mit Vornamen an (Begrüßungs-Stil siehe Voice) — niemals mit „Liebe/Lieber Gast" o. Ä.`
      : 'Der Name des Gastes ist nicht bekannt — nutze eine natürliche namenlose Begrüßung im Voice-Stil, niemals „Liebe/Lieber Gast".';
  } else {
    const signatureRule =
      'Anrede-Regel: Prüfe, ob die LETZTE Gastnachricht im Verlauf unten mit einem Namen ' +
      'unterschrieben ist (z. B. „Viele Grüße, Lisa", „LG Lisa", „Danke, Lisa Müller"). Ist eine ' +
      'Signatur erkennbar, sprich den Gast in der Anrede mit DIESEM Vornamen an — bei vollem Namen ' +
      '(Vor- + Nachname) NUR den Vornamen verwenden (aus „Lisa Müller" wird „Lisa").';
    nameLine = guestName
      ? `${signatureRule} Das gilt auch, wenn die Signatur vom Buchungsnamen „${guestName}" abweicht. ` +
        `Ist KEINE Signatur erkennbar, nutze stattdessen den Vornamen aus „${guestName}". ` +
        'Sprich den Gast direkt mit Vornamen an (Begrüßungs-Stil siehe Voice) — niemals mit „Liebe/Lieber Gast" o. Ä.'
      : `${signatureRule} Der Buchungsname ist nicht bekannt — ist auch keine Signatur erkennbar, ` +
        'nutze eine natürliche namenlose Begrüßung im Voice-Stil, niemals „Liebe/Lieber Gast".';
  }
  return `${nameLine}\n\nBisheriger Verlauf (chronologisch), beantworte die letzte Gastnachricht:\n${lines.join('\n')}`;
}

export async function generateDraftForThread(
  input: DraftInput,
  deps: DraftDeps = defaultDeps,
): Promise<DraftResult> {
  let out: unknown;
  try {
    out = await deps.call({
      systemPrompt: buildSystemPrompt(
        input.voice,
        input.facts,
        input.bookingContext ?? null,
        input.thread,
        input.guestLanguage ?? 'de',
        input.languageRetry ?? false,
        input.isBookingRequest ?? false,
        input.now ?? new Date(),
        input.requestKind ?? null,
        input.alteration ?? null,
      ),
      userMessage: buildConversation(input.messages, input.thread.guest_name),
      tool: SUBMIT_REPLY_TOOL,
      model: DRAFT_MODEL,
      // 512-Default reichte nicht für Antworten auf mehrteilige Gastfragen —
      // Tool-JSON wurde am Limit abgeschnitten (#379-Nachbefund, Fall Johannes).
      maxTokens: 1500,
    });
  } catch (err) {
    return { kind: 'failed', error: err instanceof Error ? err.message : String(err) };
  }

  if (!out || typeof out !== 'object') {
    return { kind: 'failed', error: 'Tool-Output fehlt oder ist kein Objekt' };
  }
  const { no_reply_needed, reply, reason } = out as { no_reply_needed?: unknown; reply?: unknown; reason?: unknown };

  if (no_reply_needed === true) {
    return { kind: 'no_reply', reason: typeof reason === 'string' && reason.trim() ? reason.trim() : '(kein Grund angegeben)' };
  }
  if (typeof reply === 'string' && reply.trim()) {
    return { kind: 'text', body: reply.trim() };
  }
  return { kind: 'failed', error: 'Tool-Output ohne no_reply_needed=true und ohne verwertbaren reply-Text' };
}
